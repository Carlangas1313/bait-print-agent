import { networkInterfaces } from 'node:os';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AgentConfig } from './config.js';
import type { Logger } from './logger.js';
import { AGENT_VERSION } from './constants.js';
import { discoverPrinters, type DiscoveredPrinter } from './printers/discover.js';
import { loadPrintersForLocation } from './printers/registry.js';
import { wakeJobsForPrintArea } from './retry-scheduler.js';

/**
 * Heartbeat periodico contra la tabla `print_agents`.
 *
 * Actualiza `last_seen_at` + version + IP local cada N segundos para que
 * el dashboard pueda mostrar quien esta vivo. Si un UPDATE falla (red
 * caida, Supabase rate-limited, etc.) lo logueamos pero NO abortamos —
 * el agente debe seguir imprimiendo aunque pierda el heartbeat un rato.
 *
 * Auto-discovery: cada N heartbeats refrescamos el snapshot de impresoras
 * del SO y lo publicamos en `print_agents.discovered_printers` para que la
 * UI de bait-pos pueda armar el dropdown "elegi tu printer" sin que el
 * cliente tenga que pegar UNC paths o IPs a mano.
 *
 * Auto-recovery (v0.5.5+): trackeamos el set de impresoras detectadas entre
 * ciclos consecutivos. Cuando una impresora aparece en este ciclo y no
 * estaba en el anterior, asumimos que volvio online (alguien le puso papel,
 * la reenchufaron, etc.) y despertamos los jobs en `waiting_printer` que
 * apuntan al print_area asociado a esa impresora, asi se imprimen al toque
 * sin esperar al proximo tick del retry-scheduler.
 */

/**
 * Cada cuantos heartbeats refrescamos el discovery de printers Windows.
 * Discovery es costoso (spawnea un PowerShell), por eso no lo hacemos
 * en CADA heartbeat. Con heartbeat default de 30s y este valor en 5,
 * el snapshot se refresca cada ~2.5 min — suficiente para que cuando
 * el cliente enchufa una USB nueva, aparezca en la UI en pocos minutos.
 */
const DISCOVERY_EVERY_N_HEARTBEATS = 5;

/**
 * Estado mutable entre ciclos. Lo encapsulamos en una closure para que
 * el setInterval comparta el snapshot anterior sin pasarlo por argumentos.
 */
type HeartbeatState = {
  /**
   * Set de claves "kind:device_id" de la ultima detection. Lo usamos para
   * detectar transiciones "no estaba -> esta" entre ciclos consecutivos.
   * null = todavia no corrimos discovery ni una vez (no podemos decir si
   * algo cambio porque no tenemos baseline).
   */
  previousPrinterKeys: Set<string> | null;
};

/**
 * Computa la clave canonica de una impresora descubierta para comparar
 * sets entre ciclos. Usamos "kind:device_id" porque el `name` puede
 * cambiar (renombre de Windows) sin que cambie el hardware, y device_id
 * solo no alcanza para distinguir USB001 (USB) de COM7 (BT).
 */
function printerKey(p: DiscoveredPrinter): string {
  return `${p.kind}:${p.device_id}`;
}

/**
 * Callbacks opcionales para observar el ciclo del heartbeat. Usados por la
 * API local (/v1/status) para reflejar el ultimo heartbeat y el snapshot
 * de printers sin tener que pollear Supabase en cada request.
 */
export type HeartbeatObservers = {
  /** Heartbeat OK contra Supabase. `at` = ISO timestamp. */
  onSuccess?: (info: { at: string }) => void;
  /** Heartbeat fallo (no abortamos, solo notificamos). */
  onFailure?: (err: unknown) => void;
  /** Discovery refresco la lista de impresoras del SO. */
  onDiscovery?: (printers: DiscoveredPrinter[]) => void;
};

