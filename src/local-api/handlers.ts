/**
 * Handlers de la API local del agente (HTTP 127.0.0.1:17891).
 *
 * Esta capa no conoce node:http directamente: recibe `LocalApiContext` desde
 * el server (que ya parseo body + auth) y devuelve `HandlerResult`. El
 * server se encarga del wire format.
 *
 * Diseño:
 *  - Cada handler es async y puede tirar; el server captura y devuelve 500.
 *  - El estado "vivo" (last_heartbeat_at, last_job_at, jobs_pending_count)
 *    vive en `AgentRuntimeState`, que el main loop muta. Asi los handlers
 *    leen el snapshot mas reciente sin pollear Supabase cada request.
 *  - Para las queries que SI necesitan Supabase (jobs/recent, reprint),
 *    usamos el cliente autenticado del agente (mismas RLS que aplica a
 *    los inserts del realtime).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { AgentConfig } from '../config.js';
import type { Logger } from '../logger.js';
import type { PrintJobRow } from '../types.js';
import type { DiscoveredPrinter } from '../printers/discover.js';
import { AGENT_VERSION } from '../constants.js';

/**
 * Estado mutable que el main loop del agente actualiza y que la API local
 * expone via /v1/status.
 *
 * No es persistente — se reinicia con el agente. Pensado para reflejar el
 * estado "vivo" del proceso, no la historia (esa la consulta el endpoint
 * /v1/jobs/recent contra Supabase).
 */
export type AgentRuntimeState = {
  /** ISO timestamp del ultimo heartbeat exitoso. null si nunca corrio. */
  last_heartbeat_at: string | null;
  /** ISO timestamp del ultimo job procesado (cualquier outcome). null si none. */
  last_job_at: string | null;
  /** Status del canal Realtime ('SUBSCRIBED', 'CHANNEL_ERROR', 'CLOSED', etc). */
  realtime_status: string;
  /** Si el cliente Supabase esta autenticado y operativo. */
  supabase_connected: boolean;
  /** Ultimo snapshot de printers descubiertos en el OS (Get-Printer). */
  discovered_printers: DiscoveredPrinter[];
  /**
   * Triggers un refresh fresco de la cola (similar a lo que hace
   * startRealtimeListener al arrancar). El server local lo invoca via
   * POST /v1/service/refresh-queue.
   */
  refreshQueue: () => Promise<{ processed: number }>;
};

/**
 * Contexto que el server pasa a cada handler.
 */
export type LocalApiContext = {
  supabase: SupabaseClient;
  config: AgentConfig;
  logger: Logger;
  state: AgentRuntimeState;
  /** Path params del router (eg /:id). */
  params: Record<string, string>;
  /** Query string parseado (solo claves simples, no arrays). */
  query: Record<string, string>;
  /** Body del request ya parseado a JSON. `null` si no hubo body. */
  body: unknown;
};

/**
 * Resultado que devuelve un handler. El server lo serializa como JSON.
 */
export type HandlerResult = {
  status: number;
  body: unknown;
};

// ====================================================================
// GET /v1/status
// ====================================================================

/**
 * Devuelve el estado actual del agente.
 *
 * Mezcla informacion estatica (id, version, location_id) con dinamica
 * (jobs_pending_count, last_heartbeat_at). Los counts de jobs los
 * consultamos contra Supabase porque son volatiles y queremos un numero
 * fresco; el resto sale del runtime state.
 */
/**
 * Calcula el inicio del "dia operativo" del restaurant en formato ISO.
 *
 * Convencion del proyecto (ver memoria global): el dia operativo va desde
 * 05:00 hasta 04:59 del dia siguiente. Esto cubre los locales que cierran
 * tarde — un ticket a las 02:00 todavia cuenta como del dia anterior.
 *
 * Usamos local time del proceso (que corre en la PC del restaurant, asi que
 * la TZ del SO == TZ del local). new Date() con getHours() resuelve en
 * local time automaticamente.
 */
function businessDayStartISO(): string {
  const now = new Date();
  const start = new Date(now);
  start.setHours(5, 0, 0, 0);
  // Si todavia no llegamos a las 05:00 de HOY, el dia operativo empezo
  // ayer a las 05:00.
  if (now.getHours() < 5) {
    start.setTime(start.getTime() - 24 * 60 * 60 * 1000);
  }
  return start.toISOString();
}

