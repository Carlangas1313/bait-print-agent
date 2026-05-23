/**
 * Captura de jobs USB exitosos a archivos .txt humano-legibles.
 *
 * Sensor de diagnostico (v0.9.6): cada vez que el agente termina un job en
 * USB via `sendUsbViaSpooler`, llama a `captureJob(...)` que:
 *
 *  1. Decodea el buffer ESC/POS a texto plano con tags inline (`decodeEscPos`).
 *  2. Lo guarda en `~/.bait-print-agent/captures/{ISO}_{jobId}_{type}.txt`.
 *  3. Rota: mantiene los ultimos N archivos y borra el resto.
 *
 * Asi un operador (humano o Claude) puede preguntar "que imprimio el agente
 * en el ultimo job kitchen_order" y abrir el .txt sin tener el papel fisico.
 *
 * Toggle:
 *  - `BAIT_PRINT_CAPTURE_ENABLED=true` ACTIVA. Default: false (off en
 *    produccion). Decision Carlos 2026-05-23: en produccion los archivos
 *    contienen datos sensibles (nombres clientes, items, totales) y el
 *    99% del tiempo no aportan. Se activa on-demand para sesiones de
 *    diagnostico: `nssm set bAItPrintAgent AppEnvironmentExtra BAIT_PRINT_CAPTURE_ENABLED=true`
 *    + restart del servicio, luego apagar y limpiar.
 *
 * Si la captura falla (disco lleno, permisos), NO interrumpimos el flow del
 * job — el ticket ya se imprimio, no queremos marcar el job como failed por
 * un problema del sensor. Logueamos warn y seguimos.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Logger } from '../logger.js';
import { decodeEscPos } from './escpos-decoder.js';

/**
 * Cantidad maxima de archivos que conservamos en el directorio de captures.
 * Al exceder, borramos los mas viejos (mtime asc) hasta volver a quedar bajo
 * el umbral. Default 30, suficiente para revisar varias sesiones recientes
 * de trabajo sin llenar el disco.
 */
const MAX_CAPTURES = 30;

/**
 * Directorio donde guardamos los .txt. Misma raiz que el cache de logos
 * (`~/.bait-print-agent/`) para que todo el estado local del agente viva
 * bajo un solo arbol facil de auditar/borrar.
 *
 * Calculado una vez por proceso para no pegarle a `os.homedir()` en cada
 * captura.
 */
const CAPTURES_DIR = path.join(os.homedir(), '.bait-print-agent', 'captures');

/**
 * Devuelve la ruta absoluta del directorio de captures. Exportada para que
 * el agente loguee al arrancar donde van a quedar los archivos (asi el
 * operador sabe donde buscar).
 */
export function getCapturesDir(): string {
  return CAPTURES_DIR;
}

/**
 * Lee la env var de toggle. Default FALSE (capture OFF en produccion).
 *
 * Acepta: 'true', '1', 'yes', 'on' (case insensitive) → enable.
 * Cualquier otro valor (incluyendo no setear nada) → disable.
 *
 * Para activar en produccion (sesion de diagnostico):
 *   nssm set bAItPrintAgent AppEnvironmentExtra BAIT_PRINT_CAPTURE_ENABLED=true
 *   nssm restart bAItPrintAgent
 * Y para apagar despues:
 *   nssm set bAItPrintAgent AppEnvironmentExtra BAIT_PRINT_CAPTURE_ENABLED=false
 *   nssm restart bAItPrintAgent
 */
export function isCaptureEnabled(): boolean {
  const raw = process.env.BAIT_PRINT_CAPTURE_ENABLED?.trim().toLowerCase();
  if (raw === undefined || raw === '') return false;
  return ['true', '1', 'yes', 'on'].includes(raw);
}

/**
 * Sanitiza un fragment para que sea seguro usarlo como parte de un filename
 * en Windows/macOS/Linux. Reemplaza caracteres prohibidos (\\, /, :, *, ?,
 * ", <, >, |) y trim de espacios.
 *
 * No quita acentos ni nada cosmetico — solo lo que romperia el fs.writeFile.
 */
function sanitizeForFilename(s: string): string {
  return s
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '-')
    .replace(/_+/g, '_')
    .slice(0, 80); // cap a 80 chars por segmento para evitar paths >255 en Windows
}

/**
 * Reemplaza chars no validos del timestamp ISO para usarlo como prefijo de
 * filename. Reemplaza ':' por '-' porque Windows no lo permite en filenames,
 * y trunca los milisegundos a 3 digitos.
 *
 * Ej: '2026-05-23T14:32:01.123Z' → '2026-05-23T14-32-01.123Z'
 */
function sanitizeTimestamp(iso: string): string {
  return iso.replace(/:/g, '-');
}

/**
 * Captura un job a un .txt en el directorio de captures.
 *
 * Es no-throwing por contrato: si algo falla, se loguea warn y se sigue. El
 * caller no necesita try/catch — el sensor NUNCA debe romper el flow de
 * impresion.
 *
 * Parametros:
 *  - jobId: uuid del job (de print_jobs.id) o un id sintetico para test page.
 *  - jobType: discrimina el .txt (kitchen_order, bill_preview, etc o 'test').
 *  - style: estilo de print_options (classic/minimal/brand/thermal_pro) o
 *    null si no aplica (test page, jobs sin print_options).
 *  - buffer: el buffer ESC/POS que se mando al spooler.
 *  - logger: para warn si falla.
 */