export function startHeartbeat(
  supabase: SupabaseClient,
  config: AgentConfig,
  logger: Logger,
  observers?: HeartbeatObservers
): NodeJS.Timeout {
  const intervalMs = config.heartbeat_interval_seconds * 1_000;

  // Contador local: cuantos heartbeats hicimos. Decide cuando refrescar el
  // discovery de printers. Empezamos en 0 → el primer heartbeat tambien
  // dispara discovery (asi la UI tiene datos apenas el agente conecta).
  let heartbeatCount = 0;

  const state: HeartbeatState = {
    previousPrinterKeys: null
  };

  const runOnce = async (): Promise<void> => {
    const includeDiscovery = heartbeatCount % DISCOVERY_EVERY_N_HEARTBEATS === 0;
    heartbeatCount += 1;
    await sendHeartbeat(
      supabase,
      config,
      logger,
      includeDiscovery,
      state,
      observers
    );
  };

  // Primer ping inmediato — no esperamos el primer intervalo para
  // marcar el agente como vivo.
  void runOnce();

  const handle = setInterval(() => {
    void runOnce();
  }, intervalMs);

  logger.info(
    {
      intervalSeconds: config.heartbeat_interval_seconds,
      discoveryEveryN: DISCOVERY_EVERY_N_HEARTBEATS
    },
    `Heartbeat iniciado (discovery cada ${DISCOVERY_EVERY_N_HEARTBEATS} ciclos)`
  );

  return handle;
}

async function sendHeartbeat(
  supabase: SupabaseClient,
  config: AgentConfig,
  logger: Logger,
  includeDiscovery: boolean,
  state: HeartbeatState,
  observers?: HeartbeatObservers
): Promise<void> {
  const ip = getLocalIp();

  // Tipo abierto porque agregamos discovered_printers solo cuando toca
  // ese ciclo. Si no, no incluimos el campo y la columna queda con el
  // ultimo snapshot.
  const update: {
    last_seen_at: string;
    agent_version: string;
    last_seen_ip: string | null;
    discovered_printers?: DiscoveredPrinter[];
  } = {
    last_seen_at: new Date().toISOString(),
    agent_version: AGENT_VERSION,
    last_seen_ip: ip
  };

  let printersForRecovery: DiscoveredPrinter[] | null = null;

  if (includeDiscovery) {
    try {
      const printers = await discoverPrinters(logger);
      // Siempre escribimos — incluso si es [] — para indicar que el discovery
      // corrio. Asi la UI puede distinguir "el agente no detecto nada" vs
      // "el agente nunca corrio discovery todavia" (null en DB).
      update.discovered_printers = printers;
      printersForRecovery = printers;
      // Notificar al observer (API local) con el snapshot fresco para que
      // /v1/status lo refleje sin tener que ir a Supabase.
      try {
        observers?.onDiscovery?.(printers);
      } catch (cbErr) {
        logger.warn(
          { err: cbErr instanceof Error ? cbErr.message : String(cbErr) },
          'observers.onDiscovery tiro (ignorado)'
        );
      }
    } catch (err) {
      // discoverPrinters ya maneja sus errores internos, pero por las dudas
      // envolvemos en try/catch para garantizar que el heartbeat no caiga
      // si algo explota en el discovery.
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'Discovery threw, salteamos snapshot este ciclo'
      );
    }
  }

  const { error } = await supabase
    .from('print_agents')
    .update(update)
    .eq('id', config.agent_id);

  if (error) {
    logger.warn(
      { err: error, agentId: config.agent_id },
      'Heartbeat fallo (seguimos andando)'
    );
    try {
      observers?.onFailure?.(error);
    } catch (cbErr) {
      logger.warn(
        { err: cbErr instanceof Error ? cbErr.message : String(cbErr) },
        'observers.onFailure tiro (ignorado)'
      );
    }
    // No return: aunque el heartbeat fallo, el discovery puede ser valido
    // y queremos correr el auto-recovery igual.
  } else {
    logger.debug(
      { ip, discoveryIncluded: includeDiscovery },
      'Heartbeat enviado'
    );
    try {
      observers?.onSuccess?.({ at: update.last_seen_at });
    } catch (cbErr) {
      logger.warn(
        { err: cbErr instanceof Error ? cbErr.message : String(cbErr) },
        'observers.onSuccess tiro (ignorado)'
      );
    }
  }

  // --------------------------------------------------------------
  // Auto-recovery: comparar el set actual con el del ciclo anterior.
  // Si aparecio alguna impresora nueva, despertar sus jobs en
  // waiting_printer.
  // --------------------------------------------------------------
  if (printersForRecovery !== null) {
    await runAutoRecovery(supabase, config, logger, state, printersForRecovery);
  }
}

