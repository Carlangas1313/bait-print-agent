#!/usr/bin/env node
import readline from 'node:readline';
import { Command } from 'commander';
import { loadConfig, type AgentConfig } from './config.js';
import { createLogger } from './logger.js';
import { createAuthenticatedSupabase } from './supabase.js';
import { startRealtimeListener, backfillPendingJobs } from './realtime.js';
import { startHeartbeat } from './heartbeat.js';
import { startRetryScheduler } from './retry-scheduler.js';
import { getVirtualOutDir } from './renderer/virtual.js';
import { dispatchJob } from './renderer/dispatcher.js';
import {
  loadPrintersForLocation,
  type PrinterRow
} from './printers/registry.js';
import { setupAgent } from './setup.js';
import {
  AGENT_VERSION,
  getSupabaseUrl,
  getSupabaseAnonKey
} from './constants.js';
import {
  deletePersistentConfig,
  ensureLocalApiToken,
  getConfigPath,
  readPersistentConfig
} from './persistent-config.js';
import {
  installService,
  uninstallService,
  serviceStatus
} from './install-service.js';
import {
  checkForUpdates,
  startPeriodicUpdateCheck
} from './update-checker.js';
import { autoUpdate } from './auto-update.js';
import { startLocalApi } from './local-api/server.js';
import type { AgentRuntimeState } from './local-api/handlers.js';

/**
 * Repo de GitHub donde publicamos los .exe. Hardcodeado porque el
 * binario distribuido al cliente no tiene env vars que lo cambien.
 * Si algun dia migramos a otra org, hay que tocar este valor y volver
 * a buildear.
 */
const UPDATE_CHECK_REPO = 'Carlangas1313/bait-print-agent';

/**
 * Default del intervalo de check de updates en minutos. Overridable
 * via env var `UPDATE_CHECK_INTERVAL_MINUTES`. 60 = una vez por hora,
 * suficiente para que el usuario se entere "en el dia" sin spamear
 * la API publica de GitHub (60 reqs/h sin auth).
 */
const DEFAULT_UPDATE_CHECK_INTERVAL_MINUTES = 60;

/**
 * Lee el intervalo del env var con default fallback. Si el valor no
 * parsea como int positivo, ignoramos y usamos el default — no queremos
 * que un typo en la config tumbe el agente.
 */
function readUpdateCheckIntervalMinutes(): number {
  const raw = process.env.UPDATE_CHECK_INTERVAL_MINUTES;
  if (!raw) return DEFAULT_UPDATE_CHECK_INTERVAL_MINUTES;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 1) {
    return DEFAULT_UPDATE_CHECK_INTERVAL_MINUTES;
  }
  return parsed;
}

/**
 * Permite desactivar el checker via `UPDATE_CHECK_ENABLED=false`.
 * Cualquier otro valor (incluyendo unset) lo deja activo. Es opt-out
 * porque queremos que el cliente final reciba avisos por default.
 */
function isUpdateCheckEnabled(): boolean {
  const raw = process.env.UPDATE_CHECK_ENABLED?.trim().toLowerCase();
  return raw !== 'false' && raw !== '0' && raw !== 'no';
}

/**
 * Entry point del agente. Construido con commander para que los
 * subcomandos sean claros y --help los liste solos.
 *
 * Comandos:
 *   bait-print-agent                       arranca el agente con la config persistente
 *   bait-print-agent setup --code XX-XX    canjea pairing code y guarda config
 *   bait-print-agent reset                 borra la config persistente (pide confirmacion)
 *   bait-print-agent status                muestra estado actual de la config
 *
 * No hay flag CLI de modo: el agente siempre arranca en modo productivo
 * (imprime fisico via ESC/POS). Para debug, exportar `BAIT_DEBUG_RENDERER`:
 *   - BAIT_DEBUG_RENDERER=console  → escribe tickets a stdout (no toca printers)
 *   - BAIT_DEBUG_RENDERER=virtual  → escribe tickets a ~/bait-print-out/
 */

