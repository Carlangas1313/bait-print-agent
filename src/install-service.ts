/**
 * Instalacion/desinstalacion del agente como servicio Windows usando NSSM
 * (Non-Sucking Service Manager).
 *
 * Por que NSSM y no sc.exe directo:
 * ---------------------------------
 * El intento previo (Sprint 3c) usaba `sc.exe create binPath="..."` apuntando
 * directo al .exe del agente. Eso NO funciona para binarios Node.js: Windows
 * Service Control Manager (SCM) espera que el binario implemente el protocolo
 * nativo de servicios (llamar `StartServiceCtrlDispatcher`, responder a SCM
 * events, etc). Node.js puro no hace nada de eso, asi que el SCM mata el
 * servicio con error 1053 ("el servicio no respondio a tiempo, timeout 30s")
 * apenas pasan los 30 segundos del handshake.
 *
 * NSSM es un wrapper public-domain de ~300 KB que implementa el protocolo SCM
 * y delega al .exe Node.js como subprocess. Es el approach estandar para
 * correr binarios Node como servicios Windows — PM2, n8n, Plex y muchos otros
 * lo usan asi.
 *
 * Ademas NSSM nos da gratis:
 *   - Logs persistentes (stdout/stderr a archivo, con rotacion automatica).
 *   - Auto-restart si el proceso muere (configurable).
 *   - Throttling para evitar restart-loops infinitos.
 *
 * Distribucion del nssm.exe:
 * --------------------------
 * `scripts/package-win.js` copia `vendor/nssm.exe` a `dist/nssm.exe` al lado
 * del binario empaquetado. Inno Setup lo instala junto al .exe en
 * `C:\Program Files\bAIt Print Agent\nssm.exe`. En runtime, `getNssmPath()`
 * lo busca al lado del `process.execPath`.
 *
 * En dev (corriendo con tsx) nssm.exe no esta disponible — el flow de
 * install-service no aplica en dev, asi que tiramos un error claro pidiendo
 * empaquetar el agente primero.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Logger } from './logger.js';

const DEFAULT_SERVICE_NAME = 'bAItPrintAgent';
const DEFAULT_SERVICE_DISPLAY = 'bAIt Print Agent';
const DEFAULT_SERVICE_DESCRIPTION =
  'Agente local de bait-pos. Procesa la cola de impresion y envia comandas a las impresoras del local.';

/**
 * Tamano maximo por archivo de log antes de rotar (1 MB).
 * Con esto los logs ocupan a lo sumo unos pocos MB en disco — suficiente
 * para troubleshooting sin llenar el disco del cliente.
 */
const LOG_ROTATE_BYTES = 1_048_576; // 1 MB

/**
 * Delay (ms) que NSSM espera entre que el proceso muere y lo reinicia.
 * 5 segundos da tiempo a que algun handle del SO se libere antes del
 * proximo arranque.
 */
const RESTART_DELAY_MS = 5_000;

/**
 * Throttle (ms): ventana minima entre restarts. Si el proceso crashea mas
 * rapido que esto, NSSM lo considera "fallando" y no insiste. 60s es el
 * default sano que recomienda la doc de NSSM.
 */
const THROTTLE_WINDOW_MS = 60_000;

export interface InstallServiceOptions {
  exePath?: string;
  serviceName?: string;
  serviceDisplay?: string;
  logger: Logger;
}

export interface UninstallServiceOptions {
  serviceName?: string;
  logger: Logger;
}

export interface ServiceStatusOptions {
  serviceName?: string;
  logger: Logger;
}

/**
 * True si corremos en Windows. Usado por todos los puntos de entrada para
 * abortar temprano con un mensaje claro en lugar de explotar mas adelante
 * con un ENOENT cuando intentemos llamar a nssm.exe.
 */
export function isWindows(): boolean {
  return process.platform === 'win32';
}

/**
 * Detecta si el proceso actual corre con permisos de Administrador en
 * Windows. El truco estandar es intentar una operacion que requiere
 * elevation (`fsutil dirty query C:`) y ver si tira. Si tira, no somos admin.
 *
 * En no-Windows tira explicito: este check no tiene sentido fuera de Win.
 */
