import { networkInterfaces } from 'node:os';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AgentConfig } from './config.js';
import type { Logger } from './logger.js';

/**
 * Heartbeat periodico contra la tabla `print_agents`.
 *
 * Actualiza `last_seen_at` + version + IP local cada N segundos para que
 * el dashboard pueda mostrar quien esta vivo. Si un UPDATE falla (red
 * caida, Supabase rate-limited, etc.) lo logueamos pero NO abortamos —
 * el agente debe seguir imprimiendo aunque pierda el heartbeat un rato.
 */

const AGENT_VERSION = '0.1.0';

export function startHeartbeat(
  supabase: SupabaseClient,
  config: AgentConfig,
  logger: Logger
): NodeJS.Timeout {
  const intervalMs = config.HEARTBEAT_INTERVAL_SECONDS * 1_000;

  // Primer ping inmediato — no esperamos el primer intervalo para
  // marcar el agente como vivo.
  void sendHeartbeat(supabase, config, logger);

  const handle = setInterval(() => {
    void sendHeartbeat(supabase, config, logger);
  }, intervalMs);

  logger.info(
    { intervalSeconds: config.HEARTBEAT_INTERVAL_SECONDS },
    'Heartbeat iniciado'
  );

  return handle;
}

async function sendHeartbeat(
  supabase: SupabaseClient,
  config: AgentConfig,
  logger: Logger
): Promise<void> {
  const ip = getLocalIp();

  const { error } = await supabase
    .from('print_agents')
    .update({
      last_seen_at: new Date().toISOString(),
      agent_version: AGENT_VERSION,
      last_seen_ip: ip
    })
    .eq('id', config.BAIT_AGENT_ID);

  if (error) {
    logger.warn(
      { err: error, agentId: config.BAIT_AGENT_ID },
      'Heartbeat fallo (seguimos andando)'
    );
    return;
  }

  logger.debug({ ip }, 'Heartbeat enviado');
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
