/**
 * Self-update del agente: descarga el .exe nuevo desde GitHub Releases y se
 * reemplaza a si mismo, resolviendo el problema clasico de Windows de "no se
 * puede sobreescribir un .exe en uso".
 *
 * Tecnica usada: "renombrar viejo + colocar nuevo"
 *
 *  1. Descargar el nuevo .exe a `<dir>/bait-print-agent.exe.new`.
 *  2. (Opcional) verificar SHA256 si el release publica un .sha256.
 *  3. Renombrar el .exe actual a `<dir>/bait-print-agent.exe.old.bak` (si ya
 *     existe ese nombre, le sumamos un timestamp para no chocar). Windows
 *     SI permite renombrar un .exe en uso — lo que prohibe es borrarlo.
 *  4. Mover (rename) el `.new` a la posicion del original.
 *  5. Si hay servicio Windows configurado, `sc stop` + `sc start` para que
 *     el SCM levante el binario nuevo (el path en el registry no cambia,
 *     solo el contenido del archivo).
 *  6. Si no hay servicio (modo standalone), spawn detached del nuevo .exe y
 *     `process.exit(0)`.
 *
 * El `.old.bak` queda en disco — el proximo `applyUpdate` lo borra antes de
 * intentar renombrar el siguiente "viejo". Tambien se puede limpiar manual.
 *
 * Limitaciones:
 *  - Windows-only. En otros OS no aplicamos updates (en Linux/macOS el agente
 *    todavia ni siquiera se distribuye como .exe).
 *  - Requiere correr desde el .exe SEA empaquetado, no desde `tsx`/`node dist/...`.
 *    En dev tiramos un error claro.
 *  - El usuario que corre el .exe necesita permisos de escritura en la carpeta
 *    del .exe. Si es servicio, suele correr como SYSTEM y tiene esos permisos.
 *  - Si el servicio NO se puede reiniciar (ej. no somos admin), dejamos el
 *    .exe ya reemplazado y avisamos en logs como restartearlo a mano.
 */

import { execFile } from 'node:child_process';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import type { Logger } from './logger.js';
import type { UpdateInfo } from './update-checker.js';

const execFileAsync = promisify(execFile);

// -------------------------------------------------------------------
// Tunables
// -------------------------------------------------------------------

/**
 * Timeout del fetch para descargar el .exe. 5 min es generoso: el binario
 * pesa ~83 MB y un link rural en Chile puede tardar.
 */
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1_000;

/**
 * Cada cuantos bytes loguear el progreso de descarga. 5 MB es el sweet spot
 * entre "veo que se mueve" y "no spamea logs".
 */
const DOWNLOAD_PROGRESS_CHUNK = 5 * 1024 * 1024;

/**
 * Cuantos segundos esperar tras llamar `sc stop` antes de asumir que el
 * servicio termino. sc.exe stop retorna apenas manda la senial; el proceso
 * puede demorar unos segundos en cerrar.
 */
const SC_STOP_WAIT_MS = 8_000;

/**
 * Para `waitForJobsToFinish`: cuantas tandas de espera hacer.
 */
const PRE_RESTART_WAIT_ATTEMPTS = 3;

/**
 * Para `waitForJobsToFinish`: cuanto esperar entre tandas.
 */
const PRE_RESTART_WAIT_INTERVAL_MS = 10_000;

/**
 * Nombre default del servicio Windows. Tiene que matchear lo que setea
 * `install-service.ts`.
 */
const DEFAULT_SERVICE_NAME = 'bAItPrintAgent';

// -------------------------------------------------------------------
// isUpdateApplyEnabled
// -------------------------------------------------------------------

/**
 * Lee `UPDATE_APPLY_ENABLED` del env. Default: `false` (opt-in).
 *
 * Aceptamos `true`, `1`, `yes`, `on` (case insensitive) como verdadero.
 * Cualquier otra cosa (incluido unset) es falso — preferimos ser conservadores
 * con algo que reemplaza binarios solos.
 */
export function isUpdateApplyEnabled(): boolean {
  const raw = process.env.UPDATE_APPLY_ENABLED?.trim().toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on';
}

