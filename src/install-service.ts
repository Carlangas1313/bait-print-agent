/**
 * Instalacion/desinstalacion del agente como servicio Windows.
 *
 * El cliente final no tiene por que pegar comandos sc.exe a mano: este modulo
 * envuelve el flujo entero en tres subcomandos (install-service, uninstall-service,
 * service-status). Detecta admin, crea el servicio en modo auto-start, agrega
 * descripcion + recovery policy y arranca el servicio en un solo paso.
 *
 * Nota: el servicio es Windows-only. El agente como tal puede correr en otros
 * OS, pero la instalacion via sc.exe solo aplica a Windows (Sprint 3c).
 */

import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';
import type { Logger } from './logger.js';

const execFileAsync = promisify(execFile);

const DEFAULT_SERVICE_NAME = 'bAItPrintAgent';
const DEFAULT_SERVICE_DISPLAY = 'bAIt Print Agent';
const DEFAULT_SERVICE_DESCRIPTION =
  'Agente local de bait-pos. Procesa la cola de impresion y envia comandas a las impresoras del local.';

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
 * con un ENOENT cuando intentemos llamar a sc.exe.
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
 * Resuelve el path al .exe que vamos a registrar como servicio. Por defecto
 * usa `process.execPath` (el propio .exe que esta corriendo, gracias a Node
 * SEA). Si el usuario pasa --exe-path, validamos que exista y sea .exe.
 *
 * El servicio necesita un binPath absoluto y estable: si registramos un path
 * relativo o un .js sin nada que lo ejecute, sc.exe acepta pero el servicio
 * no arranca nunca.
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
 * Verifica si el servicio ya existe. sc.exe query devuelve exit code != 0
 * cuando no encuentra el servicio (mensaje "El servicio especificado no
 * existe como servicio instalado" en es-CL, o "specified service does not
 * exist as an installed service" en en-US).
 */
async function serviceExists(serviceName: string): Promise<boolean> {
  try {
    await execFileAsync('sc.exe', ['query', serviceName]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ejecuta un comando sc.exe loggeando el output y propagando errores con
 * mensaje claro. sc.exe escribe a stdout (no a stderr) incluso en errores,
 * asi que el mensaje real esta ahi.
 */
async function runSc(args: string[], logger: Logger): Promise<string> {
  try {
    const { stdout } = await execFileAsync('sc.exe', args);
    return stdout;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    const detail = e.stdout?.trim() || e.stderr?.trim() || e.message;
    logger.error({ args, detail }, 'sc.exe fallo');
    throw new Error(`sc.exe ${args.join(' ')} fallo: ${detail}`);
  }
}

/**
 * Instala el agente como servicio Windows en auto-start. Pasos:
 *  1. Valida Windows + admin.
 *  2. Resuelve el .exe (default: process.execPath).
 *  3. Chequea que el servicio no exista ya.
 *  4. sc.exe create -> description -> failure (recovery) -> start.
 *
 * Importante sobre sc.exe syntax: los pares clave/valor llevan ESPACIO
 * despues del `=` (binPath= "...", start= auto). No es un typo, asi lo
 * exige sc.exe — sin el espacio interpreta todo como un solo argumento.
 */
export async function installService(opts: InstallServiceOptions): Promise<void> {
  const { logger } = opts;
  await requireAdmin(logger);

  const exePath = resolveExePath(opts.exePath);
  const serviceName = opts.serviceName?.trim() || DEFAULT_SERVICE_NAME;
  const serviceDisplay = opts.serviceDisplay?.trim() || DEFAULT_SERVICE_DISPLAY;

  logger.info({ exePath, serviceName, serviceDisplay }, 'Instalando servicio Windows');

  // ------------------------------------------------------------------
  // 1. ¿Ya existe?
  // ------------------------------------------------------------------
  if (await serviceExists(serviceName)) {
    logger.warn(
      `El servicio "${serviceName}" ya existe. Desinstalalo primero con:\n   bait-print-agent uninstall-service --name ${serviceName}`
    );
    process.exit(1);
  }

  // ------------------------------------------------------------------
  // 2. Crear el servicio.
  //
  // sc.exe quiere el binPath envuelto en comillas adicionales cuando el path
  // tiene espacios (ej. "C:\Program Files\..."). execFile NO usa shell, asi
  // que las comillas extra van como parte del valor del argumento — Windows
  // Service Manager las desempaqueta correctamente. Sin ellas, un binPath
  // con espacios se rompe en el primer espacio.
  // ------------------------------------------------------------------
  const quotedBinPath = `"${exePath}"`;

  await runSc(
    [
      'create',
      serviceName,
      'binPath=',
      quotedBinPath,
      'start=',
      'auto',
      'displayname=',
      serviceDisplay
    ],
    logger
  );
  logger.info('  ✓ Servicio creado');

  // ------------------------------------------------------------------
  // 3. Descripcion (cosmetica pero util en services.msc).
  // ------------------------------------------------------------------
  await runSc(['description', serviceName, DEFAULT_SERVICE_DESCRIPTION], logger);
  logger.info('  ✓ Descripcion configurada');

  // ------------------------------------------------------------------
  // 4. Recovery: si el agente crashea, Windows lo reinicia hasta 3 veces
  //    esperando 60s entre intentos. El reset= 86400 indica que despues
  //    de 24h sin fallos vuelve a contar desde cero.
  // ------------------------------------------------------------------
  await runSc(
    [
      'failure',
      serviceName,
      'reset=',
      '86400',
      'actions=',
      'restart/60000/restart/60000/restart/60000'
    ],
    logger
  );
  logger.info('  ✓ Recovery configurada (3 reintentos con 60s de espera)');

  // ------------------------------------------------------------------
  // 5. Arrancarlo.
  // ------------------------------------------------------------------
  await runSc(['start', serviceName], logger);
  logger.info('  ✓ Servicio iniciado');

  logger.info(
    `✓ Servicio instalado y corriendo. Va a arrancar solo cada vez que prendas la PC.\n` +
      `  Para ver su estado: bait-print-agent service-status\n` +
      `  Para desinstalarlo: bait-print-agent uninstall-service`
  );
}

/**
 * Desinstala el servicio. Stop + delete. Si ya estaba detenido, ignora el
 * error del stop (sc.exe stop tira si el servicio no esta corriendo).
 */
export async function uninstallService(opts: UninstallServiceOptions): Promise<void> {
  const { logger } = opts;
  await requireAdmin(logger);

  const serviceName = opts.serviceName?.trim() || DEFAULT_SERVICE_NAME;

  if (!(await serviceExists(serviceName))) {
    logger.warn(`El servicio "${serviceName}" no esta instalado. Nada que hacer.`);
    return;
  }

  logger.info({ serviceName }, 'Desinstalando servicio Windows');

  // sc.exe stop puede tirar si ya esta detenido — ese caso es OK.
  try {
    await execFileAsync('sc.exe', ['stop', serviceName]);
    logger.info('  ✓ Servicio detenido');
  } catch {
    logger.info('  · Servicio ya estaba detenido (ignorado)');
  }

  await runSc(['delete', serviceName], logger);
  logger.info(`✓ Servicio ${serviceName} desinstalado.`);
}

/**
 * Muestra el estado del servicio. No requiere admin (sc.exe query es read-only).
 * Parsea la salida de sc.exe y la presenta como una mini-tabla.
 *
 * Formato tipico de sc.exe query (en-US o es-CL, el regex matchea ambos):
 *   SERVICE_NAME: bAItPrintAgent
 *           TYPE               : 10  WIN32_OWN_PROCESS
 *           STATE              : 4  RUNNING
 *           ...
 */
export async function serviceStatus(opts: ServiceStatusOptions): Promise<void> {
  const { logger } = opts;
  if (!isWindows()) {
    logger.error('Esta funcion solo funciona en Windows.');
    process.exit(1);
  }

  const serviceName = opts.serviceName?.trim() || DEFAULT_SERVICE_NAME;

  if (!(await serviceExists(serviceName))) {
    logger.info(
      `El servicio "${serviceName}" no esta instalado.\n   Usa \`bait-print-agent install-service\` (en CMD como Administrador) para instalarlo.`
    );
    return;
  }

  // Para el estado actual usamos query (RUNNING/STOPPED/...).
  const queryOut = await runSc(['query', serviceName], logger);

  // Para el modo de inicio (AUTO_START/DEMAND_START/...) usamos qc, que
  // muestra la config del servicio. Es un comando separado.
  const qcOut = await runSc(['qc', serviceName], logger);

  const state = parseScField(queryOut, /STATE\s*:\s*\d+\s+(\S+)/);
  const startType = parseScField(qcOut, /START_TYPE\s*:\s*\d+\s+(\S+)/);

  process.stdout.write(
    [
      `Servicio: ${serviceName}`,
      `Estado:   ${state ?? 'desconocido'}`,
      `Inicio:   ${startType ?? 'desconocido'}`,
      ''
    ].join('\n')
  );
}

/**
 * Extrae el primer match del grupo 1 de un regex sobre la salida de sc.exe.
 * Devuelve null si no matchea (sc.exe en otro idioma o formato inesperado).
 */
function parseScField(output: string, regex: RegExp): string | null {
  const m = output.match(regex);
  return m ? m[1].trim() : null;
}