/**
 * Detecta transiciones "no estaba -> esta" en el set de impresoras y
 * dispara wakeJobsForPrintArea() para cada impresora nueva.
 *
 * Estrategia de matcheo:
 *   1) Cargamos las impresoras configuradas de la location (tabla `printers`).
 *   2) Para cada impresora descubierta nueva, intentamos matchearla con
 *      una configurada en bait-app.cl. El matcheo usa una heuristica laxa:
 *        - mismo kind/connection_type
 *        - device_id de la descubierta incluido en el target de la
 *          configurada (case-insensitive), o vice-versa
 *      Este matcheo no es perfecto (los targets pueden venir con prefijo
 *      UNC o como `tcp://`, mientras que device_id viene plano). Como
 *      fallback adicional, si no encuentra match exacto, despertamos
 *      todos los waiting_printer de la location — preferimos un retry de
 *      mas que dejar jobs colgados.
 *   3) Llamamos wakeJobsForPrintArea(location, area). Como pueden haber
 *      jobs con print_area=null (caja default), tambien despertamos esos.
 *
 * Notas conservadoras:
 *   - Si esto es la PRIMERA corrida (previousPrinterKeys === null), NO
 *     disparamos nada — todavia no tenemos baseline, asumir que "todo
 *     es nuevo" generaria mucho ruido al startup.
 *   - Si la lista nueva esta vacia y la anterior tenia entries, eso es una
 *     transicion "online -> offline". No despertamos nada (los jobs
 *     activos van a fallar y entrar en waiting_printer naturalmente).
 */
async function runAutoRecovery(
  supabase: SupabaseClient,
  config: AgentConfig,
  logger: Logger,
  state: HeartbeatState,
  currentPrinters: DiscoveredPrinter[]
): Promise<void> {
  const currentKeys = new Set(currentPrinters.map(printerKey));

  // Primera corrida: solo guardamos baseline y salimos.
  if (state.previousPrinterKeys === null) {
    state.previousPrinterKeys = currentKeys;
    logger.debug(
      { count: currentKeys.size },
      'Auto-recovery: baseline inicial guardada'
    );
    return;
  }

  // Diff: claves que estan en current pero no estaban en previous.
  const newlyAppeared: DiscoveredPrinter[] = [];
  for (const p of currentPrinters) {
    if (!state.previousPrinterKeys.has(printerKey(p))) {
      newlyAppeared.push(p);
    }
  }

  // Actualizar baseline para el proximo ciclo SIEMPRE, antes de cualquier
  // early-return, asi no nos quedamos pegados detectando "nuevas" las
  // mismas impresoras en cada ciclo.
  state.previousPrinterKeys = currentKeys;

  if (newlyAppeared.length === 0) {
    return;
  }

  logger.info(
    {
      count: newlyAppeared.length,
      printers: newlyAppeared.map((p) => ({
        name: p.name,
        kind: p.kind,
        device_id: p.device_id
      }))
    },
    `Auto-recovery: ${newlyAppeared.length} impresora(s) nueva(s) detectada(s)`
  );

  // Cargar las impresoras configuradas para resolver print_area_id.
  // Si la query falla, hacemos fallback "despertar todos" mas abajo.
  let configured;
  try {
    configured = await loadPrintersForLocation(
      supabase,
      config.location_id,
      logger
    );
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'Auto-recovery: no pude cargar impresoras configuradas, hago wake total'
    );
    await wakeAllForLocation(supabase, config.location_id, logger);
    return;
  }

  // Matchear cada impresora descubierta nueva con su configurada (si la hay)
  // y juntar print_area_ids unicos a despertar.
  const areasToWake = new Set<string | null>();
  let unmatchedCount = 0;

  for (const discovered of newlyAppeared) {
    const matched = matchDiscoveredToConfigured(discovered, configured);
    if (matched.length === 0) {
      unmatchedCount += 1;
      continue;
    }
    for (const printer of matched) {
      areasToWake.add(printer.print_area_id);
    }
  }

  if (areasToWake.size === 0 && unmatchedCount > 0) {
    // No pudimos matchear ninguna. Fallback conservador: despertar todos
    // los jobs de la location. Preferimos reintentar de mas a tener jobs
    // colgados porque el matcheo es imperfecto.
    logger.info(
      { unmatchedCount },
      'Auto-recovery: no pude matchear impresoras nuevas, hago wake total'
    );
    await wakeAllForLocation(supabase, config.location_id, logger);
    return;
  }

  for (const areaId of areasToWake) {
    await wakeJobsForPrintArea(supabase, config.location_id, areaId, logger);
  }
}

