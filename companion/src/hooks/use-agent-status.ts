/**
 * Hooks de polling contra el HTTP server local del agente.
 *
 * Diseño:
 *  - Polling automatico con intervalos configurables.
 *  - Pausa el polling cuando la ventana esta oculta (visibility API +
 *    Tauri window events). Apenas vuelve visible, dispara un refresh
 *    inmediato (no espera al siguiente tick del interval).
 *  - Estado simple via useState — no necesitamos un store global porque
 *    los datos viven con los componentes que los muestran.
 *  - Errores se exponen como `error` pero NO se "limpia" `data` mientras
 *    haya error: si el agente cayo, queremos que la UI siga mostrando el
 *    ultimo snapshot (stale) en vez de borrar todo. La UI sabe que esta
 *    desconectada por el error y puede grisar lo que necesite.
 */

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Hook generico que polea una funcion async cada `intervalMs` y maneja
 * pausa por visibility. Lo usamos dentro de useAgentStatus / useRecentJobs.
 *
 * `fetcher` debe ser estable (useCallback) o el efecto va a re-mountar
 * en cada render.
 */
function usePolling<T>(
  fetcher: () => Promise<T>,
  intervalMs: number
): {
  data: T | null;
  error: Error | null;
  isLoading: boolean;
  refresh: () => Promise<void>;
} {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  // isLoading marca solo el FIRST load. Los polls de fondo no flickean
  // el estado de loading porque la UI quiere mostrar el dato stale.
  const [isLoading, setIsLoading] = useState(true);

  // alive flag para evitar setear estado despues de unmount.
  const aliveRef = useRef(true);

  // Ref para que `refresh` siempre llame al fetcher mas reciente.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const tick = useCallback(async () => {
    try {
      const result = await fetcherRef.current();
      if (!aliveRef.current) return;
      setData(result);
      setError(null);
    } catch (err) {
      if (!aliveRef.current) return;
      // Casteamos a Error porque puede llegar cualquier cosa (TypeError
      // de fetch, strings de Tauri, etc).
      setError(err instanceof Error ? err : new Error(String(err)));
      // NO clearamos `data` — queremos mostrar el ultimo snapshot stale.
    } finally {
      if (aliveRef.current) setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    // Primer fetch inmediato. Despues el interval va corriendo.
    void tick();

    let intervalId: ReturnType<typeof setInterval> | null = null;

    const startPolling = () => {
      if (intervalId !== null) return;
      intervalId = setInterval(() => void tick(), intervalMs);
    };

    const stopPolling = () => {
      if (intervalId !== null) {
        clearInterval(intervalId);
        intervalId = null;
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        // Refresh inmediato al volver visible — no esperamos al proximo tick.
        void tick();
        startPolling();
      } else {
        stopPolling();
      }
    };

    if (document.visibilityState === "visible") {
      startPolling();
    }
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      aliveRef.current = false;
      stopPolling();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [tick, intervalMs]);

  return {
    data,
    error,
    isLoading,
    refresh: tick,
  };
}

// ----------------------------------------------------------------------
// API publica del modulo
// ----------------------------------------------------------------------

import {
  fetchRecentJobs,
  fetchStatus,
  type AgentStatus,
  type PrintJob as ApiPrintJob,
} from "@/lib/api";

const STATUS_INTERVAL_MS = 5_000;
const JOBS_INTERVAL_MS = 10_000;

/**
 * Polea `/v1/status` cada 5s y devuelve el estado actual del agente.
 *
 * Pausa cuando la ventana esta hidden. Apenas vuelve visible, fetch
 * inmediato.
 */
export function useAgentStatus() {
  const fetcher = useCallback(() => fetchStatus(), []);
  return usePolling<AgentStatus>(fetcher, STATUS_INTERVAL_MS);
}

/**
 * Polea `/v1/jobs/recent?limit=20` cada 10s. Mismo comportamiento de
 * pausa por visibility.
 *
 * Devolvemos los jobs crudos (shape del API). El componente que los
 * consume aplica el mapper a view-model.
 */
export function useRecentJobs(limit = 20) {
  const fetcher = useCallback(() => fetchRecentJobs(limit), [limit]);
  return usePolling<ApiPrintJob[]>(fetcher, JOBS_INTERVAL_MS);
}
