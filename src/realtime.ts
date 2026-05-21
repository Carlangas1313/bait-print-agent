import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';
import type { AgentConfig } from './config.js';
import type { Logger } from './logger.js';
import type { PrintJobRow } from './types.js';
import type { DispatchResult } from './renderer/dispatcher.js';

/**
 * Listener de Supabase Realtime para la cola `print_jobs`.
 *
 * Responsable de dos cosas:
 *  1. Backfill al arrancar: tomar todo lo que quedo en `pending` para esta
 *     location mientras el agente estaba offline.
 *  2. Streaming: escuchar INSERT/UPDATE en tiempo real y procesar cada job.
 *
 * El claim usa un UPDATE condicional (CAS) sobre `status='pending'`, asi
 * dos agentes corriendo en paralelo no pueden imprimir el mismo job dos veces:
 * solo el primer UPDATE matchea, el segundo recibe data vacia y hace skip.
 *
 * ------------------------------------------------------------------------
 * Retry inteligente (v0.5.5+)
 *
 * Antes haciamos retry con 3 intentos y backoff lineal de 5s, 10s, todo en
 * memoria via setTimeout. Si el agente reiniciaba o la impresora seguia
 * offline despues de ~30s, el job quedaba 'failed' para siempre.
 *
 * Ahora:
 *  - El handler retorna un DispatchResult clasificado en transient/permanent.
 *  - Errores transient: backoff exponencial (30s, 2m, 10m, 1h) persistido en
 *    DB via `next_retry_at`. Status pasa a 'waiting_printer'. El servicio
 *    `retry-scheduler.ts` (otro modulo) corre cada 15s y resetea a pending
 *    los jobs cuyo next_retry_at ya paso. Sobrevive a restarts.
 *  - Errores permanent: status='failed' inmediato con error_kind='permanent'.
 *    No se reintenta. La UI los pinta rojo y muestra "Reintentar" manual.
 *  - Despues del 4to intento (es decir, attempts >= 4) NO marcamos failed:
 *    el job sigue en 'waiting_printer' indefinido. El auto-recovery del
 *    heartbeat (cuando la impresora vuelve online) lo va a despertar. Si
 *    nadie lo despierta en 24h, el scheduler lo marca failed por hard cap.
 * ------------------------------------------------------------------------
 */

/**
 * Delays del backoff exponencial, en milisegundos. La posicion es el numero
 * de intento ya hecho (claimedJob.attempts), no el numero de retries.
 *
 *   attempts=1 (1er intento fallo) -> 30s
 *   attempts=2 (2do intento fallo) -> 2 min
 *   attempts=3 (3er intento fallo) -> 10 min
 *   attempts=4 (4to intento fallo) -> 1 h
 *   attempts>=5 -> sigue en 1h pero ya entramos en "espera larga".
 *     Aca dependemos del auto-recovery del heartbeat o reintento manual.
 *
 * Total tras 4 reintentos: 30s + 120s + 600s + 3600s = 72.5 min. Despues
 * de eso seguimos reintentando cada 1h indefinidamente hasta el HARD CAP
 * de 24h, momento en el cual marcamos failed para que el job no quede
 * vivo para siempre llenando logs.
 */
const RETRY_DELAYS_MS: ReadonlyArray<number> = [
  30 * 1_000, // 30s tras el 1er intento
  2 * 60 * 1_000, // 2 min tras el 2do
  10 * 60 * 1_000, // 10 min tras el 3ro
  60 * 60 * 1_000 // 1 h tras el 4to y posteriores
];

/**
 * Hard cap: si pasaron mas de N horas desde created_at del job y la
 * impresora sigue sin imprimir, lo damos por perdido y lo marcamos failed
 * para no acumular waiting_printer "eternos".
 *
 * El retry-scheduler tambien chequea este cap al reanimar jobs.
 */
export const WAITING_HARD_CAP_HOURS = 24;

/**
 * Devuelve el delay (en ms) que corresponde aplicar despues de un intento
 * fallido `attempts` (ya incrementado por el claim CAS). Si attempts excede
 * la tabla, devolvemos el ultimo bucket (1h) — seguimos reintentando
 * indefinidamente hasta el hard cap.
 */
function pickBackoffDelay(attempts: number): number {
  // attempts viene >= 1 porque el claim CAS hace attempts+1. Indexamos
  // a partir de 0 restando 1.
  const idx = Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1);
  const fallback = RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1] ?? 60 * 60 * 1_000;
  const delay = RETRY_DELAYS_MS[idx];
  return delay ?? fallback;
}

/**
 * Handler que el caller provee. Recibe el job claimeado y retorna el
 * resultado del dispatch (ok | error con kind clasificado).
 */
