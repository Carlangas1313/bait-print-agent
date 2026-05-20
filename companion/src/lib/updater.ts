/**
 * Self-update del companion + servicio: chequea GitHub Releases por la
 * version mas nueva del setup.exe, compara con la version local (companion
 * + servicio) y, si hay update, ofrece descargar + ejecutar el instalador
 * con UAC elevation.
 *
 * El instalador hace todo el resto:
 *  - Anti-zombie taskkill mata el companion + servicio actuales.
 *  - Reemplaza los .exe + nssm.exe.
 *  - El wizard detecta config.json y ofrece "Saltar configuracion".
 *  - Al final relanza el companion (post-install [Run] del .iss).
 *
 * No requiere endpoint nuevo en el agente — toda la logica vive del lado
 * companion. El agente ya tiene su update-checker propio independiente
 * que actualiza solo el servicio, pero ese path no incluye al companion;
 * con este boton, el cliente actualiza TODO el stack en un click.
 */

import { invoke } from "@tauri-apps/api/core";
import packageJson from "../../package.json";

export const COMPANION_VERSION = packageJson.version;

const RELEASES_API =
  "https://api.github.com/repos/Carlangas1313/bait-print-agent/releases/latest";

const SETUP_URL =
  "https://github.com/Carlangas1313/bait-print-agent/releases/latest/download/bait-print-agent-setup.exe";

export interface LatestReleaseInfo {
  /** Version del tag, sin la "v" inicial (ej "0.6.5"). */
  latest_version: string;
  /** ISO timestamp de cuando se publico la release. */
  published_at: string;
  /** URL del release en GitHub (para el "Ver detalles" si hace falta). */
  release_url: string;
  /** URL directa del setup.exe versionado. */
  download_url: string;
}

/**
 * Compara dos versiones semver-ish (mayor.minor.patch). Devuelve negativo si
 * `a < b`, 0 si igual, positivo si `a > b`. Acepta versiones con o sin "v"
 * prefix; cualquier sufijo (pre-release, build metadata) lo ignoramos —
 * para el companion es suficiente comparar core.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): number[] => {
    const clean = v.replace(/^v/, '').split(/[-+]/)[0] ?? '';
    return clean.split('.').map((n) => Number.parseInt(n, 10) || 0);
  };
  const ap = parse(a);
  const bp = parse(b);
  const len = Math.max(ap.length, bp.length);
  for (let i = 0; i < len; i++) {
    const diff = (ap[i] ?? 0) - (bp[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Consulta la GitHub API por la ultima release del repo. La API de releases
 * de GitHub no requiere auth para repos publicos y tiene rate limit de 60
 * requests/hora por IP sin token, sobrado para un boton manual.
 *
 * Devuelve null si la llamada fallo (network down, API rate-limited, etc) —
 * el caller muestra "No pude consultar" en vez de un error rojo.
 */
export async function fetchLatestRelease(): Promise<LatestReleaseInfo | null> {
  try {
    const res = await fetch(RELEASES_API, {
      headers: {
        Accept: 'application/vnd.github+json',
        // Sin auth — repo publico.
      },
    });
    if (!res.ok) {
      console.warn('[updater] GitHub API non-200:', res.status, res.statusText);
      return null;
    }
    const body = (await res.json()) as {
      tag_name?: string;
      published_at?: string;
      html_url?: string;
      assets?: { name?: string; browser_download_url?: string }[];
    };
    const tag = (body.tag_name ?? '').replace(/^v/, '');
    if (!tag) return null;

    // Buscamos el asset del setup.exe versionado, fallback al alias
    // /latest/download/bait-print-agent-setup.exe que el workflow tambien sube.
    const versioned = body.assets?.find(
      (a) => a.name === `bait-print-agent-setup-${tag}.exe`
    );
    const downloadUrl = versioned?.browser_download_url ?? SETUP_URL;

    return {
      latest_version: tag,
      published_at: body.published_at ?? new Date().toISOString(),
      release_url:
        body.html_url ??
        `https://github.com/Carlangas1313/bait-print-agent/releases/tag/v${tag}`,
      download_url: downloadUrl,
    };
  } catch (err) {
    console.warn('[updater] fetchLatestRelease fallo:', err);
    return null;
  }
}

/**
 * Lanza el instalador: la parte Rust descarga el .exe a %TEMP% y lo ejecuta
 * con UAC elevation. El user ve el popup de UAC de Windows, aprueba, y el
 * wizard del setup arranca con anti-zombie habilitado (mata companion +
 * servicio antes de reemplazar archivos).
 *
 * Despues de que el comando termina sin error, el companion deberia cerrarse
 * porque el setup.exe esta a punto de matarlo via taskkill. Hacemos un
 * pequeño delay para que el toast "Lanzando instalador..." sea visible
 * antes de morir.
 */
export async function runInstaller(downloadUrl: string): Promise<void> {
  await invoke<string>('install_update', { downloadUrl });
}
