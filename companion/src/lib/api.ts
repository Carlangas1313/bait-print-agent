/**
 * Cliente HTTP del companion contra el servidor local del agente
 * (127.0.0.1:17891).
 *
 * Auth: Bearer token leido desde `<agent_home>/config.json` campo
 * `local_api_token`. El token se obtiene via el comando Tauri
 * `read_local_api_token` y se cachea en memoria — un solo `invoke()` por
 * ciclo de vida del proceso (o hasta que recibamos un 401, raro pero
 * posible si alguien borra/regenera el token mientras el companion corre).
 *
 * Errores que las llamadas pueden tirar:
 *  - "Servicio no esta corriendo" → fetch fail / 503 / ECONNREFUSED.
 *    UI lo trata como "Desconectado" pero sigue polleando.
 *  - "Servicio no configurado todavia..." → no hay config.json todavia.
 *  - "Funcionalidad no disponible aun" → endpoints stub (test print).
 *  - Otros → mensaje del server tal cual.
 */
import { invoke } from "@tauri-apps/api/core";

const BASE_URL = "http://127.0.0.1:17891";

// ----------------------------------------------------------------------
// Types — espejo de la shape que devuelve src/local-api/handlers.ts
// (en el repo padre). Si cambian alla, hay que sincronizar aca.
// ----------------------------------------------------------------------

export type DiscoveredPrinterKind = "usb" | "network" | "bluetooth" | "unknown";

export interface DiscoveredPrinter {
  name: string;
  kind: DiscoveredPrinterKind;
  device_id: string;
  default: boolean;
}

export interface AgentInfo {
  id: string;
  name: string;
  version: string;
  location_id: string;
  restaurant_id: string;
}

export interface AgentStatus {
  agent: AgentInfo;
  supabase_connected: boolean;
  realtime_status: string;
  discovered_printers: DiscoveredPrinter[];
  last_heartbeat_at: string | null;
  last_job_at: string | null;
  jobs_pending_count: number;
  jobs_waiting_printer_count: number;
  /**
   * Cantidad de jobs impresos exitosamente en el dia operativo del local
   * (05:00 hasta 04:59 del dia siguiente). `null` si la query del server
   * fallo — la UI lo pinta como "—" en lugar de "0".
   */
  printed_today_count: number | null;
  /**
   * Cantidad de jobs en status='failed' que se crearon en el dia operativo.
   * `null` si la query del server fallo.
   */
  failed_today_count: number | null;
  /** ISO timestamp del inicio del dia operativo actual (05:00 local). */
  business_day_start: string;
}

/**
 * Status de un job — espejo del enum `JobStatus` del agente padre.
 *
 * Mantenemos `cancelled` aunque el server local no lo expone como filtro
 * (no hay endpoint para cancelar), pero lo podemos recibir en la lista de
 * recientes porque la tabla print_jobs lo soporta.
 */
export type JobStatus =
  | "pending"
  | "printing"
  | "printed"
  | "failed"
  | "cancelled"
  | "waiting_printer";

export type JobType =
  | "kitchen_order"
  | "bar_order"
  | "bill_proforma"
  | "sii_receipt"
  | "cash_close"
  | "kitchen_cancel";

/**
 * Subset de columnas de `print_jobs` que devuelve `/v1/jobs/recent`.
 *
 * `payload` es JSONB en Supabase — su shape concreta depende del job_type.
 * No la tipamos estricto aca porque el companion solo la usa para mostrar
 * items renderizados (kitchen_order tiene `items`, bill_proforma tambien
 * pero distinto).
 */
export interface PrintJob {
  id: string;
  created_at: string;
  status: JobStatus;
  attempts: number;
  last_error: string | null;
  printed_at: string | null;
  payload: Record<string, unknown> | null;
  job_type: JobType;
  print_area_id: string | null;
  next_retry_at: string | null;
  error_kind: "transient" | "permanent" | null;
}

// ----------------------------------------------------------------------
// Token caching
// ----------------------------------------------------------------------

let cachedToken: string | null = null;

/**
 * Devuelve el token cacheado o lo pide al backend Tauri si es la primera
 * vez. Si el backend tira un error (servicio no configurado, config
 * corrupto), lo propagamos tal cual para que el caller decida si mostrar
 * un toast de "configura primero" o solo el badge desconectado.
 */
async function getToken(): Promise<string> {
  if (cachedToken) return cachedToken;
  try {
    const token = await invoke<string>("read_local_api_token");
    cachedToken = token;
    return token;
  } catch (err) {
    // El comando Tauri propaga strings ya formateadas user-friendly desde
    // el lado Rust ("Servicio no configurado todavia..." etc). Si por
    // alguna razon viene otra cosa, la stringificamos.
    const msg = typeof err === "string" ? err : String(err);
    throw new Error(msg);
  }
}

/**
 * Borra el token cacheado. Lo usamos cuando un fetch devuelve 401 — el
 * caso tipico es que el agente fue restarteado y regenero el token
 * mientras el companion estaba corriendo. La proxima invocacion va a
 * pedirle al Rust un token fresco.
 */
function invalidateToken(): void {
  cachedToken = null;
}

// ----------------------------------------------------------------------
// Errores de red — distinguimos "agente apagado" de "agente respondio mal"
// ----------------------------------------------------------------------

/**
 * Error indicando que el agente no esta corriendo (conexion rechazada,
 * timeout, etc). La UI lo trata como un estado "desconectado" — sigue
 * polleando pero muestra UI grisada.
 */
export class AgentOfflineError extends Error {
  constructor(message = "Servicio no esta corriendo") {
    super(message);
    this.name = "AgentOfflineError";
  }
}