export type JobHandler = (job: PrintJobRow) => Promise<DispatchResult>;

/**
 * Backfill manual: toma todos los jobs `pending` de la location y los procesa
 * secuencialmente. Se exporta para que la API local (POST
 * /v1/service/refresh-queue) pueda gatillarlo desde el tray companion.
 *
 * No agarra `waiting_printer` — esos los maneja el retry-scheduler. Aca
 * priorizamos jobs que estan listos para ejecutar ya.
 *
 * El claimAndRun usa CAS sobre `status='pending'`, asi no hay riesgo de
 * doble impresion aunque corra concurrente con el listener Realtime.
 *
 * Retorna cuantos jobs intentamos procesar (no necesariamente cuantos
 * imprimieron OK — el outcome de cada uno depende del retry path).
 */
export async function backfillPendingJobs(
  supabase: SupabaseClient,
  config: AgentConfig,
  logger: Logger,
  onJob: JobHandler
): Promise<{ processed: number }> {
  const { data: pendingJobs, error: backfillError } = await supabase
    .from('print_jobs')
    .select('*')
    .eq('status', 'pending')
    .eq('location_id', config.location_id)
    .order('created_at', { ascending: true });

  if (backfillError) {
    logger.error(
      { err: backfillError },
      'Error haciendo backfill de jobs pendientes'
    );
    return { processed: 0 };
  }

  if (!pendingJobs || pendingJobs.length === 0) {
    logger.info('Backfill: no hay jobs pendientes');
    return { processed: 0 };
  }

  logger.info(
    { count: pendingJobs.length },
    'Backfill: procesando jobs pendientes acumulados'
  );
  for (const job of pendingJobs as PrintJobRow[]) {
    // Secuencial a proposito: queremos preservar el orden de la cola.
    await claimAndRun(supabase, logger, job, onJob);
  }

  return { processed: pendingJobs.length };
}

/**
 * Delays del backoff de reconexion del canal Realtime, en milisegundos.
 * El indice es el numero de fallo consecutivo (1-based). Despues de 5 fallos
 * seguidos saturamos en 5 min — el agente sigue intentando indefinido pero
 * no satura logs ni anchos de banda.
 *
 * Si el server vuelve, una sola SUBSCRIBED exitosa resetea el contador.
 */
const REALTIME_RECONNECT_DELAYS_MS = [
  2_000,    // 1er fallo:  2s
  5_000,    // 2do fallo:  5s
  15_000,   // 3er fallo:  15s
  60_000,   // 4to fallo:  1 min
  300_000   // 5to+ fallo: 5 min (cap)
];

/**
 * Wrapper que expone al caller solo lo que necesita (unsubscribe en shutdown)
 * sin atarlo al `RealtimeChannel` concreto. Por dentro, el canal se reemplaza
 * cada vez que cae y reconectamos — sin que el caller tenga que enterarse.
 */
export type RealtimeHandle = {
  unsubscribe: () => Promise<void>;
};