export async function captureJob(
  jobId: string,
  jobType: string,
  style: string | null,
  buffer: Buffer,
  logger: Logger
): Promise<void> {
  if (!isCaptureEnabled()) {
    return;
  }

  try {
    // Asegurar dir. `recursive: true` no falla si ya existe.
    await fs.mkdir(CAPTURES_DIR, { recursive: true });

    // Rotar PRIMERO. Asi si la captura tarda en escribir, el resto del flow
    // del job ya termino y no quedamos manteniendo archivos viejos.
    await rotateOldCaptures(logger);

    const decoded = decodeEscPos(buffer);

    const iso = new Date().toISOString();
    const filename = buildCaptureFilename(iso, jobId, jobType);
    const fullPath = path.join(CAPTURES_DIR, filename);

    const header = buildHeader(jobId, jobType, style, iso, buffer.length);
    const content = `${header}\n${decoded}`;

    await fs.writeFile(fullPath, content, { encoding: 'utf8' });

    logger.debug(
      { jobId, jobType, captureFile: fullPath, bytes: buffer.length },
      'Captura ESC/POS escrita'
    );
  } catch (err) {
    // No tiramos. La captura es best-effort.
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(
      { jobId, jobType, err: msg },
      'No pude escribir captura ESC/POS (el job en si esta OK, ignorando)'
    );
  }
}

/**
 * Construye el nombre del archivo. Formato:
 *   `{ISO_sanitizado}_{jobId_sanitizado}_{jobType_sanitizado}.txt`
 *
 * Ej: `2026-05-23T14-32-01.123Z_abc12345-ef67_kitchen_order.txt`
 *
 * El sort lexicografico de los archivos coincide con el orden cronologico
 * (timestamps ISO ordenan asc por defecto). Asi la rotacion por mtime y por
 * nombre dan el mismo resultado — pero usamos mtime por confiabilidad ante
 * relojes del sistema desincronizados.
 */
function buildCaptureFilename(iso: string, jobId: string, jobType: string): string {
  const ts = sanitizeTimestamp(iso);
  const idShort = sanitizeForFilename(jobId).slice(0, 36);
  const typeClean = sanitizeForFilename(jobType);
  return `${ts}_${idShort}_${typeClean}.txt`;
}

/**
 * Construye el header del .txt con metadata del job.
 *
 * El operador (humano o Claude) abre el .txt y ve un comentario tipo `# Job
 * xxx | Type: kitchen_order | Style: classic | Captured: 2026-...` antes
 * del contenido decodeado. Permite identificar la captura sin tener que
 * inferir desde el filename.
 */
function buildHeader(
  jobId: string,
  jobType: string,
  style: string | null,
  iso: string,
  bufferBytes: number
): string {
  const styleStr = style ?? '(default)';
  return [
    `# Job ${jobId} | Type: ${jobType} | Style: ${styleStr} | Captured: ${iso}`,
    `# Buffer: ${bufferBytes} bytes ESC/POS`,
    `# ----------------------------------------------------------`
  ].join('\n');
}

/**
 * Borra los archivos mas viejos del directorio de captures hasta dejar como
 * mucho `MAX_CAPTURES` en total. Si hay menos, no hace nada.
 *
 * Ordena por mtime ascendente (mas viejo primero) y borra desde el inicio
 * hasta que la cuenta vuelva a quedar bajo el cap. Usa mtime y no nombre
 * porque es robusto ante files renombrados a mano o ante relojes saltando
 * para atras.
 *
 * Best-effort: si un unlink falla (file lockeado, etc), loguea debug y
 * sigue con el siguiente. No bloqueamos el flow por una limpieza fallida.
 */
async function rotateOldCaptures(logger: Logger): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(CAPTURES_DIR);
  } catch (err) {
    // Si el dir no existe todavia o no podemos leerlo, no hay nada que rotar.
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      logger.debug({ err: String(err) }, 'No pude listar dir de captures (skip rotation)');
    }
    return;
  }

  // Solo .txt (defensivo: si alguien deja un .DS_Store o un .bin viejo, no lo
  // tocamos).
  const txts = entries.filter((f) => f.toLowerCase().endsWith('.txt'));
  if (txts.length < MAX_CAPTURES) {
    return;
  }

  // Stat todos para ordenar por mtime. En paralelo (capturas tipicas <100
  // archivos, fs.stat es cheap).
  const stats = await Promise.all(
    txts.map(async (name) => {
      try {
        const st = await fs.stat(path.join(CAPTURES_DIR, name));
        return { name, mtimeMs: st.mtimeMs };
      } catch {
        // Si fallo stat (race con otro proceso borrando), ignoramos.
        return null;
      }
    })
  );

  const valid = stats.filter((s): s is { name: string; mtimeMs: number } => s !== null);
  valid.sort((a, b) => a.mtimeMs - b.mtimeMs); // mas viejo primero

  // Cuantos sobran (incluyendo el que vamos a escribir ahora — por eso usamos
  // MAX_CAPTURES - 1 como target, dejando lugar para el nuevo).
  const targetCount = MAX_CAPTURES - 1;
  const toDelete = valid.length - targetCount;
  if (toDelete <= 0) return;

  for (let i = 0; i < toDelete; i++) {
    const entry = valid[i];
    if (!entry) continue;
    try {
      await fs.unlink(path.join(CAPTURES_DIR, entry.name));
    } catch (err) {
      logger.debug(
        { file: entry.name, err: String(err) },
        'No pude borrar captura vieja (sigo con la siguiente)'
      );
    }
  }
}