export async function handleStatus(ctx: LocalApiContext): Promise<HandlerResult> {
  const { supabase, config, state, logger } = ctx;

  // Contar pending y waiting_printer para la location del agente.
  // Si la query falla, devolvemos 0 pero seguimos: el companion debe poder
  // mostrar la pantalla aunque Supabase este off.
  let jobsPending = 0;
  let jobsWaitingPrinter = 0;
  // Counters del dia operativo (05:00 -> 04:59 siguiente).
  // Devolvemos null si la query falla — asi el companion sabe que es "no
  // disponible" y muestra "—" en lugar de 0 erroneo.
  let printedToday: number | null = null;
  let failedToday: number | null = null;
  const businessStart = businessDayStartISO();

  try {
    const pendingRes = await supabase
      .from('print_jobs')
      .select('id', { count: 'exact', head: true })
      .eq('location_id', config.location_id)
      .eq('status', 'pending');

    if (pendingRes.error) {
      logger.warn(
        { err: pendingRes.error.message },
        'No pude contar jobs pending (status endpoint)'
      );
    } else {
      jobsPending = pendingRes.count ?? 0;
    }

    // `waiting_printer` ya existe en el enum (v0.5.5+): jobs en backoff
    // exponencial esperando que la impresora vuelva. Lo contamos por separado
    // porque la UI del companion quiere mostrar "X pendientes / Y esperando
    // impresora" como dos buckets distintos.
    const waitingRes = await supabase
      .from('print_jobs')
      .select('id', { count: 'exact', head: true })
      .eq('location_id', config.location_id)
      .eq('status', 'waiting_printer');

    if (waitingRes.error) {
      logger.debug(
        { err: waitingRes.error.message },
        'Count de waiting_printer fallo'
      );
    } else {
      jobsWaitingPrinter = waitingRes.count ?? 0;
    }

    // Impresos en el dia operativo (printed_at >= 05:00 today).
    const printedRes = await supabase
      .from('print_jobs')
      .select('id', { count: 'exact', head: true })
      .eq('location_id', config.location_id)
      .eq('status', 'printed')
      .gte('printed_at', businessStart);

    if (printedRes.error) {
      logger.debug(
        { err: printedRes.error.message },
        'Count de printed_today fallo'
      );
    } else {
      printedToday = printedRes.count ?? 0;
    }

    // Fallidos en el dia operativo (created_at >= 05:00 + status='failed').
    // Usamos created_at como proxy porque no hay `failed_at` en el schema.
    const failedRes = await supabase
      .from('print_jobs')
      .select('id', { count: 'exact', head: true })
      .eq('location_id', config.location_id)
      .eq('status', 'failed')
      .gte('created_at', businessStart);

    if (failedRes.error) {
      logger.debug(
        { err: failedRes.error.message },
        'Count de failed_today fallo'
      );
    } else {
      failedToday = failedRes.count ?? 0;
    }
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'Error inesperado contando jobs (devolviendo 0)'
    );
  }

  return {
    status: 200,
    body: {
      agent: {
        id: config.agent_id,
        name: config.agent_name,
        version: AGENT_VERSION,
        location_id: config.location_id,
        restaurant_id: config.restaurant_id
      },
      supabase_connected: state.supabase_connected,
      realtime_status: state.realtime_status,
      discovered_printers: state.discovered_printers,
      last_heartbeat_at: state.last_heartbeat_at,
      last_job_at: state.last_job_at,
      jobs_pending_count: jobsPending,
      jobs_waiting_printer_count: jobsWaitingPrinter,
      // Counters del dia operativo (05:00 a 04:59). null si la query fallo.
      // Frontend: si es null pinta "—", si es 0 pinta "0".
      printed_today_count: printedToday,
      failed_today_count: failedToday,
      business_day_start: businessStart
    }
  };
}

// ====================================================================
// GET /v1/jobs/recent?limit=20
// ====================================================================

const DEFAULT_RECENT_LIMIT = 20;
const MAX_RECENT_LIMIT = 100;

export async function handleJobsRecent(
  ctx: LocalApiContext
): Promise<HandlerResult> {
  const { supabase, config, query, logger } = ctx;

  // Parseamos `limit` con tope para evitar que el companion pida miles de
  // filas por error y nos haga un DoS sobre Supabase.
  const rawLimit = Number.parseInt(query.limit ?? '', 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(rawLimit, MAX_RECENT_LIMIT)
    : DEFAULT_RECENT_LIMIT;

  const { data, error } = await supabase
    .from('print_jobs')
    .select(
      'id, created_at, status, attempts, last_error, printed_at, payload, job_type, print_area_id, next_retry_at, error_kind'
    )
    .eq('location_id', config.location_id)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    logger.warn(
      { err: error.message },
      'Error cargando jobs recientes (jobs/recent)'
    );
    return {
      status: 502,
      body: { ok: false, error: 'supabase_error', detail: error.message }
    };
  }

  return {
    status: 200,
    body: {
      ok: true,
      jobs: data ?? []
    }
  };
}

// ====================================================================
// POST /v1/jobs/:id/reprint
// ====================================================================

/**
 * Resetea un job a `pending` para que el realtime listener lo procese
 * de nuevo. Usa CAS sobre los status "terminales" (failed, printed,
 * waiting_printer) para no pisar un job que esta en curso ('printing').
 */