export async function startRealtimeListener(
  supabase: SupabaseClient,
  config: AgentConfig,
  logger: Logger,
  onJob: JobHandler,
  /**
   * Callback opcional para que el caller observe cambios de status del canal
   * Realtime ('SUBSCRIBED', 'CHANNEL_ERROR', 'CLOSED', 'TIMED_OUT', etc).
   * Usado por la API local para reportar `realtime_status` en /v1/status.
   *
   * Status sinteticos que NO vienen de supabase-js pero que reportamos
   * igual para visibilidad:
   *   - 'RECONNECTING' mientras esperamos el backoff antes de re-subscribir.
   */
  onStatusChange?: (status: string) => void
): Promise<RealtimeHandle> {
  // ------------------------------------------------------------------
  // 1) Backfill: jobs que quedaron pending mientras el agente estaba off.
  // ------------------------------------------------------------------
  await backfillPendingJobs(supabase, config, logger, onJob);

  // ------------------------------------------------------------------
  // 2) Streaming via postgres_changes con auto-reconnect.
  // ------------------------------------------------------------------
  const channelName = `print-jobs-${config.location_id}`;
  const filter = `location_id=eq.${config.location_id}`;

  // Estado mutable de la sesion de Realtime. `currentChannel` apunta al canal
  // activo, que puede cambiar tras una reconexion. `consecutiveFailures` lleva
  // la cuenta para el backoff. `disposed` corta el loop cuando el caller
  // hace unsubscribe en el shutdown.
  let currentChannel: RealtimeChannel | null = null;
  let consecutiveFailures = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const safeStatusChange = (status: string) => {
    if (!onStatusChange) return;
    try {
      onStatusChange(status);
    } catch (cbErr) {
      logger.warn(
        { err: cbErr instanceof Error ? cbErr.message : String(cbErr) },
        'onStatusChange callback tiro (lo ignoramos)'
      );
    }
  };

  const setupChannel = () => {
    if (disposed) return;

    const channel = supabase.channel(channelName);
    currentChannel = channel;

    channel.on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'print_jobs', filter },
      (payload) => {
        const job = payload.new as PrintJobRow;
        logger.info(
          { jobId: job.id, jobType: job.job_type },
          'Evento Realtime INSERT recibido'
        );
        if (job.status === 'pending') {
          // No await — el handler de Realtime debe retornar rapido.
          void claimAndRun(supabase, logger, job, onJob);
        }
      }
    );

    channel.on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'print_jobs', filter },
      (payload) => {
        const newJob = payload.new as PrintJobRow;
        const oldJob = payload.old as Partial<PrintJobRow>;

        // Caso "Reintentar": el usuario forzo el job de failed/printed a pending,
        // o el retry-scheduler resucito un waiting_printer pasandolo a pending,
        // o el auto-recovery del heartbeat lo desperto.
        if (newJob.status === 'pending' && oldJob.status !== 'pending') {
          logger.info(
            {
              jobId: newJob.id,
              jobType: newJob.job_type,
              previousStatus: oldJob.status
            },
            'Evento Realtime UPDATE -> pending recibido (reintento)'
          );
          void claimAndRun(supabase, logger, newJob, onJob);
        }
      }
    );

    channel.subscribe((status, err) => {
      // Reportamos al observer (API local) en cada cambio, incluido el caso
      // de error. Asi el companion ve "CHANNEL_ERROR" o "CLOSED" en tiempo
      // real en /v1/status sin tener que adivinar.
      safeStatusChange(status);

      if (err || status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        // Pre-fix (<= v0.7.2): aca solo logueabamos y returnabamos, dejando el
        // canal muerto sin reintentar. El agente quedaba escuchando "en silencio"
        // y los jobs nuevos solo llegaban via backfill manual desde el companion.
        // Diagnosticado 2026-05-21 cuando el listener cayo con "socket closed:
        // 1006" y nunca volvio.
        if (disposed) return;
        consecutiveFailures += 1;
        const delayMs =
          REALTIME_RECONNECT_DELAYS_MS[
            Math.min(consecutiveFailures - 1, REALTIME_RECONNECT_DELAYS_MS.length - 1)
          ];
        logger.error(
          {
            err: err ?? null,
            status,
            consecutiveFailures,
            reconnectInMs: delayMs
          },
          'Canal Realtime cayo — reconectando con backoff'
        );

        // Limpiar el canal muerto y agendar reconexion. Importante:
        // unsubscribe es async — no esperamos, pero capturamos errores
        // para no dejar promesas colgadas.
        const dead = channel;
        Promise.resolve(dead.unsubscribe()).catch((unsubErr) => {
          logger.warn(
            { err: unsubErr instanceof Error ? unsubErr.message : String(unsubErr) },
            'unsubscribe del canal muerto fallo (lo ignoramos)'
          );
        });
        if (currentChannel === dead) {
          currentChannel = null;
        }

        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          safeStatusChange('RECONNECTING');
          setupChannel();
        }, delayMs);
        return;
      }

      if (status === 'SUBSCRIBED') {
        // Reset del contador apenas conectamos OK. Asi la proxima caida
        // arranca con 2s, no con 5min, dando reconexion rapida en cortes
        // breves de red.
        consecutiveFailures = 0;
      }

      logger.info(
        { status, locationId: config.location_id },
        'Realtime listener iniciado en location_id=' + config.location_id
      );
    });
  };

  setupChannel();

  return {
    unsubscribe: async () => {
      disposed = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (currentChannel) {
        try {
          await currentChannel.unsubscribe();
        } catch (err) {
          logger.warn(
            { err: err instanceof Error ? err.message : String(err) },
            'unsubscribe en shutdown fallo (lo ignoramos)'
          );
        }
        currentChannel = null;
      }
    }
  };
}

/**
 * Claim atomico + ejecucion del job.
 *
 * El UPDATE...WHERE status='pending' es nuestro lock optimista. Si dos
 * agentes corren a la vez, solo uno recibe la fila en `data`; el otro
 * recibe array vacio y abandona limpiamente.
 *
 * Tras ejecutar:
 *  - exito  -> status='printed', limpia last_error/next_retry_at/error_kind.
 *  - transient -> status='waiting_printer', next_retry_at = now() + delay,
 *                 error_kind='transient', last_error con el mensaje.
 *  - permanent -> status='failed', error_kind='permanent', last_error con
 *                 el mensaje, sin programar reintento.
 *  - hard cap excedido -> status='failed' con mensaje explicito.
 */