// -------------------------------------------------------------------
// downloadAsset
// -------------------------------------------------------------------

export type DownloadOptions = {
  /** URL del asset a bajar (GitHub releases redirect). */
  url: string;
  /** Path absoluto donde guardar el archivo. */
  destPath: string;
  logger: Logger;
};

/**
 * Descarga un binary a disco con streaming. Sigue redirects (fetch los maneja
 * por default). Loguea progreso cada 5 MB para que el operador vea que la
 * descarga avanza, especialmente util en links lentos del local del cliente.
 *
 * Errores: timeout (5 min), HTTP no-ok, falla de write al disco. En cualquiera
 * de esos casos, tiramos con mensaje claro y dejamos el archivo parcial en su
 * lugar para que el caller decida si lo borra (lo borramos en `applyUpdate` al
 * principio del proximo intento — si hay un `.new` quedo de un intento previo
 * fallido, lo pisamos).
 */
export async function downloadAsset(opts: DownloadOptions): Promise<void> {
  const { url, destPath, logger } = opts;

  logger.info({ url, destPath }, 'Descargando asset desde GitHub Releases...');

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      // GitHub redirige el download URL a un blob storage; redirect:'follow'
      // es default pero lo dejamos explicito para claridad.
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': 'bait-print-agent-updater'
      }
    });

    if (!response.ok) {
      throw new Error(
        `GitHub respondio HTTP ${response.status} al bajar el asset. URL: ${url}`
      );
    }

    if (!response.body) {
      throw new Error('Respuesta de GitHub sin body al bajar el asset.');
    }

    const totalBytes = Number(response.headers.get('content-length')) || 0;
    let downloadedBytes = 0;
    let lastLoggedAt = 0;

    // Convertimos el ReadableStream web a Node Readable para usar pipeline.
    const nodeStream = Readable.fromWeb(
      response.body as unknown as Parameters<typeof Readable.fromWeb>[0]
    );

    // Hook para loguear progreso. Lo enganchamos al stream antes del pipeline.
    nodeStream.on('data', (chunk: Buffer) => {
      downloadedBytes += chunk.length;
      if (downloadedBytes - lastLoggedAt >= DOWNLOAD_PROGRESS_CHUNK) {
        lastLoggedAt = downloadedBytes;
        const mb = (downloadedBytes / (1024 * 1024)).toFixed(1);
        if (totalBytes > 0) {
          const total = (totalBytes / (1024 * 1024)).toFixed(1);
          const pct = ((downloadedBytes / totalBytes) * 100).toFixed(1);
          logger.info(`  ... descargados ${mb} MB de ${total} MB (${pct}%)`);
        } else {
          logger.info(`  ... descargados ${mb} MB`);
        }
      }
    });

    await pipeline(nodeStream, createWriteStream(destPath));

    const finalMb = (downloadedBytes / (1024 * 1024)).toFixed(1);
    logger.info({ destPath, bytes: downloadedBytes }, `Descarga completa (${finalMb} MB)`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (controller.signal.aborted) {
      throw new Error(
        `Timeout descargando el asset (${DOWNLOAD_TIMEOUT_MS / 1000}s). ` +
          `Verifica la conexion a internet del local y reintenta. URL: ${url}`
      );
    }
    throw new Error(`Fallo descargando ${url}: ${msg}`);
  } finally {
    clearTimeout(timeoutId);
  }
}

// -------------------------------------------------------------------
// verifyChecksum
// -------------------------------------------------------------------

/**
 * Calcula el SHA256 de un archivo en disco y lo compara con el esperado.
 * Lee en streaming asi que funciona OK con el .exe de 83 MB sin cargarlo
 * entero en memoria.
 *
 * Returns true si matchea, false si no. NO tira en caso de mismatch — el
 * caller decide que hacer (en `autoUpdate` lo tratamos como error fatal).
 */
export async function verifyChecksum(
  filePath: string,
  expectedSha256: string
): Promise<boolean> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(filePath), hash);
  const actual = hash.digest('hex').toLowerCase();
  const expected = expectedSha256.trim().toLowerCase();
  return actual === expected;
}