const program = new Command();

program
  .name('bait-print-agent')
  .description('Agente local de impresion para bait-pos.')
  .version(AGENT_VERSION, '-v, --version');

// -------------------------------------------------------------------
// Comando: setup
// -------------------------------------------------------------------
program
  .command('setup')
  .description('Canjea un pairing code (XXXX-XXXX) y guarda credenciales locales.')
  .requiredOption('--code <code>', 'Pairing code entregado por el dashboard')
  .action(async (opts: { code: string }) => {
    const logger = createLogger('info');
    try {
      await setupAgent(opts.code, getSupabaseUrl(), getSupabaseAnonKey(), logger);
      process.exit(0);
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        'Setup fallo'
      );
      process.exit(1);
    }
  });

// -------------------------------------------------------------------
// Comando: reset
// -------------------------------------------------------------------
program
  .command('reset')
  .description('Borra la configuracion persistente local (desconecta el agente).')
  .option('-y, --yes', 'Confirma sin preguntar (peligroso)')
  .action(async (opts: { yes?: boolean }) => {
    const logger = createLogger('info');
    const existing = readPersistentConfig();

    if (!existing) {
      logger.info('No hay configuracion para borrar.');
      process.exit(0);
    }

    if (!opts.yes) {
      const answer = await prompt(
        `¿Seguro? Esto desconecta el agente "${existing.agent_name}". (y/N): `
      );
      if (answer.trim().toLowerCase() !== 'y') {
        logger.info('Cancelado, no se borro nada.');
        process.exit(0);
      }
    }

    deletePersistentConfig();
    logger.info(`✓ Config borrada (${getConfigPath()}).`);
    process.exit(0);
  });

// -------------------------------------------------------------------
// Comando: status
// -------------------------------------------------------------------
program
  .command('status')
  .description('Muestra el estado de la configuracion persistente.')
  .action(() => {
    const configPath = getConfigPath();
    const existing = readPersistentConfig();

    if (!existing) {
      process.stdout.write(
        [
          `bait-print-agent v${AGENT_VERSION}`,
          `Config esperada en: ${configPath}`,
          'Estado: NO CONFIGURADO',
          '',
          'Ejecuta `bait-print-agent setup --code XXXX-XXXX` para canjear un pairing code.',
          ''
        ].join('\n')
      );
      process.exit(0);
    }

    process.stdout.write(
      [
        `bait-print-agent v${AGENT_VERSION}`,
        `Config en: ${configPath}`,
        'Estado: CONFIGURADO',
        '',
        `Agente:        ${existing.agent_name}`,
        `Agent ID:      ${existing.agent_id}`,
        `Restaurant ID: ${existing.restaurant_id}`,
        `Location ID:   ${existing.location_id}`,
        `Email auth:    ${existing.auth_email}`,
        `Supabase URL:  ${existing.supabase_url}`,
        `Pairing en:    ${existing.pairing_completed_at}`,
        `Version pair:  ${existing.agent_version}`,
        ''
      ].join('\n')
    );
    process.exit(0);
  });

// -------------------------------------------------------------------
// Comando: install-service
// -------------------------------------------------------------------
program
  .command('install-service')
  .description('Instala el agente como servicio Windows (arranca al boot)')
  .option('--exe-path <path>', 'Path al .exe (default: auto-detectado)')
  .option('--name <name>', 'Nombre interno del servicio', 'bAItPrintAgent')
  .option('--display <name>', 'Nombre visible del servicio', 'bAIt Print Agent')
  .action(async (opts: { exePath?: string; name: string; display: string }) => {
    const logger = createLogger('info');
    try {
      await installService({
        exePath: opts.exePath,
        serviceName: opts.name,
        serviceDisplay: opts.display,
        logger
      });
      process.exit(0);
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        'install-service fallo'
      );
      process.exit(1);
    }
  });