/**
 * Heuristica de matcheo "impresora del SO" -> "impresora configurada".
 *
 * Reglas:
 *   - Misma familia: kind del discovery debe coincidir con
 *     connection_type del configured (usb/network/bluetooth).
 *   - target del configured contiene el device_id del discovery (o vice
 *     versa), case-insensitive. Esto cubre los casos comunes:
 *       * USB:        device_id="USB001",      target="\\localhost\Epson" (no match: ok, esperable)
 *       * USB direct: device_id="USB001",      target="\\.\USB001" (match)
 *       * Network:    device_id="192.168.1.50:9100", target="192.168.1.50:9100" (match)
 *       * Network:    device_id="192.168.1.50:9100", target="192.168.1.50" (match: target subset)
 *       * Bluetooth:  device_id="COM7",        target="COM7" (match)
 *
 * Devuelve TODAS las impresoras configuradas que matchean (puede haber mas
 * de una si comparten target, raro pero posible).
 *
 * TODO(carlos): consolidar matcheo USB cuando el cliente usa share UNC
 * (\\localhost\EpsonShare) — no tenemos info en discovered para hacer
 * el match exacto. Por ahora la heuristica los deja fuera y caemos al
 * fallback "wake total" si todas las nuevas son USB share.
 */
function matchDiscoveredToConfigured(
  discovered: DiscoveredPrinter,
  configured: ReadonlyArray<{
    print_area_id: string | null;
    connection_type: string;
    target: string | null;
  }>
): Array<{ print_area_id: string | null }> {
  const did = discovered.device_id.toLowerCase();
  const dkind = discovered.kind;
  const matches: Array<{ print_area_id: string | null }> = [];
  for (const c of configured) {
    if (c.connection_type !== dkind) continue;
    const t = (c.target ?? '').toLowerCase();
    if (t.length === 0) continue;
    if (t.includes(did) || did.includes(t)) {
      matches.push({ print_area_id: c.print_area_id });
    }
  }
  return matches;
}

/**
 * Despierta TODOS los waiting_printer de la location (sin filtrar por
 * print_area). Lo usamos como fallback cuando el matcheo no encuentra
 * nada — preferimos reintentar de mas a dejar jobs colgados.
 */
async function wakeAllForLocation(
  supabase: SupabaseClient,
  locationId: string,
  logger: Logger
): Promise<void> {
  const { data, error } = await supabase
    .from('print_jobs')
    .update({
      status: 'pending',
      next_retry_at: null
    })
    .eq('location_id', locationId)
    .eq('status', 'waiting_printer')
    .select('id');

  if (error) {
    logger.warn(
      { err: error },
      'Auto-recovery: error en wake total (seguimos andando)'
    );
    return;
  }

  const count = data?.length ?? 0;
  if (count > 0) {
    logger.info({ count }, `Auto-recovery total: desperte ${count} job(s)`);
  }
}

/**
 * Intenta obtener la IPv4 no-loopback de la maquina. Si no encuentra
 * ninguna util, retorna null y dejamos que el server registre lo que vea.
 */
function getLocalIp(): string | null {
  try {
    const ifaces = networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      const list = ifaces[name];
      if (!list) continue;
      for (const entry of list) {
        if (entry.family === 'IPv4' && !entry.internal) {
          return entry.address;
        }
      }
    }
  } catch {
    // best-effort, no critico
  }
  return null;
}
