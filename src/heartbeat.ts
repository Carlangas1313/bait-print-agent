import { networkInterfaces } from 'node:os';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AgentConfig } from './config.js';
import type { Logger } from './logger.js';
import { AGENT_VERSION } from './constants.js';
import { discoverPrinters, type DiscoveredPrinter } from './printers/discover.js';

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
 */

/**
 * Cada cuantos heartbeats refrescamos el discovery de printers Windows.
 * Discovery es costoso (spawnea un PowerShell), por eso no lo hacemos
 * en CADA heartbeat. Con heartbeat default de 30s y este valor en 5,
 * el snapshot se refresca cada ~2.5 min — suficiente para que cuando
 * el cliente enchufa una USB nueva, aparezca en la UI en pocos minutos.
 */
const DISCOVERY_EVERY_N_HEARTBEATS = 5;

export function startHeartbeat(
  supabase: SupabaseClient,
  config: AgentConfig,
  logger: Logger
): NodeJS.Timeout {
  const intervalMs = config.heartbeat_interval_seconds * 1_000;

  // Contador local: cuantos heartbeats hicimos. Decide cuando refrescar el
  // discovery de printers. Empezamos en 0 → el primer heartbeat tambien
  // dispara discovery (asi la UI tiene datos apenas el agente conecta).
  let heartbeatCount = 0;

  const runOnce = async (): Promise<void> => {
    const includeDiscovery = heartbeatCount % DISCOVERY_EVERY_N_HEARTBEATS === 0;
    heartbeatCount += 1;
    await sendHeartbeat(supabase, config, logger, includeDiscovery);
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
  includeDiscovery: boolean
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

  if (includeDiscovery) {
    try {
      const printers = await discoverPrinters(logger);
      // Siempre escribimos — incluso si es [] — para indicar que el discovery
      // corrio. Asi la UI puede distinguir "el agente no detecto nada" vs
      // "el agente nunca corrio discovery todavia" (null en DB).
      update.discovered_printers = printers;
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
    return;
  }

  logger.debug(
    { ip, discoveryIncluded: includeDiscovery },
    'Heartbeat enviado'
  );
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