export async function handleJobReprint(
  ctx: LocalApiContext
): Promise<HandlerResult> {
  const { supabase, config, params, logger } = ctx;
  const jobId = params.id;

  if (!jobId) {
    return {
      status: 400,
      body: { ok: false, error: 'missing_job_id' }
    };
  }

  // CAS: solo movemos a pending si el job esta en un estado "reintentable".
  // 'printing' no esta en la lista a proposito — no queremos pisar uno que
  // ya esta corriendo.
  const { data, error } = await supabase
    .from('print_jobs')
    .update({
      status: 'pending',
      // Reset de attempts a 0 para darle el budget completo de reintentos
      // (3 por default). Si el usuario aprieta "Reintentar" es porque quiere
      // un intento limpio, no sumar +1 al contador que ya esta agotado.
      attempts: 0,
      last_error: null
    })
    .eq('id', jobId)
    .eq('location_id', config.location_id)
    .in('status', ['failed', 'printed', 'waiting_printer'])
    .select('id, status, attempts')
    .maybeSingle();

  if (error) {
    logger.warn(
      { err: error.message, jobId },
      'Error en CAS de reprint'
    );
    return {
      status: 502,
      body: { ok: false, error: 'supabase_error', detail: error.message }
    };
  }

  if (!data) {
    // No matcheo: o el job no existe, o esta en `printing` / `pending`
    // (que son los estados donde NO queremos forzar el reset).
    return {
      status: 409,
      body: {
        ok: false,
        error: 'job_not_reprintable',
        detail:
          'El job no existe o esta en un estado no reintentable (probablemente printing/pending).'
      }
    };
  }

  logger.info(
    { jobId, newStatus: data.status },
    'Job reseteado a pending por solicitud del companion'
  );

  return {
    status: 200,
    body: {
      ok: true,
      new_status: data.status
    }
  };
}

// ====================================================================
// POST /v1/printers/:printerId/test
// ====================================================================

/**
 * STUB — creacion de print_job dummy de tipo "test" apuntado a la
 * impresora indicada.
 *
 * Pendiente porque requiere:
 *  1. Agregar el `job_type='test'` al enum en Supabase (migration).
 *  2. Construir un payload minimo con texto tipo "TEST PRINT bait-print-agent v0.5.4".
 *  3. Decidir si el job se inserta con `print_area_id` derivado de la
 *     printer o si se agrega un campo `forced_printer_id` al schema
 *     (mas limpio porque evita conflictos con el matching por area).
 *  4. Hacer un INSERT contra Supabase: el realtime listener del propio
 *     agente lo va a recoger via INSERT event y procesarlo normal.
 *
 * Por ahora devolvemos 501 + flag para que el companion deshabilite el
 * boton de "Probar impresora" hasta que se complete.
 */
export async function handlePrinterTest(
  ctx: LocalApiContext
): Promise<HandlerResult> {
  const { params, logger } = ctx;
  const printerId = params.printerId;

  logger.info(
    { printerId },
    'POST /printers/:id/test recibido pero no implementado (stub)'
  );

  return {
    status: 501,
    body: {
      ok: false,
      error: 'not_implemented',
      detail:
        'El endpoint de test requiere agregar job_type=test al enum de Supabase y un mecanismo de "forced_printer_id" en print_jobs. Ver TODO en src/local-api/handlers.ts.'
    }
  };
}

// ====================================================================
// POST /v1/service/refresh-queue
// ====================================================================

/**
 * Fuerza un backfill fresco de jobs en `pending` para esta location.
 * Util para que el companion ofrezca un boton "Refrescar cola" cuando el
 * realtime listener perdio eventos (red flaky, reconexion, etc).
 *
 * No tomamos lock — si el realtime ya estaba procesando un job, el CAS
 * sobre status='pending' del claimAndRun evita doble impresion.
 */
export async function handleRefreshQueue(
  ctx: LocalApiContext
): Promise<HandlerResult> {
  const { state, logger } = ctx;

  try {
    const result = await state.refreshQueue();
    logger.info(
      { processed: result.processed },
      'Refresh-queue manual disparado desde companion'
    );
    return {
      status: 200,
      body: { ok: true, processed: result.processed }
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err: msg }, 'refreshQueue manual fallo');
    return {
      status: 500,
      body: { ok: false, error: 'refresh_failed', detail: msg }
    };
  }
}

// ====================================================================
// Helper: Casting de PrintJobRow al subset que devolvemos
// ====================================================================

/**
 * Subset de columnas de print_jobs que devolvemos en /jobs/recent. Tipo
 * exportado por si el companion quiere usarlo como contrato.
 */
export type RecentJob = Pick<
  PrintJobRow,
  | 'id'
  | 'created_at'
  | 'status'
  | 'attempts'
  | 'last_error'
  | 'printed_at'
  | 'payload'
  | 'job_type'
  | 'print_area_id'
  | 'next_retry_at'
  | 'error_kind'
>;