/**
 * Extrae el hash del contenido de un archivo `.sha256` estilo `sha256sum`:
 * "<hash> <filename>" o solo "<hash>". Devuelve null si no parsea.
 */
function parseSha256File(content: string): string | null {
  const trimmed = content.trim();
  if (!trimmed) return null;
  // Tomamos la primera "palabra" — si es 64 hex chars, es nuestro hash.
  const firstToken = trimmed.split(/\s+/)[0];
  if (/^[a-f0-9]{64}$/i.test(firstToken)) {
    return firstToken;
  }
  return null;
}

// -------------------------------------------------------------------
// applyUpdate
// -------------------------------------------------------------------

export type ApplyUpdateOptions = {
  /** Path al .exe nuevo ya descargado (ej. `.../bait-print-agent.exe.new`). */
  newExePath: string;
  /** Path al .exe actual que se va a reemplazar. */
  currentExePath: string;
  /** Si esta seteado, intentamos `sc stop`/`sc start` con este nombre. */
  serviceName?: string;
  logger: Logger;
};

/**
 * Aplica el reemplazo del .exe segun la tecnica "renombrar viejo + colocar
 * nuevo". Ver el comentario en el header del archivo para los pasos.
 *
 * Si algo falla en el medio, hace best-effort para restaurar el .exe original
 * (rename back). Si el restore tambien falla, dejamos instrucciones claras
 * en el log para recovery manual.
 */
export async function applyUpdate(opts: ApplyUpdateOptions): Promise<void> {
  const { newExePath, currentExePath, serviceName, logger } = opts;

  // ------------------------------------------------------------------
  // 1. Validar entorno
  // ------------------------------------------------------------------
  if (process.platform !== 'win32') {
    throw new Error(
      'Auto-update solo soportado en Windows por ahora. ' +
        'En otros OS, reemplaza el binario a mano.'
    );
  }

  if (!currentExePath.toLowerCase().endsWith('.exe')) {
    throw new Error(
      `Auto-update solo aplica al .exe empaquetado, no a tsx/node dev. ` +
        `currentExePath=${currentExePath}`
    );
  }

  // Sanity: el nuevo .exe tiene que existir.
  const newStat = await fs.stat(newExePath).catch(() => null);
  if (!newStat || !newStat.isFile()) {
    throw new Error(`El archivo nuevo no existe: ${newExePath}`);
  }

  // ------------------------------------------------------------------
  // 2. Limpiar backups viejos previos (best-effort)
  // ------------------------------------------------------------------
  // Si quedo un .old.bak de un intento anterior, lo borramos para no
  // ensuciar el directorio. Si Windows todavia lo tiene "lock" por algun
  // proceso huerfano, le sumamos timestamp mas abajo y seguimos.
  const primaryBackupPath = `${currentExePath}.old.bak`;
  let backupPath = primaryBackupPath;
  try {
    await fs.unlink(primaryBackupPath);
    logger.debug({ primaryBackupPath }, 'Backup previo eliminado');
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== 'ENOENT') {
      // No se pudo borrar — probablemente todavia este "en uso" por el ciclo
      // anterior. Usamos timestamp para evitar el conflicto.
      backupPath = `${currentExePath}.old.bak.${Date.now()}`;
      logger.warn(
        { primaryBackupPath, err: e.message, backupPath },
        'No se pudo borrar el backup anterior, usando nombre con timestamp'
      );
    }
  }

  // ------------------------------------------------------------------
  // 3. Renombrar viejo a .old.bak (Windows si permite renombrar .exe en uso)
  // ------------------------------------------------------------------
  let renamedOld = false;
  try {
    await fs.rename(currentExePath, backupPath);
    renamedOld = true;
    logger.info({ from: currentExePath, to: backupPath }, '✓ .exe viejo renombrado a backup');
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    throw new Error(
      `No se pudo renombrar el .exe actual (${currentExePath}): ${e.message}. ` +
        `Esto es raro en Windows — chequea permisos de escritura en la carpeta.`
    );
  }

  // ------------------------------------------------------------------
  // 4. Mover el .new a la posicion del original
  // ------------------------------------------------------------------
  try {
    await fs.rename(newExePath, currentExePath);
    logger.info({ from: newExePath, to: currentExePath }, '✓ .exe nuevo colocado');
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    // Intentar restaurar el viejo.
    if (renamedOld) {
      try {
        await fs.rename(backupPath, currentExePath);
        logger.warn(
          { restored: currentExePath },
          'Fallo colocar el nuevo .exe; restauramos el viejo desde backup'
        );
      } catch (restoreErr) {
        const re = restoreErr as Error;
        logger.fatal(
          {
            currentExePath,
            backupPath,
            originalError: e.message,
            restoreError: re.message
          },
          'FALLO CRITICO: no se pudo colocar el .exe nuevo NI restaurar el viejo. ' +
            `Recovery manual: renombra "${backupPath}" a "${currentExePath}" desde un CMD como admin.`
        );
      }
    }
    throw new Error(
      `No se pudo mover el .exe nuevo a su posicion final: ${e.message}`
    );
  }

  // ------------------------------------------------------------------
  // 5. Reiniciar servicio o relanzar standalone
  // ------------------------------------------------------------------
  if (serviceName) {
    await restartWindowsService(serviceName, logger);
  } else {
    await relaunchStandalone(currentExePath, logger);
  }
}

