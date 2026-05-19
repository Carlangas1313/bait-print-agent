import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';
import type { AgentConfig } from './config.js';
import type { Logger } from './logger.js';
import type { PrintJobRow } from './types.js';

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
 */

const MAX_ATTEMPTS = 3;

export type JobHandler = (job: PrintJobRow) => Promise<void>;

export async function startRealtimeListener(
  supabase: SupabaseClient,
  config: AgentConfig,
  logger: Logger,
  onJob: JobHandler
): Promise<RealtimeChannel> {
  // ------------------------------------------------------------------
  // 1) Backfill: jobs que quedaron pending mientras el agente estaba off.
  // ------------------------------------------------------------------
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
  } else if (pendingJobs && pendingJobs.length > 0) {
    logger.info(
      { count: pendingJobs.length },
      'Backfill: procesando jobs pendientes acumulados'
    );
    for (const job of pendingJobs as PrintJobRow[]) {
      // Secuencial a proposito: queremos preservar el orden de la cola.
      await claimAndRun(supabase, logger, job, onJob);
    }
  } else {
    logger.info('Backfill: no hay jobs pendientes');
  }

  // ------------------------------------------------------------------
  // 2) Streaming via postgres_changes.
  // ------------------------------------------------------------------
  const channelName = `print-jobs-${config.location_id}`;
  const channel = supabase.channel(channelName);

  const filter = `location_id=eq.${config.location_id}`;

  channel.on(
    'postgres_changes',
    {
      event: 'INSERT',
      schema: 'public',
      table: 'print_jobs',
      filter
    },
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
    {
      event: 'UPDATE',
      schema: 'public',
      table: 'print_jobs',
      filter
    },
    (payload) => {
      const newJob = payload.new as PrintJobRow;
      const oldJob = payload.old as Partial<PrintJobRow>;

      // Caso "Reintentar": el usuario forzo el job de failed/printed a pending.
      // Tambien cubre el backoff interno que resetea attempts<3 a pending.
      if (newJob.status === 'pending' && oldJob.status !== 'pending') {
        logger.info(
          { jobId: newJob.id, jobType: newJob.job_type },
          'Evento Realtime UPDATE -> pending recibido (reintento)'
        );
        void claimAndRun(supabase, logger, newJob, onJob);
      }
    }
  );

  channel.subscribe((status, err) => {
    if (err) {
      logger.error({ err, status }, 'Error suscribiendo al canal Realtime');
      return;
    }
    logger.info(
      { status, locationId: config.location_id },
      'Realtime listener iniciado en location_id=' + config.location_id
    );
  });

  return channel;
}

/**
 * Claim atomico + ejecucion del job.
 *
 * El UPDATE...WHERE status='pending' es nuestro lock optimista. Si dos
 * agentes corren a la vez, solo uno recibe la fila en `data`; el otro
 * recibe array vacio y abandona limpiamente.
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
      attempts: job.attempts + 1
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

  try {
    await onJob(claimedJob);

    const { error: doneError } = await supabase
      .from('print_jobs')
      .update({
        status: 'printed',
        printed_at: new Date().toISOString(),
        last_error: null
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
  } catch (renderErr) {
    const errMsg =
      renderErr instanceof Error ? renderErr.message : String(renderErr);

    // Si todavia tenemos intentos por delante, dejamos el job en pending
    // con un backoff lineal (5s * intento). Si no, lo marcamos como failed.
    const shouldRetry = claimedJob.attempts < MAX_ATTEMPTS;

    if (shouldRetry) {
      const delayMs = 5_000 * claimedJob.attempts;
      logger.warn(
        {
          jobId: claimedJob.id,
          attempts: claimedJob.attempts,
          maxAttempts: MAX_ATTEMPTS,
          delayMs,
          err: errMsg
        },
        'Job fallo, reintentara despues del backoff'
      );

      // Lo dejamos en 'pending' tras el delay. Lo hacemos en dos pasos
      // (primero failed con el error, luego pending) para que el evento
      // UPDATE haga visible el error mientras tanto.
      const { error: setFailedError } = await supabase
        .from('print_jobs')
        .update({
          status: 'failed',
          last_error: errMsg
        })
        .eq('id', claimedJob.id);

      if (setFailedError) {
        logger.error(
          { err: setFailedError, jobId: claimedJob.id },
          'Error marcando job como failed (pre-reintento)'
        );
      }

      setTimeout(() => {
        void supabase
          .from('print_jobs')
          .update({ status: 'pending' })
          .eq('id', claimedJob.id)
          .then(({ error: retryError }) => {
            if (retryError) {
              logger.error(
                { err: retryError, jobId: claimedJob.id },
                'Error reseteando job a pending para reintento'
              );
            } else {
              logger.info(
                { jobId: claimedJob.id, attempts: claimedJob.attempts },
                'Job reseteado a pending tras backoff'
              );
            }
          });
      }, delayMs);
    } else {
      logger.warn(
        {
          jobId: claimedJob.id,
          attempts: claimedJob.attempts,
          err: errMsg
        },
        'Job alcanzo el max de intentos, marcando como failed'
      );

      const { error: failError } = await supabase
        .from('print_jobs')
        .update({
          status: 'failed',
          last_error: errMsg
        })
        .eq('id', claimedJob.id);

      if (failError) {
        logger.error(
          { err: failError, jobId: claimedJob.id },
          'Error marcando job como failed definitivo'
        );
      }
    }
  }
}