async function claimAndRun(
  supabase: SupabaseClient,
  logger: Logger,
  job: PrintJobRow,
  onJob: JobHandler
): Promise<void> {
  const { data: claimed, error: claimError } = await supabase
    .from('print_jobs')
    .update({
      status: 'printing',
      attempts: job.attempts + 1,
      // Limpiamos el next_retry_at al claimear: el job esta activo de nuevo.
      next_retry_at: null
    })
    .eq('id', job.id)
    .eq('status', 'pending')
    .select()
    .maybeSingle();

  if (claimError) {
    logger.error(
      { err: claimError, jobId: job.id },
      'Error intentando hacer claim del job'
    );
    return;
  }

  if (!claimed) {
    logger.debug(
      { jobId: job.id },
      'Job skipped, ya fue claimeado por otro agente'
    );
    return;
  }

  const claimedJob = claimed as PrintJobRow;
  logger.debug(
    { jobId: claimedJob.id, attempts: claimedJob.attempts },
    'Claim CAS exitoso, procesando job'
  );

  const result = await onJob(claimedJob);

  if (result.ok) {
    const { error: doneError } = await supabase
      .from('print_jobs')
      .update({
        status: 'printed',
        printed_at: new Date().toISOString(),
        last_error: null,
        error_kind: null,
        next_retry_at: null
      })
      .eq('id', claimedJob.id);

    if (doneError) {
      logger.error(
        { err: doneError, jobId: claimedJob.id },
        'Error marcando job como printed (pero el render salio OK)'
      );
      return;
    }

    logger.info(
      { jobId: claimedJob.id, jobType: claimedJob.job_type },
      'Job impreso correctamente'
    );
    return;
  }

  // Camino de error. Decidimos en base al kind devuelto por el dispatcher.
  const { kind, message } = result.error;

  if (kind === 'permanent') {
    logger.error(
      {
        jobId: claimedJob.id,
        attempts: claimedJob.attempts,
        err: message
      },
      'Job fallo con error permanent, marcando failed sin reintento'
    );

    const { error: failError } = await supabase
      .from('print_jobs')
      .update({
        status: 'failed',
        last_error: message,
        error_kind: 'permanent',
        next_retry_at: null
      })
      .eq('id', claimedJob.id);

    if (failError) {
      logger.error(
        { err: failError, jobId: claimedJob.id },
        'Error marcando job como failed (permanent)'
      );
    }
    return;
  }

  // kind === 'transient'. Aplicamos backoff exponencial persistido en DB.

  // Hard cap: si el job lleva mas de WAITING_HARD_CAP_HOURS desde su
  // created_at, lo damos por perdido. Esto evita acumular waiting_printer
  // eternos cuando una impresora se queda offline para siempre (ej. el
  // cliente la cambio sin actualizar la config).
  const createdAtMs = new Date(claimedJob.created_at).getTime();
  const ageHours = (Date.now() - createdAtMs) / (60 * 60 * 1_000);

  if (ageHours >= WAITING_HARD_CAP_HOURS) {
    logger.warn(
      {
        jobId: claimedJob.id,
        attempts: claimedJob.attempts,
        ageHours: Math.round(ageHours * 10) / 10,
        err: message
      },
      `Job supero el hard cap de ${WAITING_HARD_CAP_HOURS}h, marcando failed`
    );

    const { error: capError } = await supabase
      .from('print_jobs')
      .update({
        status: 'failed',
        last_error: `[hard cap ${WAITING_HARD_CAP_HOURS}h] ${message}`,
        error_kind: 'transient',
        next_retry_at: null
      })
      .eq('id', claimedJob.id);

    if (capError) {
      logger.error(
        { err: capError, jobId: claimedJob.id },
        'Error marcando job como failed por hard cap'
      );
    }
    return;
  }

  // Programar siguiente reintento via DB.
  const delayMs = pickBackoffDelay(claimedJob.attempts);
  const nextRetryAt = new Date(Date.now() + delayMs).toISOString();

  logger.warn(
    {
      jobId: claimedJob.id,
      attempts: claimedJob.attempts,
      delayMs,
      nextRetryAt,
      err: message
    },
    'Job fallo (transient), entra en waiting_printer con backoff exponencial'
  );

  const { error: waitError } = await supabase
    .from('print_jobs')
    .update({
      status: 'waiting_printer',
      last_error: message,
      error_kind: 'transient',
      next_retry_at: nextRetryAt
    })
    .eq('id', claimedJob.id);

  if (waitError) {
    logger.error(
      { err: waitError, jobId: claimedJob.id },
      'Error programando waiting_printer en DB'
    );
  }
}
