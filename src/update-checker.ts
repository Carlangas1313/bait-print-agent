/**
 * Checker de updates contra GitHub Releases.
 *
 * Periodicamente (default 1 vez por hora) consulta el endpoint
 *   GET https://api.github.com/repos/<owner>/<repo>/releases/latest
 * y compara el `tag_name` con la `AGENT_VERSION` actual. Si hay una
 * version mas nueva publicada, lo loguea en INFO con el link de
 * descarga del .exe y las instrucciones de update manual.
 *
 * Por ahora NO descargamos ni reemplazamos el binario solos — en
 * Windows reemplazar el .exe de un servicio en marcha es complicado
 * (file locks, UAC, restart del servicio). Eso queda para un sprint
 * posterior. Aca solo avisamos.
 *
 * Errores de red NO matan al agente: si la API esta caida, si el
 * repo es privado y devuelve 404, o si el response no parsea, simplemente
 * logueamos warn y seguimos. La impresion local es prioridad.
 */

import { z } from 'zod';
import type { Logger } from './logger.js';
import { AGENT_VERSION } from './constants.js';

// -------------------------------------------------------------------
// Schema del response de GitHub
// -------------------------------------------------------------------

/**
 * Schema parcial de la response de `/releases/latest`. Solo validamos los
 * campos que usamos; GitHub devuelve muchos mas pero no nos importan.
 */
export const GitHubReleaseSchema = z.object({
  tag_name: z.string().min(1),
  html_url: z.string().url(),
  published_at: z.string().min(1),
  body: z.string().nullable().optional().default(''),
  assets: z
    .array(
      z.object({
        name: z.string(),
        browser_download_url: z.string().url(),
        size: z.number().int().nonnegative()
      })
    )
    .default([])
});

export type GitHubRelease = z.infer<typeof GitHubReleaseSchema>;

/**
 * Info enriquecida que retornamos a quien pregunte si hay update.
 * Garantiza que ya validamos que el asset Windows existe.
 */
export type UpdateInfo = {
  latestVersion: string;
  downloadUrl: string;
  releaseUrl: string;
  publishedAt: string;
  releaseNotes: string;
};

// -------------------------------------------------------------------
// compareVersions
// -------------------------------------------------------------------

/**
 * Compara dos versiones semver "simples" (major.minor.patch). Retorna
 * -1 si `current` < `latest`, 0 si son iguales, 1 si `current` > `latest`.
 *
 * Acepta el prefijo "v" opcional ("v1.2.3" === "1.2.3"). Si alguna de las
 * dos no parsea como `\d+\.\d+\.\d+`, retornamos 0 (tratamos como "no hay
 * update disponible" para evitar falsos positivos por basura en el tag).
 *
 * No soporta pre-release (`-rc.1`) ni build metadata (`+sha`) — para
 * cuando lleguemos a eso, agregamos. Por ahora YAGNI.
 */
export function compareVersions(current: string, latest: string): number {
  const a = parseSimpleSemver(current);
  const b = parseSimpleSemver(latest);
  if (!a || !b) return 0;

  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return 0;
}

type SimpleSemver = { major: number; minor: number; patch: number };

function parseSimpleSemver(input: string): SimpleSemver | null {
  const trimmed = input.trim().replace(/^v/i, '');
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(trimmed);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3])
  };
}

// -------------------------------------------------------------------
// fetchLatestRelease
// -------------------------------------------------------------------

/**
 * User-Agent que mandamos a GitHub. La API lo exige; sin el header te
 * devuelve 403. Embebemos la version actual para que en logs server-side
 * se pueda ver desde que cliente vino la consulta.
 */
const USER_AGENT = `bait-print-agent/${AGENT_VERSION}`;

/**
 * Timeout de la llamada a GitHub. 10s es generoso pero nos cubre si el
 * link del local esta lentito.
 */
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Resultado raw del fetch. Distinguimos "no encontrado" de "otro error"
 * para que el caller decida si silenciar o no en el siguiente intento.
 */