// -------------------------------------------------------------------
// Comando: uninstall-service
// -------------------------------------------------------------------
program
  .command('uninstall-service')
  .description('Desinstala el servicio Windows del agente')
  .option('--name <name>', 'Nombre del servicio', 'bAItPrintAgent')
  .action(async (opts: { name: string }) => {
    const logger = createLogger('info');
    try {
      await uninstallService({ serviceName: opts.name, logger });
      process.exit(0);
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        'uninstall-service fallo'
      );
      process.exit(1);
    }
  });

// -------------------------------------------------------------------
// Comando: service-status
// -------------------------------------------------------------------
program
  .command('service-status')
  .description('Muestra el estado del servicio Windows del agente')
  .option('--name <name>', 'Nombre del servicio', 'bAItPrintAgent')
  .action(async (opts: { name: string }) => {
    const logger = createLogger('info');
    try {
      await serviceStatus({ serviceName: opts.name, logger });
      process.exit(0);
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        'service-status fallo'
      );
      process.exit(1);
    }
  });

// -------------------------------------------------------------------
// Comando: check-updates
// -------------------------------------------------------------------
program
  .command('check-updates')
  .description('Chequea si hay una version nueva del agente disponible')
  .action(async () => {
    const logger = createLogger('info');
    const update = await checkForUpdates({
      currentVersion: AGENT_VERSION,
      repo: UPDATE_CHECK_REPO,
      logger
    });
    if (update) {
      logger.info(
        {
          currentVersion: AGENT_VERSION,
          latestVersion: update.latestVersion,
          releaseUrl: update.releaseUrl,
          downloadUrl: update.downloadUrl,
          publishedAt: update.publishedAt
        },
        `🆕 Hay una version nueva disponible: v${update.latestVersion} (actual: v${AGENT_VERSION}). ` +
          `Ver detalles en ${update.releaseUrl}`
      );
      process.exit(0);
    } else {
      logger.info(`Version actual al dia (v${AGENT_VERSION})`);
      process.exit(0);
    }
  });

// -------------------------------------------------------------------
// Comando: update (descarga + reemplaza + restart servicio)
// -------------------------------------------------------------------
program
  .command('update')
  .description(
    'Aplica el ultimo update disponible (descarga + reemplazo + restart servicio)'
  )
  .option(
    '--force',
    'Aplicar update aunque la version actual ya sea la mas nueva',
    false
  )
  .option(
    '--service-name <name>',
    'Nombre del servicio Windows (default: bAItPrintAgent)',
    'bAItPrintAgent'
  )
  .action(async (opts: { force: boolean; serviceName: string }) => {
    const logger = createLogger('info');
    const update = await checkForUpdates({
      currentVersion: AGENT_VERSION,
      repo: UPDATE_CHECK_REPO,
      logger
    });

    if (!update && !opts.force) {
      logger.info(
        `Version actual al dia (v${AGENT_VERSION}). Para forzar, usa --force.`
      );
      process.exit(0);
    }

    if (!update && opts.force) {
      logger.error(
        'No hay info de release disponible. Verifica conectividad a GitHub.'
      );
      process.exit(1);
    }

    try {
      // Si --force pero el checker no detectó nada, ya salimos arriba. Aca
      // siempre `update` es no-null (el `if` previo cubre el null).
      await autoUpdate({
        updateInfo: update!,
        logger,
        serviceName: opts.serviceName
      });
      process.exit(0);
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        'update fallo'
      );
      process.exit(1);
    }
  });

// -------------------------------------------------------------------
// Comando default: arrancar el agente
// -------------------------------------------------------------------
program
  .action(async () => {
    await runAgent();
  });

// Si no hay subcomando, parsea como default action.
program.parseAsync(process.argv).catch((err) => {
  // Si es un error de parseo de commander (ej: --mode invalido), el
  // mensaje ya es claro; lo imprimimos solo. Para crashes reales del
  // runtime mostramos el stack para que sea debuggeable.
  if (err instanceof Error) {
    process.stderr.write(`bait-print-agent: ${err.message}\n`);
    if (process.env.DEBUG) {
      process.stderr.write(`${err.stack}\n`);
    }
  } else {
    process.stderr.write(`bait-print-agent: ${String(err)}\n`);
  }
  process.exit(1);
});