/**
 * Error indicando que el endpoint todavia no esta implementado. Lo
 * lanzamos en testPrint() (el server devuelve 501) y la UI lo muestra
 * como un toast informativo en vez de un toast de error.
 */
export class NotImplementedError extends Error {
  constructor(message = "Funcionalidad no disponible aun") {
    super(message);
    this.name = "NotImplementedError";
  }
}

// ----------------------------------------------------------------------
// fetch wrapper con auth + retry en 401
// ----------------------------------------------------------------------

interface FetchOptions {
  method?: "GET" | "POST";
  body?: unknown;
}

/**
 * Wrapper de fetch que:
 *  1. Resuelve token (cacheado o via Tauri command).
 *  2. Setea Authorization Bearer header.
 *  3. Si recibe 401, invalida cache y retry una sola vez.
 *  4. Distingue offline (ECONNREFUSED / abort) de errores HTTP.
 *  5. Para errores no-2xx, lee el body JSON y propaga `detail` o `error`.
 */
async function callApi<T>(
  path: string,
  options: FetchOptions = {}
): Promise<T> {
  const method = options.method ?? "GET";

  // El timeout duro evita que la UI quede esperando indefinidamente si el
  // server quedo "colgado" pero accepting connections (raro pero posible).
  // 5s es generoso: el server local responde en <50ms para todos los
  // endpoints normales.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);

  try {
    const token = await getToken();

    const doFetch = async (authToken: string): Promise<Response> => {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${authToken}`,
      };
      if (options.body !== undefined && method === "POST") {
        headers["Content-Type"] = "application/json";
      }
      return fetch(`${BASE_URL}${path}`, {
        method,
        headers,
        body:
          options.body !== undefined && method === "POST"
            ? JSON.stringify(options.body)
            : undefined,
        signal: controller.signal,
      });
    };

    let res: Response;
    try {
      res = await doFetch(token);
    } catch (err) {
      // fetch falla con TypeError "Failed to fetch" si el server no esta
      // corriendo (ECONNREFUSED). Tambien si abortamos por timeout.
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new AgentOfflineError("Timeout — el servicio no respondio");
      }
      throw new AgentOfflineError();
    }

    // Retry una sola vez si el token cacheado quedo stale (el agente
    // regenero el token mientras el companion corria).
    if (res.status === 401) {
      invalidateToken();
      const freshToken = await getToken();
      try {
        res = await doFetch(freshToken);
      } catch {
        throw new AgentOfflineError();
      }
      if (res.status === 401) {
        // Si despues del retry sigue 401, hay algo mas profundo
        // (config.json no matchea con el token del proceso). Propagamos.
        throw new Error("Token invalido — revisa la config del agente");
      }
    }

    // 501 → endpoint stub (test print). Le damos su clase propia para que
    // la UI lo trate como informativo, no como un error rojo.
    if (res.status === 501) {
      throw new NotImplementedError();
    }

    if (!res.ok) {
      // El server devuelve `{ ok: false, error: '<slug>', detail?: string }`.
      // Si el parseo falla, fallback al statusText.
      let serverMsg = res.statusText || `HTTP ${res.status}`;
      try {
        const body = (await res.json()) as {
          error?: string;
          detail?: string;
        };
        if (body && (body.detail || body.error)) {
          serverMsg = body.detail ?? body.error ?? serverMsg;
        }
      } catch {
        // body no era JSON — usamos statusText.
      }
      throw new Error(serverMsg);
    }

    // Algunos endpoints (refresh-queue) responden con un wrapper
    // `{ ok: true, processed: N }`, otros responden el data crudo.
    // Devolvemos el JSON tal cual y dejamos que cada caller extraiga lo
    // que necesita.
    return (await res.json()) as T;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ----------------------------------------------------------------------
// API publica
// ----------------------------------------------------------------------

export async function fetchStatus(): Promise<AgentStatus> {
  return callApi<AgentStatus>("/v1/status");
}

export async function fetchRecentJobs(limit: number = 20): Promise<PrintJob[]> {
  const body = await callApi<{ ok: boolean; jobs: PrintJob[] }>(
    `/v1/jobs/recent?limit=${encodeURIComponent(limit.toString())}`
  );
  return body.jobs ?? [];
}

export async function reprintJob(jobId: string): Promise<void> {
  // El server devuelve `{ ok, new_status }` pero el caller solo necesita
  // saber si tiro o no — descartamos la respuesta.
  await callApi<{ ok: boolean; new_status: string }>(
    `/v1/jobs/${encodeURIComponent(jobId)}/reprint`,
    { method: "POST", body: {} }
  );
}

export async function refreshQueue(): Promise<{ processed: number }> {
  const body = await callApi<{ ok: boolean; processed: number }>(
    "/v1/service/refresh-queue",
    { method: "POST", body: {} }
  );
  return { processed: body.processed ?? 0 };
}

export interface TestPrintResult {
  ok: true;
  printer_name: string;
  connection_type: string;
  device_id: string;
}

/**
 * Manda una pagina de prueba a la impresora identificada por su `device_id`
 * del OS (eg "USB001", "192.168.1.50:9100", "COM7"). El server llama directo
 * al renderer ESC/POS — no pasa por la cola print_jobs, no aparece en el
 * historial, no requiere configuracion previa de la printer en bait-app.cl.
 *
 * Errores:
 *  - 404 → printer no aparece en el discovery actual (refresh + reintentar).
 *  - 502 → el render fallo (printer offline, sin papel, etc). `detail` con
 *          mensaje user-friendly desde el agente.
 *  - Otros HTTP errors → ver `callApi`.
 */
export async function testPrint(printerId: string): Promise<TestPrintResult> {
  const body = await callApi<TestPrintResult>(
    `/v1/printers/${encodeURIComponent(printerId)}/test`,
    { method: "POST", body: {} }
  );
  return body;
}
