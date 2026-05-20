/**
 * Retry scheduler: revivir jobs que estan en waiting_printer cuyo
 * `next_retry_at` ya paso.
 *
 * Corre cada SCHEDULER_INTERVAL_MS y hace:
 *
 *   UPDATE print_jobs
 *   SET status = 'pending', next_retry_at = NULL
 *   WHERE location_id = $1
 *     AND status = 'waiting_printer'
 *     AND next_retry_at <= now()
 *   RETURNING id;
 *
 * El UPDATE...WHERE actua como lock (Postgres serializa fila-a-fila), asi
 * que si dos agentes apuntan a la misma location solo uno reanima el job.
 * El listener Realtime de cada agente recibe el UPDATE -> pending y vuelve
 * a claimear normalmente (claim CAS sigue siendo nuestro mecanismo de
 * coordinacion final).
 *
 * Notas sobre matching impresora <-> job:
 *
 *   El schema de print_jobs NO tiene un campo "target_printer_id". El
 *   matcheo job -> impresora se hace en runtime via print_area_id
 *   (ver printers/registry.ts -> pickPrinterForJob). Por eso este
 *   scheduler NO necesita saber que impresora se uso: simplemente revive
 *   los jobs cuyo retry ya toca y deja que el dispatcher resuelva la
 *   impresora del momento al claimear (cualquier cambio de configuracion
 *   o de impresora primaria se aplica al reintento).
 *
 *   El auto-recovery por impresora especifica vive en heartbeat.ts:
 *   cuando una impresora aparece nueva en el discovery, despierta
 *   inmediatamente los jobs en waiting_printer del print_area asociado.
 *
 * Hard cap:
 *
 *   Si un job lleva mas de WAITING_HARD_CAP_HOURS desde created_at, en vez
 *   de reanimarlo lo marcamos failed. Es la valvula de seguridad para que
 *   waiting_printer no quede vivo para siempre.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { AgentConfig } from './config.js';
import type { Logger } from './logger.js';
import { WAITING_HARD_CAP_HOURS } from './realtime.js';

/**
 * Intervalo entre tick y tick del scheduler.
 *
 * 15s es suficientemente fino: el backoff mas corto es 30s, asi que con 15s
 * la peor latencia es ~14.9s. No queremos polling mas agresivo porque
 * agrega carga inutil a Supabase en cada agente.
 */
const SCHEDULER_INTERVAL_MS = 15 * 1_000;

/**
 * Arranca el loop periodico. Retorna el handle de setInterval para que el
 * caller pueda hacer clearInterval en el shutdown.
 *
 * Hace un primer tick inmediato — no esperamos 15s para revivir jobs que
 * ya estaban listos al arranque del agente (importante post-restart).
 */
export function startRetryScheduler(
  supabase: SupabaseClient,
  config: AgentConfig,
  logger: Logger
): NodeJS.Timeout {
  const runOnce = async (): Promise<void> => {
    try {
      await tickOnce(supabase, config, logger);
    } catch (err) {
      // Defensive: si algo explota dentro del tick, lo logueamos pero
      // no tumbamos el setInterval. El proximo ciclo va a intentar de nuevo.
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'Retry scheduler tick fallo (seguimos andando)'
      );
    }
  };

  // Primer tick inmediato.
  void runOnce();

  const handle = setInterval(() => {
    void runOnce();
  }, SCHEDULER_INTERVAL_MS);

  logger.info(
    {
      intervalMs: SCHEDULER_INTERVAL_MS,
      hardCapHours: WAITING_HARD_CAP_HOURS
    },
    `Retry scheduler iniciado (tick cada ${SCHEDULER_INTERVAL_MS / 1000}s, hard cap ${WAITING_HARD_CAP_HOURS}h)`
  );

  return handle;
}

/**
 * Un tick del scheduler:
 *   1) Aplicar hard cap a los waiting_printer "viejos" (mas de N horas
 *      desde created_at).
 *   2) Reanimar los waiting_printer con next_retry_at <= now() (los que
 *      no excedieron el cap) cambiando status='pending'.
 *
 * Hacemos las dos cosas en este orden para no reanimar jobs que ya
 * pasaron el cap y deberian ir directo a failed.
 */