/**
 * `sc stop <name>` con espera + `sc start <name>`. Cada paso loggea su
 * resultado. Si stop falla porque ya estaba detenido, lo ignoramos. Si start
 * falla, lo logueamos con instrucciones de fix manual — el reemplazo del
 * binario ya quedo OK, solo falta levantarlo.
 */
async function restartWindowsService(serviceName: string, logger: Logger): Promise<void> {
  logger.info({ serviceName }, 'Reiniciando servicio Windows...');

  try {
    await execFileAsync('sc.exe', ['stop', serviceName]);
    logger.info(`  ✓ Servicio ${serviceName} detenido`);
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string };
    // Si ya estaba stopped, sc.exe tira con un mensaje claro. Lo ignoramos.
    const detail = e.stdout?.trim() ?? e.message;
    if (detail.toLowerCase().includes('1062') || detail.toLowerCase().includes('no se ha iniciado')) {
      logger.info(`  · Servicio ${serviceName} ya estaba detenido`);
    } else {
      logger.warn(
        { serviceName, detail },
        `sc stop fallo. Si no eres admin, reinicialo manual con \`sc start ${serviceName}\` en CMD elevado.`
      );
    }
  }

  // Esperamos un toque para que el proceso termine de cerrar antes del start.
  // sc.exe stop retorna apenas envia la senal, no espera que el proceso muera.
  await new Promise((resolve) => setTimeout(resolve, SC_STOP_WAIT_MS));

  try {
    await execFileAsync('sc.exe', ['start', serviceName]);
    logger.info(`  ✓ Servicio ${serviceName} iniciado con el binario nuevo`);
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string };
    const detail = e.stdout?.trim() ?? e.message;
    logger.error(
      { serviceName, detail },
      `FALLO al iniciar el servicio. El binario nuevo YA esta en su lugar. ` +
        `Reinicialo manual con: sc start ${serviceName} (en CMD como Administrador).`
    );
    throw new Error(`sc start ${serviceName} fallo: ${detail}`);
  }
}

/**
 * Para el modo standalone (sin servicio): spawn detached del nuevo .exe y
 * exit del proceso actual. El SO se encarga de cerrar el viejo cuando
 * `process.exit(0)` corre.
 */
async function relaunchStandalone(newExePath: string, logger: Logger): Promise<void> {
  logger.info({ newExePath }, 'Relanzando agente en modo standalone...');

  const child = spawn(newExePath, process.argv.slice(2), {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  });
  child.unref();

  logger.info('  ✓ Nuevo proceso lanzado. Saliendo del proceso actual.');

  // Un pequeño delay para que el log se flushee antes de morir.
  await new Promise((resolve) => setTimeout(resolve, 500));
  process.exit(0);
}

// -------------------------------------------------------------------
// waitForJobsToFinish (helper opcional)
// -------------------------------------------------------------------