// ====================================================================
// Helpers
// ====================================================================

/**
 * Lee una linea desde stdin. Usado en `reset` para confirmar el borrado.
 */
function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

/**
 * Default del intervalo de refresh del cache de impresoras. Overridable
 * via env var `PRINTERS_REFRESH_INTERVAL_MINUTES`. 5 min cubre el caso
 * tipico donde un admin agrega/modifica printers en bait-app.cl mientras
 * el agente esta corriendo: el cambio se ve en ~5 min sin reiniciar.
 */
const DEFAULT_PRINTERS_REFRESH_INTERVAL_MINUTES = 5;

function readPrintersRefreshIntervalMinutes(): number {
  const raw = process.env.PRINTERS_REFRESH_INTERVAL_MINUTES;
  if (!raw) return DEFAULT_PRINTERS_REFRESH_INTERVAL_MINUTES;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 1) {
    return DEFAULT_PRINTERS_REFRESH_INTERVAL_MINUTES;
  }
  return parsed;
}

/**
 * Arranque del agente. Loop principal: heartbeat + realtime listener.
 * Se queda corriendo hasta SIGINT/SIGTERM.
 *
 * El agente arranca SIEMPRE en modo productivo (imprime fisico via ESC/POS).
 * Si la env var `BAIT_DEBUG_RENDERER` esta seteada a 'console' o 'virtual',
 * el dispatcher hace bypass del renderer real y escribe a stdout/archivo —
 * pero ese modo es solo para dev. Nunca es el path del cliente final.
 */
