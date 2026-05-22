/**
 * Cache del logo del restaurant en el agente.
 *
 * Disenio (ver spec 2026-05-22-print-templates-editor-design.md, D4 + D5):
 *  - El bucket `restaurant-logos` en Supabase es PRIVADO (RLS via permiso
 *    granular `restaurant.edit_branding`). La RPC enqueue_* NO embebe la
 *    signed URL — solo el `print_logo_path` (path interno) y el
 *    `print_logo_hash` (sha256 truncado).
 *  - El agente recibe ambos en el payload del job. Si el hash coincide con
 *    un archivo cacheado en disco (~/.bait-print-agent/cache/logos/{hash}.png),
 *    cache hit y retornamos el path local sin tocar la red.
 *  - Cache miss: genera signed URL via `supabase.storage.from(bucket).createSignedUrl()`,
 *    baja con fetch, escribe el archivo y retorna el path.
 *
 * Por que hash-based cache y no ETag:
 *  - El hash es del contenido del archivo (el path mismo lo incluye, ej:
 *    `{rid}/{sha256_first12}-thermal.png`). Si el contenido cambia, el path
 *    cambia, asi que diferentes archivos nunca colisionan.
 *  - No requiere HEAD adicional al CDN como ETag.
 *  - No requiere invalidacion coordinada — viejos archivos quedan en disco
 *    pero nunca se referencian de nuevo (cleanup es out-of-scope; el cache
 *    crece despacio porque el dueño no cambia logo cada dia).
 *
 * Errors:
 *  - Tira si createSignedUrl falla o si el fetch responde !ok. El caller
 *    (helper `printLogoIfEnabled`) atrapa el error y lo loguea como warning,
 *    sin romper el ticket — preferimos imprimir sin logo a no imprimir.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Bucket privado donde viven los logos thermal-ready (dithered 1-bit, 384px ancho).
 * El nombre debe coincidir con el bucket creado en mig 058 de bait-pos.
 */
const LOGO_BUCKET = 'restaurant-logos';

/**
 * Default cache dir: `~/.bait-print-agent/cache/logos/`. Los tests pueden
 * override via `cacheDirOverride` para evitar tocar el $HOME real.
 */
function defaultCacheDir(): string {
  return path.join(os.homedir(), '.bait-print-agent', 'cache', 'logos');
}

/**
 * TTL del signed URL en segundos. 1 hora alcanza con margen: el agente baja
 * el archivo en menos de 5s tipicamente. Si extiende mas (cache miss + red
 * lenta), igual hay buffer.
 */
const SIGNED_URL_TTL_SEC = 3600;

export type GetLogoPathOptions = {
  /**
   * Override del directorio de cache. Default: `~/.bait-print-agent/cache/logos`.
   * Usado por tests para escribir en `os.tmpdir()` sin contaminar el HOME real.
   */
  cacheDirOverride?: string;
};

/**
 * Resuelve el path LOCAL del logo. Si cachea, lo descarga primero.
 *
 * @param storagePath  Path interno en Supabase Storage, ej '{rid}/{hash}-thermal.png'.
 *                     Si null, retorna null (no logo configurado).
 * @param hash         Hash de 12 chars (sha256 truncado) que la mig 058 extrae
 *                     del nombre del archivo. Si null, retorna null (defensivo:
 *                     sin hash no podemos cachear correctamente).
 * @param supabase     Cliente Supabase autenticado del agente (mismo que usa
 *                     Realtime + heartbeat — RLS aplica como user normal).
 * @param opts         Opciones (test-only: cacheDirOverride).
 * @returns            Path absoluto al archivo local listo para `tp.printImage(path)`,
 *                     o null si los inputs son insuficientes.
 *
 * @throws             Si createSignedUrl falla o si el fetch responde !ok.
 *                     El caller debe atraparlo y skipar el logo (no romper).
 */
export async function getLogoPath(
  storagePath: string | null | undefined,
  hash: string | null | undefined,
  supabase: SupabaseClient,
  opts: GetLogoPathOptions = {},
): Promise<string | null> {
  // Defensive: sin path o sin hash no podemos cachear ni bajar correctamente.
  if (!storagePath || !hash) {
    return null;
  }

  const cacheDir = opts.cacheDirOverride ?? defaultCacheDir();
  const localPath = path.join(cacheDir, `${hash}.png`);

  // Cache hit: el hash es del contenido, asi que matchea = mismo archivo.
  if (fs.existsSync(localPath)) {
    return localPath;
  }

  // Cache miss: bajar desde Storage.
  await fs.promises.mkdir(cacheDir, { recursive: true });

  const { data, error } = await supabase.storage
    .from(LOGO_BUCKET)
    .createSignedUrl(storagePath, SIGNED_URL_TTL_SEC);

  if (error || !data?.signedUrl) {
    throw new Error(
      `Signed URL failed for ${storagePath}: ${error?.message ?? 'no signedUrl in response'}`,
    );
  }

  const res = await fetch(data.signedUrl);
  if (!res.ok) {
    throw new Error(`Logo download failed: ${res.status} ${res.statusText || ''}`.trim());
  }

  const buf = Buffer.from(await res.arrayBuffer());
  await fs.promises.writeFile(localPath, buf);

  return localPath;
}