/**
 * Cliente Supabase minimo que esperamos para chequear jobs in-flight. Solo
 * tipamos lo que usamos (el `.from(...).select(...).eq(...)`). Acepta el
 * cliente real de @supabase/supabase-js sin que tengamos que importarlo.
 */
type MinimalSupabase = {
  from: (table: string) => {
    select: (
      columns: string,
      options?: { count?: 'exact'; head?: boolean }
    ) => {
      eq: (
        column: string,
        value: string
      ) => Promise<{ count: number | null; error: unknown }> & {
        eq: (
          column: string,
          value: string
        ) => Promise<{ count: number | null; error: unknown }>;
      };
    };
  };
};

export type WaitForJobsOptions = {
  supabase: MinimalSupabase;
  locationId: string;
  logger: Logger;
};

/**
 * Antes de hacer `sc stop`, espera a que no haya jobs en estado `printing`
 * para la location actual. Hace hasta 3 intentos espaciados por 10s; si
 * tras eso siguen habiendo jobs en vuelo, sigue de todas formas (no podemos
 * esperar para siempre).
 *
 * Es best-effort: si el query a Supabase falla por cualquier motivo, logueamos
 * warn y seguimos. NO queremos que un caprichito de red bloquee el update.
 */
export async function waitForJobsToFinish(opts: WaitForJobsOptions): Promise<void> {
  const { supabase, locationId, logger } = opts;

  for (let attempt = 1; attempt <= PRE_RESTART_WAIT_ATTEMPTS; attempt++) {
    try {
      // El chain real de PostgrestBuilder tiene tipos más complejos pero
      // estructuralmente nuestro MinimalSupabase matchea. Casteamos a unknown
      // primero para evitar que TS chille por el tipo no exacto del .eq()
      // encadenado dos veces.
      const builder = supabase
        .from('print_jobs')
        .select('id', { count: 'exact', head: true })
        .eq('location_id', locationId);
      const { count, error } = await (builder as unknown as Promise<{
        count: number | null;
        error: unknown;
      }> & {
        eq: (
          column: string,
          value: string
        ) => Promise<{ count: number | null; error: unknown }>;
      }).eq('status', 'printing');

      if (error) {
        logger.warn({ err: error }, 'No se pudo consultar jobs in-flight, sigo igual');
        return;
      }

      const inFlight = count ?? 0;
      if (inFlight === 0) {
        logger.debug('No hay jobs in-flight, listo para reiniciar');
        return;
      }

      logger.info(
        { inFlight, attempt, max: PRE_RESTART_WAIT_ATTEMPTS },
        `Esperando ${inFlight} job(s) in-flight antes de aplicar update...`
      );

      if (attempt < PRE_RESTART_WAIT_ATTEMPTS) {
        await new Promise((resolve) =>
          setTimeout(resolve, PRE_RESTART_WAIT_INTERVAL_MS)
        );
      } else {
        logger.warn(
          { inFlight },
          'Sigue habiendo jobs in-flight tras la espera maxima; aplico update igual'
        );
      }
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'Error consultando jobs in-flight, sigo igual'
      );
      return;
    }
  }
}

// -------------------------------------------------------------------
// autoUpdate
// -------------------------------------------------------------------

export type AutoUpdateOptions = {
  updateInfo: UpdateInfo;
  logger: Logger;
  /** Nombre del servicio Windows si el agente corre como tal. */
  serviceName?: string;
  /**
   * Cliente Supabase + location_id para esperar jobs in-flight antes del
   * restart. Opcional — si no se provee, skipeamos la espera.
   */
  preRestart?: {
    supabase: MinimalSupabase;
    locationId: string;
  };
};

/**
 * Orquesta el update completo: descarga, (opcional) verifica checksum,
 * espera jobs in-flight, aplica el reemplazo, reinicia servicio.
 *
 * Es la funcion "high level" — el caller (CLI manual o periodic check)
 * solo arma el `UpdateInfo` y llama esto.
 */
