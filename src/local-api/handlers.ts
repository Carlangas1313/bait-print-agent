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
import { renderTestPage } from '../renderer/usb.js';

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
 * Imprime una pagina de prueba en la impresora indicada por su `device_id`
 * del descubrimiento del OS (Get-Printer en Windows). Bypassea la cola
 * print_jobs entera — el handler llama directo al renderer ESC/POS con un
 * payload sintetico de test. Asi:
 *   - No requiere que la impresora este configurada en bait-app.cl.
 *   - No mete ruido en print_jobs (no aparece en el historial de comandas).
 *   - Verifica conectividad real al mismo socket / device que usaria un job
 *     productivo (mismo node-thermal-printer, mismo buildInterfaceUri).
 *
 * Errores:
 *   - 404 si el `printerId` no esta en el ultimo snapshot de discovered_printers
 *     (el companion deberia ofrecer solo opciones validas en su dropdown).
 *   - 502 si el render falla (printer offline, sin papel, driver no
 *     disponible, etc) — el `detail` trae el mensaje del renderer.
 *
 * El printerId que recibe es `device_id` del DiscoveredPrinter (USB001,
 * ip:puerto, COM7). Esta URL-encoded en el path porque puede tener `:` y `\`.
 */
export async function handlePrinterTest(
  ctx: LocalApiContext
): Promise<HandlerResult> {
  const { params, state, config, logger } = ctx;
  const rawPrinterId = params.printerId;

  if (!rawPrinterId) {
    return {
      status: 400,
      body: { ok: false, error: 'missing_printer_id' }
    };
  }

  // El path param viene URL-encoded; decodificamos para matchear contra
  // `device_id` que puede tener `:`, `\\`, etc.
  let printerId: string;
  try {
    printerId = decodeURIComponent(rawPrinterId);
  } catch {
    return {
      status: 400,
      body: { ok: false, error: 'invalid_printer_id_encoding' }
    };
  }

  // Match contra el snapshot del heartbeat. Si la impresora desaparecio
  // entre el ultimo discovery y el click del user, devolvemos 404 con un
  // hint para refrescar.
  const discovered = state.discovered_printers.find(
    (p) => p.device_id === printerId
  );

  if (!discovered) {
    logger.info(
      {
        printerId,
        availableIds: state.discovered_printers.map((p) => p.device_id)
      },
      'Test print solicitado para una printer no presente en discovery snapshot'
    );
    return {
      status: 404,
      body: {
        ok: false,
        error: 'printer_not_found',
        detail:
          'La impresora ya no aparece en el snapshot del agente. Refrescar la lista o verificar que sigue conectada.'
      }
    };
  }

  try {
    await renderTestPage(
      discovered,
      config.agent_name,
      null, // location_name no esta en config — para v0.6.x lo omitimos
      logger
    );
    return {
      status: 200,
      body: {
        ok: true,
        printer_name: discovered.name,
        connection_type: discovered.kind,
        device_id: discovered.device_id
      }
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(
      { printerId, err: msg },
      'Test print fallo en el renderer'
    );
    return {
      status: 502,
      body: {
        ok: false,
        error: 'render_failed',
        detail: msg
      }
    };
  }
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