export async function isElevated(): Promise<boolean> {
  if (!isWindows()) {
    throw new Error('Esta funcion solo funciona en Windows.');
  }

  try {
    // 'fsutil dirty query C:' requiere admin. Si volvio sin tirar, somos admin.
    execFileSync('fsutil', ['dirty', 'query', 'C:'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Asegura admin + Windows o tira con mensaje pidiendo al usuario que abra
 * la consola elevada. Si no es Windows, sale con un error claro de que
 * los servicios son Windows-only.
 */
async function requireAdmin(logger: Logger): Promise<void> {
  if (!isWindows()) {
    logger.error(
      'Los servicios Windows solo se instalan en Windows. En Linux/macOS corre el agente con systemd/launchd o desde una terminal abierta.'
    );
    process.exit(1);
  }

  const admin = await isElevated();
  if (!admin) {
    logger.error(
      'Necesitas correr el agente como Administrador para esta operacion.\n   Tip: click derecho en CMD o PowerShell -> "Ejecutar como administrador" -> vuelve a correr este comando.'
    );
    process.exit(1);
  }
}

/**
 * Resuelve el path al `nssm.exe` que se distribuye al lado del binario del
 * agente. En la instalacion final queda en
 * `C:\Program Files\bAIt Print Agent\nssm.exe`.
 *
 * `process.execPath` apunta al .exe que esta corriendo (gracias a Node SEA),
 * asi que `path.dirname(...)` nos da la carpeta de la instalacion sin
 * importar como se llamen al final los binarios.
 */
function getNssmPath(): string {
  const exeDir = path.dirname(process.execPath);
  const nssmPath = path.join(exeDir, 'nssm.exe');
  if (!fs.existsSync(nssmPath)) {
    throw new Error(
      `No encontre nssm.exe en ${nssmPath}.\n` +
        `Esto puede pasar si estas corriendo el agente desde tsx en dev (no desde el .exe empaquetado).\n` +
        `En produccion nssm.exe se distribuye junto con el .exe (lo agrega scripts/package-win.js).`
    );
  }
  return nssmPath;
}

/**
 * Resuelve el path al .exe que vamos a registrar como servicio. Por defecto
 * usa `process.execPath` (el propio .exe que esta corriendo, gracias a Node
 * SEA). Si el usuario pasa --exe-path, validamos que exista y sea .exe.
 *
 * NSSM necesita un path absoluto y estable: si registramos un path relativo
 * o un .js sin nada que lo ejecute, NSSM acepta pero el servicio crashea
 * apenas arranca.
 */
function resolveExePath(custom: string | undefined): string {
  const candidate = custom?.trim() || process.execPath;

  if (!candidate.toLowerCase().endsWith('.exe')) {
    throw new Error(
      `El path al ejecutable debe ser un .exe. Recibido: ${candidate}\n` +
        'Si estas en dev (tsx) y queres probar igual, empaqueta el agente con `npm run package:win` y usa el .exe resultante.'
    );
  }

  if (!fs.existsSync(candidate)) {
    throw new Error(
      `No existe el .exe en: ${candidate}\nPasa --exe-path con la ruta absoluta al bait-print-agent-win-x64.exe.`
    );
  }

  return candidate;
}

/**
 * Carpeta donde NSSM va a escribir los logs del agente. La armamos en el
 * home del usuario porque NSSM corre como SYSTEM por defecto y SYSTEM tiene
 * su propio %USERPROFILE%, pero queremos los logs en la carpeta del usuario
 * humano que instalo el agente.
 *
 * Si la carpeta no existe la creamos antes de pasarsela a NSSM.
 */
function getServiceLogsDir(): string {
  return path.join(os.homedir(), '.bait-print-agent', 'logs');
}

/**
 * Ejecuta NSSM con los args dados. Loggeamos el comando + el stdout/stderr
 * cuando algo falla. NSSM imprime mensajes claros a stderr en errores
 * (ej. "service already exists"), asi que los exponemos al user.
 */
function runNssm(
  nssm: string,
  args: string[],
  logger: Logger,
  options: { ignoreErrors?: boolean } = {}
): string {
  try {
    const out = execFileSync(nssm, args, { encoding: 'utf8', stdio: 'pipe' });
    return out;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      status?: number;
    };
    const detail =
      e.stderr?.toString().trim() ||
      e.stdout?.toString().trim() ||
      e.message;
    if (options.ignoreErrors) {
      logger.debug({ args, detail }, 'nssm comando fallo (ignorado)');
      return detail;
    }
    logger.error({ args, detail, status: e.status }, 'nssm comando fallo');
    throw new Error(`nssm ${args.join(' ')} fallo: ${detail}`);
  }
}

/**
 * Limpia una instalacion previa rota (caso del bug del Sprint 3c, donde el
 * servicio se registro directo con sc.exe create y no arranca por error 1053).
 *
 * Si encontramos un servicio con ese nombre que NSSM no reconoce (osea, no
 * fue creado por NSSM), lo borramos con sc.exe antes de que installService()
 * intente registrarlo y NSSM tire "service already exists".
 *
 * `sc.exe query` exit code 1060 = "el servicio no existe", lo ignoramos.
 * Cualquier otro exit code != 0 = no es lo que esperabamos, mejor abortar.
 */
function cleanupBrokenScService(serviceName: string, logger: Logger): boolean {
  let scQueryOutput: string;
  try {
    scQueryOutput = execFileSync('sc.exe', ['query', serviceName], {
      encoding: 'utf8',
      stdio: 'pipe'
    });
  } catch (err) {
    // 1060 = ERROR_SERVICE_DOES_NOT_EXIST. Es el caso normal: no hay nada que limpiar.
    const e = err as NodeJS.ErrnoException & { status?: number };
    if (e.status === 1060) {
      return false;
    }
    // Otros errores: probable falta de admin o nombre invalido. Logueamos y dejamos
    // que el flujo principal explote con mensaje mas claro.
    logger.debug(
      { err: e.message, status: e.status },
      'sc.exe query devolvio error inesperado, sigo sin cleanup'
    );
    return false;
  }

  // Si sc.exe query devolvio output con SERVICE_NAME, el servicio existe.
  if (!scQueryOutput.includes('SERVICE_NAME')) {
    return false;
  }

  logger.warn(
    `Servicio "${serviceName}" existe (probable instalacion previa rota con sc.exe). Limpiando antes de reinstalar con NSSM...`
  );

  // 1. Stop (puede fallar si ya estaba stopped — ignoramos).
  try {
    execFileSync('sc.exe', ['stop', serviceName], { stdio: 'pipe' });
    logger.debug(`  · sc.exe stop ${serviceName} OK`);
  } catch {
    // Ignorado: servicio ya estaba detenido o no se pudo detener pero igual lo borramos.
    logger.debug(`  · sc.exe stop ${serviceName} fallo (ignorado)`);
  }

  // 2. Delete (este si nos importa que funcione).
  try {
    execFileSync('sc.exe', ['delete', serviceName], { stdio: 'pipe' });
    logger.info(`  ✓ Servicio previo "${serviceName}" eliminado con sc.exe delete`);
    return true;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
    };
    const detail =
      e.stderr?.toString().trim() ||
      e.stdout?.toString().trim() ||
      e.message;
    throw new Error(
      `No pude borrar el servicio previo "${serviceName}" con sc.exe delete: ${detail}.\n` +
        `Probablemente algun proceso lo tiene abierto. Cerra services.msc si lo tenes abierto y reintenta.`
    );
  }
}

/**
 * Verifica si el servicio ya existe segun NSSM. NSSM `status` devuelve exit
 * code 0 con el estado actual si el servicio existe; exit code != 0 si no
 * existe. Lo usamos despues del cleanup para confirmar que partimos limpios.
 */
function serviceExists(nssm: string, serviceName: string): boolean {
  try {
    execFileSync(nssm, ['status', serviceName], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Instala el agente como servicio Windows en auto-start usando NSSM. Pasos:
 *
 *  1. Valida Windows + admin.
 *  2. Resuelve nssm.exe + el .exe del agente.
 *  3. Limpia instalacion previa rota (sc.exe leftover del bug Sprint 3c).
 *  4. nssm install -> set DisplayName -> set Description -> set Start -> ...
 *  5. Configura logs persistentes (stdout/stderr -> ~/.bait-print-agent/logs).
 *  6. Configura recovery (auto-restart en delay 5s, throttle 60s).
 *  7. nssm start.
 */
export async function installService(opts: InstallServiceOptions): Promise<void> {
  const { logger } = opts;
  await requireAdmin(logger);

  const nssm = getNssmPath();
  const exePath = resolveExePath(opts.exePath);
  const serviceName = opts.serviceName?.trim() || DEFAULT_SERVICE_NAME;
  const serviceDisplay = opts.serviceDisplay?.trim() || DEFAULT_SERVICE_DISPLAY;

  logger.info({ nssm, exePath, serviceName, serviceDisplay }, 'Instalando servicio Windows con NSSM');

  // ------------------------------------------------------------------
  // 1. Cleanup de instalacion previa rota (bug del Sprint 3c).
  //
  // Si el sub-agente previo creo el servicio con `sc.exe create` directo,
  // NSSM no lo reconoce y al hacer `nssm install` tira "service already
  // exists". Limpiamos con sc.exe primero para que el reinstall sea idempotente.
  // ------------------------------------------------------------------
  cleanupBrokenScService(serviceName, logger);

  // ------------------------------------------------------------------
  // 2. Doble-check: ¿quedo limpio?
  //
  // Si despues del cleanup el servicio sigue existiendo, algo raro paso —
  // mejor pedir uninstall manual.
  // ------------------------------------------------------------------
  if (serviceExists(nssm, serviceName)) {
    logger.warn(
      `El servicio "${serviceName}" ya existe segun NSSM. Desinstalalo primero con:\n   bait-print-agent uninstall-service --name ${serviceName}`
    );
    process.exit(1);
  }

  // ------------------------------------------------------------------
  // 3. Install: crear el servicio apuntando al .exe del agente.
  //
  // nssm install <name> <programPath> [args...]
  //
  // No le pasamos args: el agente arranca sin argumentos en modo persistente
  // (lee el config de ~/.bait-print-agent/config.json).
  // ------------------------------------------------------------------
  runNssm(nssm, ['install', serviceName, exePath], logger);
  logger.info(`  ✓ NSSM instalo el servicio (path: ${nssm})`);

  // ------------------------------------------------------------------
  // 4. Display name + descripcion (cosmetico pero util en services.msc).
  // ------------------------------------------------------------------
  runNssm(nssm, ['set', serviceName, 'DisplayName', serviceDisplay], logger);
  runNssm(
    nssm,
    ['set', serviceName, 'Description', DEFAULT_SERVICE_DESCRIPTION],
    logger
  );
  logger.info(`  ✓ DisplayName: ${serviceDisplay}`);

  // ------------------------------------------------------------------
  // 5. Modo de inicio automatico (al boot de Windows).
  //
  // NSSM acepta SERVICE_AUTO_START | SERVICE_DEMAND_START | SERVICE_DISABLED.
  // SERVICE_AUTO_START es el equivalente a sc.exe `start= auto`.
  // ------------------------------------------------------------------
  runNssm(nssm, ['set', serviceName, 'Start', 'SERVICE_AUTO_START'], logger);

  // ------------------------------------------------------------------
  // 6. Logs persistentes con rotacion.
  //
  // AppStdout / AppStderr le dicen a NSSM donde redirigir la salida del
  // subprocess Node. AppRotateFiles=1 habilita la rotacion, AppRotateBytes
  // define el tamano, AppRotateOnline=1 permite rotar sin cortar el flow
  // (NSSM cierra y reabre el archivo al rotar).
  //
  // Resultado:
  //   stdout.log  (actual, hasta 1 MB)
  //   stdout.log.1, stdout.log.2, ...  (rotados)
  //   stderr.log  (actual)
  //   stderr.log.1, ...
  // ------------------------------------------------------------------
  const logsDir = getServiceLogsDir();
  fs.mkdirSync(logsDir, { recursive: true });
  const stdoutLog = path.join(logsDir, 'stdout.log');
  const stderrLog = path.join(logsDir, 'stderr.log');
  runNssm(nssm, ['set', serviceName, 'AppStdout', stdoutLog], logger);
  runNssm(nssm, ['set', serviceName, 'AppStderr', stderrLog], logger);
  runNssm(nssm, ['set', serviceName, 'AppRotateFiles', '1'], logger);
  runNssm(
    nssm,
    ['set', serviceName, 'AppRotateBytes', String(LOG_ROTATE_BYTES)],
    logger
  );
  runNssm(nssm, ['set', serviceName, 'AppRotateOnline', '1'], logger);
  logger.info(`  ✓ Logs en: ${logsDir}`);

  // ------------------------------------------------------------------
  // 7. Recovery: que hacer cuando el proceso termina.
  //
  // AppExit Default Restart  -> reintentar siempre que muera (default behaviour).
  // AppRestartDelay <ms>     -> esperar antes del proximo restart.
  // AppThrottle <ms>         -> si el proceso vive menos que esto, NSSM lo
  //                              considera "fallido" y aplica un backoff
  //                              exponencial al delay para evitar crash-loops.
  // ------------------------------------------------------------------
  runNssm(nssm, ['set', serviceName, 'AppExit', 'Default', 'Restart'], logger);
  runNssm(
    nssm,
    ['set', serviceName, 'AppRestartDelay', String(RESTART_DELAY_MS)],
    logger
  );
  runNssm(
    nssm,
    ['set', serviceName, 'AppThrottle', String(THROTTLE_WINDOW_MS)],
    logger
  );
  logger.info(`  ✓ Auto-restart si crashea (delay ${RESTART_DELAY_MS / 1000}s)`);

  // ------------------------------------------------------------------
  // 8. Arrancar el servicio.
  // ------------------------------------------------------------------
  runNssm(nssm, ['start', serviceName], logger);
  logger.info('  ✓ Servicio iniciado');

  logger.info(
    `✓ Servicio "${serviceName}" instalado y corriendo. Va a arrancar solo cada vez que prendas la PC.\n` +
      `  Estado:    bait-print-agent service-status\n` +
      `  Logs:      ${stdoutLog}\n` +
      `  Desinstalar: bait-print-agent uninstall-service`
  );
}

/**
 * Desinstala el servicio: nssm stop + nssm remove (con `confirm` para
 * skippear el prompt interactivo de NSSM).
 *
 * Si el servicio no existe en NSSM pero si en sc.exe (caso de instalacion
 * previa rota), cae a sc.exe delete como fallback.
 */
export async function uninstallService(opts: UninstallServiceOptions): Promise<void> {
  const { logger } = opts;
  await requireAdmin(logger);

  const serviceName = opts.serviceName?.trim() || DEFAULT_SERVICE_NAME;

  let nssm: string | null = null;
  try {
    nssm = getNssmPath();
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'No encontre nssm.exe; intento fallback con sc.exe delete'
    );
  }

  // Caso 1: NSSM disponible y reconoce el servicio.
  if (nssm && serviceExists(nssm, serviceName)) {
    logger.info({ serviceName }, 'Desinstalando servicio Windows con NSSM');

    // stop puede fallar si ya estaba detenido — lo ignoramos.
    runNssm(nssm, ['stop', serviceName], logger, { ignoreErrors: true });
    logger.info('  ✓ Servicio detenido');

    // remove <name> confirm  evita el prompt interactivo "are you sure?".
    runNssm(nssm, ['remove', serviceName, 'confirm'], logger);
    logger.info(`✓ Servicio ${serviceName} desinstalado.`);
    return;
  }

  // Caso 2: fallback con sc.exe (instalacion previa rota o nssm faltante).
  const cleaned = cleanupBrokenScService(serviceName, logger);
  if (cleaned) {
    logger.info(`✓ Servicio ${serviceName} desinstalado (via sc.exe delete).`);
    return;
  }

  logger.warn(`El servicio "${serviceName}" no esta instalado. Nada que hacer.`);
}

/**
 * Muestra el estado del servicio segun NSSM. No requiere admin (status es
 * read-only en NSSM).
 *
 * NSSM status devuelve strings tipo:
 *   SERVICE_RUNNING
 *   SERVICE_STOPPED
 *   SERVICE_START_PENDING
 *   SERVICE_PAUSED
 *
 * Si el servicio no existe, NSSM sale con exit != 0 y mensaje claro.
 */
export async function serviceStatus(opts: ServiceStatusOptions): Promise<void> {
  const { logger } = opts;
  if (!isWindows()) {
    logger.error('Esta funcion solo funciona en Windows.');
    process.exit(1);
  }

  const serviceName = opts.serviceName?.trim() || DEFAULT_SERVICE_NAME;

  let nssm: string;
  try {
    nssm = getNssmPath();
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'No encontre nssm.exe al lado del .exe'
    );
    process.exit(1);
  }

  // nssm status <name>  -> exit 0 con state si existe, exit != 0 si no.
  let stateRaw: string;
  try {
    stateRaw = execFileSync(nssm, ['status', serviceName], {
      encoding: 'utf8',
      stdio: 'pipe'
    });
  } catch {
    logger.info(
      `El servicio "${serviceName}" no esta instalado.\n   Usa \`bait-print-agent install-service\` (en CMD como Administrador) para instalarlo.`
    );
    return;
  }

  const state = stateRaw.trim() || 'desconocido';
  const logsDir = getServiceLogsDir();

  process.stdout.write(
    [
      `Servicio: ${serviceName}`,
      `Estado:   ${state}`,
      `Logs:     ${logsDir}`,
      ''
    ].join('\n')
  );
}
