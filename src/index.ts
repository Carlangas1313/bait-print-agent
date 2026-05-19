#!/usr/bin/env node
import { loadConfig, type AgentConfig } from './config.js';
import { createLogger } from './logger.js';
import { createSupabase } from './supabase.js';
import { startRealtimeListener } from './realtime.js';
import { startHeartbeat } from './heartbeat.js';
import { renderJob } from './renderer/console.js';

/**
 * Entry point del agente.
 *
 * Cargar el .env: Node 20+ soporta `--env-file=.env` de forma nativa,
 * por eso no usamos dotenv. El usuario corre:
 *   node --env-file=.env dist/index.js --mode console
 *
 * En dev con tsx, basta con tener el .env en la raiz y usar el mismo flag.
 */

const AGENT_VERSION = '0.1.0';

type CliArgs = {
  mode?: 'console' | 'usb';
  showVersion: boolean;
  showHelp: boolean;
};

function parseArgs(argv: string[]): CliArgs {
  const result: CliArgs = { showVersion: false, showHelp: false };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--version' || a === '-v') {
      result.showVersion = true;
    } else if (a === '--help' || a === '-h') {
      result.showHelp = true;
    } else if (a === '--mode') {
      const next = argv[i + 1];
      if (next === 'console' || next === 'usb') {
        result.mode = next;
        i++;
      } else {
        console.error(`Valor invalido para --mode: ${next ?? '(vacio)'}`);
        console.error('Modos validos: console | usb');
        process.exit(2);
      }
    }
  }

  return result;
}

function printHelp(): void {
  // Salida directa para CLI — no usamos logger porque puede no estar listo.
  process.stdout.write(
    [
      `bait-print-agent v${AGENT_VERSION}`,
      '',
      'Uso:',
      '  node --env-file=.env dist/index.js [opciones]',
      '',
      'Opciones:',
      '  --mode <console|usb>   Sobrescribe BAIT_AGENT_MODE del .env',
      '  --version, -v          Muestra la version y sale',
      '  --help, -h             Muestra esta ayuda',
      ''
    ].join('\n')
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.showVersion) {
    process.stdout.write(`bait-print-agent v${AGENT_VERSION}\n`);
    process.exit(0);
  }

  if (args.showHelp) {
    printHelp();
    process.exit(0);
  }

  const baseConfig = loadConfig();
  const config: AgentConfig = args.mode
    ? { ...baseConfig, BAIT_AGENT_MODE: args.mode }
    : baseConfig;

  const logger = createLogger(config.LOG_LEVEL);

  logger.info(
    {
      version: AGENT_VERSION,
      mode: config.BAIT_AGENT_MODE,
      locationId: config.BAIT_LOCATION_ID
    },
    `bait-print-agent v${AGENT_VERSION} iniciando en modo ${config.BAIT_AGENT_MODE} para location ${config.BAIT_LOCATION_ID}`
  );

  let effectiveMode: 'console' | 'usb' = config.BAIT_AGENT_MODE;
  if (effectiveMode === 'usb') {
    logger.warn(
      'Modo USB no implementado todavia (Sprint 4), cayendo a modo console'
    );
    effectiveMode = 'console';
  }

  const supabase = createSupabase(config);

  const heartbeatId = startHeartbeat(supabase, config, logger);

  const channel = await startRealtimeListener(
    supabase,
    config,
    logger,
    (job) => renderJob(job, logger)
  );

  // ------------------------------------------------------------------
  // Cleanup ordenado: paramos heartbeat, cerramos canal, salimos.
  // ------------------------------------------------------------------
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down gracefully');
    clearInterval(heartbeatId);
    try {
      await supabase.removeChannel(channel);
    } catch (err) {
      logger.warn({ err }, 'Error cerrando canal Realtime (ignorado)');
    }
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  // Si llegamos aca, el logger puede o no estar listo. Vamos a stderr.
  process.stderr.write(
    `bait-print-agent crash en startup: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`
  );
  process.exit(1);
});