export type FetchReleaseResult =
  | { ok: true; release: GitHubRelease }
  | { ok: false; reason: 'not_found' | 'rate_limited' | 'http_error' | 'network_error' | 'invalid_schema'; status?: number; message?: string };

/**
 * Hace GET al endpoint de releases y devuelve el response validado o un
 * tag de error que el caller puede usar para decidir como loguear.
 */
export async function fetchLatestRelease(
  repo: string,
  logger?: Logger
): Promise<FetchReleaseResult> {
  const url = `https://api.github.com/repos/${repo}/releases/latest`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/vnd.github+json',
        // Pedimos la version v3 explicitamente para que GitHub no cambie
        // el formato sin avisar si algun dia hace un breaking change.
        'X-GitHub-Api-Version': '2022-11-28'
      },
      signal: controller.signal
    });

    if (!response.ok) {
      // 404 cuando el repo es privado o todavia no hay ningun release
      // publicado. 403 cuando excedimos rate limit (60/hora sin auth).
      // En ambos casos seguimos andando.
      const reason: FetchReleaseResult & { ok: false } =
        response.status === 404
          ? { ok: false, reason: 'not_found', status: 404 }
          : response.status === 403
            ? { ok: false, reason: 'rate_limited', status: 403 }
            : { ok: false, reason: 'http_error', status: response.status };
      return reason;
    }

    const json = await response.json();
    const parsed = GitHubReleaseSchema.safeParse(json);

    if (!parsed.success) {
      logger?.warn(
        { issues: parsed.error.issues, url },
        'Response de GitHub Releases no matchea el schema esperado'
      );
      return { ok: false, reason: 'invalid_schema' };
    }

    return { ok: true, release: parsed.data };
  } catch (err) {
    // AbortError (timeout) o cualquier otro fallo de red.
    return {
      ok: false,
      reason: 'network_error',
      message: err instanceof Error ? err.message : String(err)
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

// -------------------------------------------------------------------
// checkForUpdates
// -------------------------------------------------------------------

/**
 * Nombre del asset Windows que publicamos en cada release. Tiene que
 * matchear exactamente el output de `npm run package:win` en CI. Si
 * algun dia agregamos mac/linux, sumamos mas constantes acá.
 */
const WIN_ASSET_NAME = 'bait-print-agent-win-x64.exe';

export type CheckForUpdatesOptions = {
  currentVersion: string;
  repo: string;
  logger: Logger;
};

/**
 * Pregunta UNA VEZ a GitHub si hay version nueva. Si la hay y el asset
 * Windows esta publicado, retorna la info. Si no, retorna null y deja
 * un warn en el logger explicando por que (404, rate-limit, schema, etc).
 *
 * El caller (`startPeriodicUpdateCheck`) puede silenciar warnings 404
 * despues del primer intento, pero esta funcion es stateless y siempre
 * loguea lo que ve. Para uso one-shot (comando `check-updates`) es lo
 * que queremos.
 */
export async function checkForUpdates(
  opts: CheckForUpdatesOptions
): Promise<UpdateInfo | null> {
  const result = await fetchLatestRelease(opts.repo, opts.logger);

  if (!result.ok) {
    logFetchError(opts.logger, opts.repo, result);
    return null;
  }

  const release = result.release;

  const cmp = compareVersions(opts.currentVersion, release.tag_name);
  if (cmp >= 0) {
    // Estamos al dia o por delante (caso raro: corriendo un build
    // local mas nuevo que el release publicado).
    return null;
  }

  // Hay update; buscamos el asset Windows.
  const asset = release.assets.find((a) => a.name === WIN_ASSET_NAME);
  if (!asset) {
    opts.logger.warn(
      { tag: release.tag_name, expectedAsset: WIN_ASSET_NAME },
      'Release nueva publicada pero no incluye el asset de Windows; ignorando'
    );
    return null;
  }

  return {
    latestVersion: stripVPrefix(release.tag_name),
    downloadUrl: asset.browser_download_url,
    releaseUrl: release.html_url,
    publishedAt: release.published_at,
    releaseNotes: release.body ?? ''
  };
}

function stripVPrefix(tag: string): string {
  return tag.replace(/^v/i, '');
}

/**
 * Loguea un fallo del fetch con el detalle adecuado segun la causa.
 * En 404 dejamos un mensaje educado por si es repo privado.
 */
function logFetchError(
  logger: Logger,
  repo: string,
  result: Extract<FetchReleaseResult, { ok: false }>
): void {
  switch (result.reason) {
    case 'not_found':
      logger.warn(
        { repo, status: 404 },
        'GitHub Releases devolvio 404. ' +
          'El repo puede ser privado o todavia no tiene ningun release publicado. ' +
          'Si es privado, el agente no puede chequear updates sin un token.'
      );
      return;
    case 'rate_limited':
      logger.warn(
        { repo, status: 403 },
        'GitHub Releases rechazo el request por rate-limit (403). Reintentamos en el proximo ciclo.'
      );
      return;
    case 'http_error':
      logger.warn(
        { repo, status: result.status },
        'GitHub Releases respondio con un status inesperado'
      );
      return;
    case 'network_error':
      logger.warn(
        { repo, err: result.message },
        'Fallo el fetch a GitHub Releases (red caida o timeout)'
      );
      return;
    case 'invalid_schema':
      // Ya logueamos el detalle en fetchLatestRelease.
      return;
  }
}

// -------------------------------------------------------------------
// startPeriodicUpdateCheck
// -------------------------------------------------------------------

export type StartPeriodicUpdateCheckOptions = {
  /** Cada cuantos minutos chequear. Default sugerido por el caller: 60. */
  intervalMinutes: number;
  currentVersion: string;
  repo: string;
  logger: Logger;
};

/**
 * Arranca el polling de updates. Hace un primer check inmediato y despues
 * cada `intervalMinutes`. Retorna el handle del setInterval para que el
 * caller lo limpie en SIGINT/SIGTERM.
 *
 * Esta funcion mantiene estado interno (`loggedPrivateRepoWarning`) para
 * no spamear el log si el repo es privado y la API responde 404 en cada
 * intento. El warning se imprime una vez y los siguientes 404 quedan en
 * debug.
 */
export function startPeriodicUpdateCheck(
  opts: StartPeriodicUpdateCheckOptions
): NodeJS.Timeout {
  const intervalMs = Math.max(opts.intervalMinutes, 1) * 60 * 1_000;

  // Estado local del checker. Cada llamada empieza limpia y muere con su
  // setInterval. Si el caller arranca dos checkers en el mismo proceso
  // (caso raro pero posible en tests), cada uno tiene su propio flag.
  let loggedPrivateRepoWarning = false;

  const runCheck = async (): Promise<void> => {
    try {
      const result = await fetchLatestRelease(opts.repo, opts.logger);

      if (!result.ok) {
        // 404 repetido -> a debug. Cualquier otro error o el primer 404 -> warn.
        if (result.reason === 'not_found' && loggedPrivateRepoWarning) {
          opts.logger.debug(
            { repo: opts.repo, status: 404 },
            'GitHub Releases sigue devolviendo 404 (repo privado o sin releases)'
          );
        } else {
          if (result.reason === 'not_found') {
            loggedPrivateRepoWarning = true;
          }
          logFetchError(opts.logger, opts.repo, result);
        }
        return;
      }

      // Si el repo "se recupero" (paso de privado a publico, o ya hay un
      // release publicado), reseteamos el flag para que un futuro 404
      // vuelva a logearse en warn.
      loggedPrivateRepoWarning = false;

      const release = result.release;
      const cmp = compareVersions(opts.currentVersion, release.tag_name);

      if (cmp >= 0) {
        opts.logger.debug(`Version actual al dia (v${opts.currentVersion})`);
        return;
      }

      const asset = release.assets.find((a) => a.name === WIN_ASSET_NAME);
      if (!asset) {
        opts.logger.warn(
          { tag: release.tag_name, expectedAsset: WIN_ASSET_NAME },
          'Release nueva publicada pero no incluye el asset de Windows; ignorando'
        );
        return;
      }

      const update: UpdateInfo = {
        latestVersion: stripVPrefix(release.tag_name),
        downloadUrl: asset.browser_download_url,
        releaseUrl: release.html_url,
        publishedAt: release.published_at,
        releaseNotes: release.body ?? ''
      };

      logUpdateBanner(opts.logger, opts.currentVersion, update);
    } catch (err) {
      // Belt-and-suspenders: si por algun motivo el check rompe (no
      // deberia, todo esta en try/catch interno), atrapamos aca para no
      // matar el setInterval.
      opts.logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'Fallo inesperado en update check (seguimos andando)'
      );
    }
  };

  // Primer check inmediato. Lo lanzamos void porque no queremos bloquear
  // el arranque del agente esperando a GitHub.
  void runCheck();

  const handle = setInterval(() => {
    void runCheck();
  }, intervalMs);

  opts.logger.info(
    { intervalMinutes: opts.intervalMinutes, repo: opts.repo },
    'Update checker iniciado'
  );

  return handle;
}

/**
 * Imprime el banner de "hay version nueva" en INFO con instrucciones de
 * update manual. Usa emojis porque en un log lleno de heartbeats y jobs,
 * un mensaje con icono salta a la vista — es ahi donde aportan.
 */
function logUpdateBanner(
  logger: Logger,
  currentVersion: string,
  update: UpdateInfo
): void {
  const relativeAge = formatRelativeTime(update.publishedAt);

  // Logueamos como un solo objeto + mensaje para que pino lo deje atomico
  // (sin que otro log se intercale en el medio).
  logger.info(
    {
      currentVersion,
      latestVersion: update.latestVersion,
      releaseUrl: update.releaseUrl,
      downloadUrl: update.downloadUrl,
      publishedAt: update.publishedAt
    },
    [
      `🆕 Hay una version nueva: v${update.latestVersion} (la actual es v${currentVersion})`,
      `   Publicada: ${relativeAge}`,
      `   Descargar: ${update.releaseUrl}`,
      '',
      '   Para actualizar:',
      '   1. Parar el servicio: bait-print-agent uninstall-service',
      '   2. Descargar el .exe nuevo (link arriba)',
      '   3. Reemplazar el .exe en la misma carpeta',
      '   4. Reinstalar el servicio: bait-print-agent install-service'
    ].join('\n')
  );
}

/**
 * Formatea un ISO timestamp como "hace X minutos/horas/dias". Best-effort:
 * si el parseo falla, devolvemos el ISO crudo para que igual sea informativo.
 */
function formatRelativeTime(isoTimestamp: string): string {
  const ts = Date.parse(isoTimestamp);
  if (Number.isNaN(ts)) return isoTimestamp;

  const diffMs = Date.now() - ts;
  if (diffMs < 0) return isoTimestamp; // fecha en el futuro, no se que decir

  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return 'hace menos de 1 minuto';
  if (minutes < 60) return `hace ${minutes} minuto${minutes === 1 ? '' : 's'}`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `hace ${hours} hora${hours === 1 ? '' : 's'}`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `hace ${days} dia${days === 1 ? '' : 's'}`;

  const months = Math.floor(days / 30);
  if (months < 12) return `hace ${months} mes${months === 1 ? '' : 'es'}`;

  const years = Math.floor(days / 365);
  return `hace ${years} ano${years === 1 ? '' : 's'}`;
}