async function runAgent(): Promise<void> {
  const config: AgentConfig = loadConfig();
  const logger = createLogger(config.log_level);

  const renderTag = config.debug_renderer ?? 'productivo';
  logger.info(
    {
      version: AGENT_VERSION,
      renderer: renderTag,
      agentName: config.agent_name,
      locationId: config.location_id
    },
    `bait-print-agent v${AGENT_VERSION} iniciando (renderer: ${renderTag}) para location ${config.location_id}`
  );

  // ------------------------------------------------------------------
  // Supabase autenticado (signInWithPassword en modo persistente). Hay
  // que crearlo antes que el dispatcher porque el load de printers ya
  // necesita el cliente.
  // ------------------------------------------------------------------
  const supabase = await createAuthenticatedSupabase(config);

  // ------------------------------------------------------------------
  // Cargar printers configuradas + arrancar refresh cada N min.
  //
  // Lo hacemos SIEMPRE (incluido cuando debug_renderer esta activo) para
  // que el snapshot de printers este disponible si alguien apaga el debug
  // override en vivo. Pero si el load falla, NO bloqueamos el arranque —
  // solo logueamos: el caller del jobHandler va a ver la lista vacia y el
  // dispatcher va a clasificar el job como 'permanent' con mensaje claro.
  //
  // El cache es mutable porque lo refrescamos cada N min via setInterval.
  // El handler del realtime captura la referencia mutable y lee siempre el
  // ultimo snapshot.
  // ------------------------------------------------------------------
  let printersCache: PrinterRow[] = [];
  let printersRefreshId: NodeJS.Timeout | null = null;

  try {
    printersCache = await loadPrintersForLocation(
      supabase,
      config.location_id,
      logger
    );
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'No pude cargar impresoras al arrancar — los jobs van a fallar con permanent hasta que se configuren'
    );
  }

  if (printersCache.length === 0 && config.debug_renderer === null) {
    logger.warn(
      { locationId: config.location_id },
      'No hay impresoras configuradas en esta location. Los jobs van a fallar con permanent hasta que agregues alguna en bait-app.cl → Configuración → Impresoras.'
    );
  }

  const refreshMinutes = readPrintersRefreshIntervalMinutes();
  logger.info(
    { intervalMinutes: refreshMinutes },
    `Refresh de impresoras cada ${refreshMinutes} min`
  );
  printersRefreshId = setInterval(() => {
    void loadPrintersForLocation(supabase, config.location_id, logger)
      .then((fresh) => {
        printersCache = fresh;
      })
      .catch((err) => {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'Refresh de impresoras fallo, mantengo cache anterior'
        );
      });
  }, refreshMinutes * 60 * 1000);

  if (config.debug_renderer) {
    logger.warn(
      { renderer: config.debug_renderer, outDir: getVirtualOutDir() },
      `BAIT_DEBUG_RENDERER=${config.debug_renderer} activo. El renderer productivo (ESC/POS) esta deshabilitado — los tickets ${config.debug_renderer === 'virtual' ? `se guardan en ${getVirtualOutDir()}/` : 'salen a stdout'}.`
    );
  }

  // ------------------------------------------------------------------
  // Runtime state: snapshot vivo que el local API expone via /v1/status.
  // Lo definimos aca para que los observers (heartbeat, realtime, job
  // handler) lo muten en sus respectivos eventos. El struct vive en este
  // scope para que su lifetime sea el del agente.
  // ------------------------------------------------------------------
  const runtimeState: AgentRuntimeState = {
    last_heartbeat_at: null,
    last_job_at: null,
    realtime_status: 'PENDING',
    supabase_connected: true, // ya pasamos por createAuthenticatedSupabase OK
    discovered_printers: [],
    // refreshQueue se rellena despues de armar el jobHandler (necesita la
    // closure correcta sobre printersCache + modo efectivo).
    refreshQueue: async () => ({ processed: 0 })
  };

  // ------------------------------------------------------------------
  // Job handler unificado: el dispatcher decide segun el modo efectivo.
  // Captura `printersCache` por referencia para que el refresh interval
  // se vea reflejado al instante.
  //
  // Lo envolvemos para actualizar `runtimeState.last_job_at` cada vez que
  // procesamos un job (sin importar el outcome). Asi el companion puede
  // mostrar "Ultimo job: hace 12s" en su panel.
  // ------------------------------------------------------------------
  const jobHandler = async (job: Parameters<typeof dispatchJob>[0]) => {
    const result = await dispatchJob(
      job,
      config.debug_renderer,
      printersCache,
      logger,
      supabase
    );
    runtimeState.last_job_at = new Date().toISOString();
    return result;
  };

  // Ahora si: rellenamos refreshQueue con la closure correcta. Hacemos
  // mutation sobre el objeto para no romper la referencia que el local API
  // ya capturo.
  runtimeState.refreshQueue = () =>
    backfillPendingJobs(supabase, config, logger, jobHandler);

  const heartbeatId = startHeartbeat(supabase, config, logger, {
    onSuccess: ({ at }) => {
      runtimeState.last_heartbeat_at = at;
      runtimeState.supabase_connected = true;
    },
    onFailure: () => {
      // Si el heartbeat falla, no podemos asumir que Supabase este OK.
      // El flag se vuelve a poner true al primer heartbeat exitoso.
      runtimeState.supabase_connected = false;
    },
    onDiscovery: (printers) => {
      runtimeState.discovered_printers = printers;
    }
  });

  // ------------------------------------------------------------------
  // Retry scheduler: cada 15s reanima los waiting_printer cuyo
  // next_retry_at ya paso, y aplica el hard cap de 24h a los muy viejos.
  // Funciona en cualquier modo (console/virtual/usb), pero solo tiene
  // efecto practico cuando hay jobs encolados que fallaron alguna vez.
  // ------------------------------------------------------------------
  const retrySchedulerId = startRetryScheduler(supabase, config, logger);

  // ------------------------------------------------------------------
  // Update checker: polling cada UPDATE_CHECK_INTERVAL_MINUTES (default 60)
  // contra GitHub Releases. Si la env var `UPDATE_CHECK_ENABLED=false`,
  // ni siquiera arrancamos el setInterval — algunos clientes muy paranoicos
  // pueden querer cortar todo trafico saliente fuera de Supabase.
  // ------------------------------------------------------------------
  let updateCheckerId: NodeJS.Timeout | null = null;
  if (isUpdateCheckEnabled()) {
    updateCheckerId = startPeriodicUpdateCheck({
      intervalMinutes: readUpdateCheckIntervalMinutes(),
      currentVersion: AGENT_VERSION,
      repo: UPDATE_CHECK_REPO,
      logger,
      // Pasamos el nombre del servicio para que cuando UPDATE_APPLY_ENABLED=true,
      // el auto-update pueda reiniciar el servicio Windows con el binario nuevo.
      serviceName: 'bAItPrintAgent'
    });
  } else {
    logger.info('Update checker deshabilitado (UPDATE_CHECK_ENABLED=false)');
  }

  const channel = await startRealtimeListener(
    supabase,
    config,
    logger,
    jobHandler,
    (status) => {
      // Cada cambio de estado del canal Realtime se refleja en /v1/status.
      // Los valores comunes son 'SUBSCRIBED', 'CHANNEL_ERROR', 'TIMED_OUT',
      // 'CLOSED'. El companion los mapea a iconos verde/rojo/amarillo.
      runtimeState.realtime_status = status;
    }
  );

  // ------------------------------------------------------------------
  // Local API HTTP (127.0.0.1:17891): expone /v1/status, /v1/jobs/recent,
  // y endpoints de control al tray companion. Token compartido vive en el
  // mismo config.json que las credenciales del agente (NSSM pinnea
  // USERPROFILE asi ambos procesos comparten el home).
  //
  // Si el archivo no tenia token todavia (config legacy), ensureLocalApiToken
  // lo genera y persiste antes de arrancar el server. En modo env-legacy
  // (sin persistent config) devuelve null y NO arrancamos el server — el
  // companion no tiene sentido ahi porque no hay archivo desde donde leer
  // el token.
  // ------------------------------------------------------------------
  const localApiToken = ensureLocalApiToken();
  let localApiServer: ReturnType<typeof startLocalApi> | null = null;
  if (localApiToken) {
    localApiServer = startLocalApi({
      supabase,
      config,
      logger,
      state: runtimeState,
      token: localApiToken
    });
  } else {
    logger.warn(
      'Sin config persistente: no se arranca el local API. El tray companion no podra conectarse.'
    );
  }

  // ------------------------------------------------------------------
  // Cleanup ordenado: paramos heartbeat, update checker, refresh de printers,
  // cerramos canal, cerramos el local API, salimos.
  // ------------------------------------------------------------------
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down gracefully');
    clearInterval(heartbeatId);
    clearInterval(retrySchedulerId);
    if (updateCheckerId) clearInterval(updateCheckerId);
    if (printersRefreshId) clearInterval(printersRefreshId);
    try {
      // channel ahora es un RealtimeHandle (wrapper con auto-reconnect interno)
      // — su unsubscribe() cancela cualquier reintento pendiente y cierra el
      // canal activo. No usamos supabase.removeChannel porque la referencia
      // concreta al RealtimeChannel se reemplaza internamente en cada
      // reconexion y no queremos tocar ese estado desde afuera.
      await channel.unsubscribe();
    } catch (err) {
      logger.warn({ err }, 'Error cerrando canal Realtime (ignorado)');
    }
    // Cerrar el local API server. close() espera a que las conexiones
    // activas terminen; el companion es local, esto es ~instantaneo.
    if (localApiServer) {
      try {
        await new Promise<void>((resolve) => {
          localApiServer!.close(() => resolve());
          // Safety net: si por alguna razon el close se queda colgado, no
          // bloqueamos el shutdown del agente.
          setTimeout(() => resolve(), 2_000).unref();
        });
      } catch (err) {
        logger.warn({ err }, 'Error cerrando local API server (ignorado)');
      }
    }
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}