async function tickOnce(
  supabase: SupabaseClient,
  config: AgentConfig,
  logger: Logger
): Promise<void> {
  const nowIso = new Date().toISOString();
  const capDateIso = new Date(
    Date.now() - WAITING_HARD_CAP_HOURS * 60 * 60 * 1_000
  ).toISOString();

  // --------------------------------------------------------------
  // Paso 1: hard cap. Jobs mas viejos que WAITING_HARD_CAP_HOURS los
  // marcamos failed para no dejarlos vivos eternamente.
  // --------------------------------------------------------------
  const { data: capped, error: capError } = await supabase
    .from('print_jobs')
    .update({
      status: 'failed',
      last_error: `[hard cap ${WAITING_HARD_CAP_HOURS}h] waiting_printer expirado`,
      // Mantenemos error_kind='transient' para que la UI distinga "fallo
      // por hardware no recuperado" vs "fallo por config invalida".
      error_kind: 'transient',
      next_retry_at: null
    })
    .eq('location_id', config.location_id)
    .eq('status', 'waiting_printer')
    .lte('created_at', capDateIso)
    .select('id');

  if (capError) {
    logger.warn(
      { err: capError },
      'Error aplicando hard cap a waiting_printer (seguimos andando)'
    );
  } else if (capped && capped.length > 0) {
    logger.warn(
      { count: capped.length, capHours: WAITING_HARD_CAP_HOURS },
      `${capped.length} job(s) excedieron hard cap, marcados failed`
    );
  }

  // --------------------------------------------------------------
  // Paso 2: reanimar los que ya tocan reintentar.
  // --------------------------------------------------------------
  const { data: revived, error: reviveError } = await supabase
    .from('print_jobs')
    .update({
      status: 'pending',
      next_retry_at: null
    })
    .eq('location_id', config.location_id)
    .eq('status', 'waiting_printer')
    .lte('next_retry_at', nowIso)
    .select('id, attempts, print_area_id');

  if (reviveError) {
    logger.warn(
      { err: reviveError },
      'Error reanimando waiting_printer jobs (seguimos andando)'
    );
    return;
  }

  if (revived && revived.length > 0) {
    logger.info(
      {
        count: revived.length,
        jobIds: revived.map((r) => r.id)
      },
      `Retry scheduler reanimo ${revived.length} job(s) (status -> pending)`
    );
    // Nota: NO necesitamos llamar al dispatcher aca. Cuando el UPDATE
    // pasa por la replication, el listener Realtime (realtime.ts) recibe
    // el evento "UPDATE -> pending" y dispara claimAndRun. Esto vale
    // tanto si el agente que reanimo es el mismo que va a imprimir, como
    // si son agentes distintos para la misma location.
  }
}

/**
 * Helper exportado para uso desde otros modulos (ej. heartbeat) que
 * necesitan despertar jobs de un area especifica sin esperar al proximo
 * tick. Resetea a `pending` solo los jobs de la location especificada
 * que coinciden con `print_area_id` (o sin area si se pasa null).
 *
 * Lo usa el auto-recovery del heartbeat cuando una impresora aparece
 * en el discovery: en vez de hacer setInterval, despertamos sus jobs
 * inmediatamente.
 *
 * TODO(carlos): el matcheo por print_area_id puede ser muy ancho cuando
 * hay varias impresoras compartiendo el mismo area. En la practica este
 * caso es raro (cocina = 1 impresora, barra = 1 impresora). Si en el
 * futuro hay multiples printers por area, mejorar la heuristica.
 */
export async function wakeJobsForPrintArea(
  supabase: SupabaseClient,
  locationId: string,
  printAreaId: string | null,
  logger: Logger
): Promise<number> {
  let query = supabase
    .from('print_jobs')
    .update({
      status: 'pending',
      next_retry_at: null
    })
    .eq('location_id', locationId)
    .eq('status', 'waiting_printer');

  if (printAreaId === null) {
    query = query.is('print_area_id', null);
  } else {
    query = query.eq('print_area_id', printAreaId);
  }

  const { data, error } = await query.select('id');

  if (error) {
    logger.warn(
      { err: error, printAreaId },
      'Error despertando jobs por print_area (auto-recovery)'
    );
    return 0;
  }

  const count = data?.length ?? 0;
  if (count > 0) {
    logger.info(
      { count, printAreaId, jobIds: data?.map((r) => r.id) },
      `Auto-recovery: desperte ${count} job(s) para print_area=${printAreaId ?? 'default'}`
    );
  }
  return count;
}
