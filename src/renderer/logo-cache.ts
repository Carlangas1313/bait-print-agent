/**
 * Cache del logo del restaurant en el agente.
 *
 * Disenio (ver spec 2026-05-22-print-templates-editor-design.md, D4 + D5):
 *  - El bucket `restaurant-logos` en Supabase es PUBLICO desde mig 064.
 *    Antes era privado y se generaba signed URL on-demand via
 *    `createSignedUrl()`, pero el user del agente (rol `print_agent`) NO
 *    tiene el permiso `restaurant.edit_branding` que exige la RLS de
 *    mig 059. Resultado: `createSignedUrl()` fallaba silenciosamente y el
 *    logo nunca se imprimia. El bucket es publico porque los logos
 *    aparecen en cada ticket que el negocio entrega — no hay secreto.
 *  - La RPC `enqueue_*` NO embebe la URL: solo el `print_logo_path` (path
 *    interno) y el `print_logo_hash` (sha256 truncado de 12 chars).
 *  - El agente recibe ambos en el payload del job. Si el hash coincide con
 *    un archivo cacheado en disco (~/.bait-print-agent/cache/logos/{hash}.png),
 *    cache hit y retornamos el path local sin tocar la red.
 *  - Cache miss: arma la URL publica del bucket y baja el archivo con fetch.
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
 *  - Tira si el fetch responde !ok. El caller (helper `printLogoIfEnabled`)
 *    atrapa el error y lo loguea como warning, sin romper el ticket —
 *    preferimos imprimir sin logo a no imprimir.
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

export type GetLogoPathOptions = {
  /**
   * Override del directorio de cache. Default: `~/.bait-print-agent/cache/logos`.
   * Usado por tests para escribir en `os.tmpdir()` sin contaminar el HOME real.
   */
  cacheDirOverride?: string;
};

/**
 * Resuelve el path LOCAL del logo. Si no esta en cache, lo descarga.
 *
 * Desde mig 064 el bucket es publico, asi que usamos `getPublicUrl()` que
 * no requiere autenticacion. Antes intentabamos `createSignedUrl()` pero
 * fallaba con la RLS para el user del agente (rol `print_agent`).
 *
 * @param storagePath  Path interno en Supabase Storage, ej '{rid}/{hash}-thermal.png'.
 *                     Si null, retorna null (no logo configurado).
 * @param hash         Hash de 12 chars (sha256 truncado) que la mig 058 extrae
 *                     del nombre del archivo. Si null, retorna null (defensivo:
 *                     sin hash no podemos cachear correctamente).
 * @param supabase     Cliente Supabase del agente. Lo usamos solo para construir
 *                     el publicUrl (es deterministic — la url base + el path).
 * @param opts         Opciones (test-only: cacheDirOverride).
 * @returns            Path absoluto al archivo local listo para `tp.printImage(path)`,
 *                     o null si los inputs son insuficientes.
 *
 * @throws             Si el fetch responde !ok. El caller debe atraparlo y
 *                     skipar el logo (no romper).
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

  // Cache miss: bajar desde Storage usando la public URL (mig 064).
  await fs.promises.mkdir(cacheDir, { recursive: true });

  // getPublicUrl no hace nada de red — solo arma la URL base + path.
  // No tira error: si el path es invalido, el fetch de abajo se encarga.
  const { data } = supabase.storage.from(LOGO_BUCKET).getPublicUrl(storagePath);

  if (!data?.publicUrl) {
    throw new Error(`No se pudo armar la public URL para ${storagePath}`);
  }

  const res = await fetch(data.publicUrl);
  if (!res.ok) {
    throw new Error(
      `Logo download failed: ${res.status} ${res.statusText || ''}`.trim(),
    );
  }

  const buf = Buffer.from(await res.arrayBuffer());
  await fs.promises.writeFile(localPath, buf);

  return localPath;
}