export async function autoUpdate(opts: AutoUpdateOptions): Promise<void> {
  const { updateInfo, logger, serviceName, preRestart } = opts;

  logger.info(
    {
      version: updateInfo.latestVersion,
      url: updateInfo.downloadUrl
    },
    `Aplicando update a v${updateInfo.latestVersion}...`
  );

  // ------------------------------------------------------------------
  // 1. Validaciones de entorno antes de descargar nada
  // ------------------------------------------------------------------
  if (process.platform !== 'win32') {
    throw new Error(
      'Auto-update solo soportado en Windows por ahora. ' +
        'En otros OS, reemplaza el binario a mano.'
    );
  }

  const currentExePath = process.execPath;
  if (!currentExePath.toLowerCase().endsWith('.exe')) {
    throw new Error(
      `Auto-update solo aplica al .exe empaquetado, no a tsx/node dev. ` +
        `process.execPath=${currentExePath}. Si estas en dev, este flow no aplica.`
    );
  }

  const exeDir = path.dirname(currentExePath);
  const exeName = path.basename(currentExePath);
  const newExePath = path.join(exeDir, `${exeName}.new`);
  const shaPath = path.join(exeDir, `${exeName}.new.sha256`);

  // Limpiar restos de intentos previos.
  await fs.unlink(newExePath).catch(() => undefined);
  await fs.unlink(shaPath).catch(() => undefined);

  // ------------------------------------------------------------------
  // 2. Descargar el .exe nuevo
  // ------------------------------------------------------------------
  await downloadAsset({
    url: updateInfo.downloadUrl,
    destPath: newExePath,
    logger
  });

  // ------------------------------------------------------------------
  // 3. (Opcional) Verificar checksum si el release tiene .sha256
  // ------------------------------------------------------------------
  // Convencion: si el .exe es `foo.exe`, el sha vive en `foo.exe.sha256`
  // como asset del mismo release. Calculamos el URL del sha cambiando la
  // ultima parte del downloadUrl.
  const shaDownloadUrl = `${updateInfo.downloadUrl}.sha256`;
  let shaDownloaded = false;
  try {
    await downloadAsset({
      url: shaDownloadUrl,
      destPath: shaPath,
      logger
    });
    shaDownloaded = true;
  } catch (err) {
    // Si el release no incluye el .sha256, no es fatal — solo loggeamos warn
    // y seguimos sin verificar. La integridad queda confiando en HTTPS de
    // GitHub, que ya es bastante.
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'Release no incluye .sha256 (o fallo bajarlo); sigo sin verificar checksum'
    );
  }

  if (shaDownloaded) {
    const shaContent = await fs.readFile(shaPath, 'utf-8');
    const expected = parseSha256File(shaContent);
    if (!expected) {
      logger.warn(
        { shaContent: shaContent.slice(0, 200) },
        'El .sha256 no tiene un hash valido (esperaba 64 hex chars); sigo sin verificar'
      );
    } else {
      logger.info('Verificando SHA256 del .exe descargado...');
      const ok = await verifyChecksum(newExePath, expected);
      if (!ok) {
        // Limpiamos el archivo corrupto y abortamos.
        await fs.unlink(newExePath).catch(() => undefined);
        await fs.unlink(shaPath).catch(() => undefined);
        throw new Error(
          'Checksum SHA256 NO matchea — descarga corrupta o tampered. Aborto el update.'
        );
      }
      logger.info('  ✓ Checksum OK');
    }
    // Limpiamos el .sha256, ya no lo necesitamos.
    await fs.unlink(shaPath).catch(() => undefined);
  }

  // ------------------------------------------------------------------
  // 4. (Opcional) Esperar jobs in-flight
  // ------------------------------------------------------------------
  if (preRestart) {
    await waitForJobsToFinish({
      supabase: preRestart.supabase,
      locationId: preRestart.locationId,
      logger
    });
  }

  // ------------------------------------------------------------------
  // 5. Aplicar el reemplazo
  // ------------------------------------------------------------------
  const effectiveServiceName = serviceName ?? DEFAULT_SERVICE_NAME;
  await applyUpdate({
    newExePath,
    currentExePath,
    serviceName: effectiveServiceName,
    logger
  });

  logger.info(
    { version: updateInfo.latestVersion },
    `✓ Update aplicado. Nueva version: v${updateInfo.latestVersion}. El servicio se reinicio.`
  );
}
