/**
 * Servidor HTTP local del agente — "Tray Companion API".
 *
 * Expone endpoints que el companion (otra app, vive en la sesion del usuario
 * y aparece en el system tray) consume para mostrar estado en vivo, listar
 * jobs recientes y gatillar acciones (reprint, refresh queue, test printer).
 *
 * Stack: `node:http` nativo. Elegimos NO usar Hono/Express por dos razones:
 *  1. Bundle size — el agente se empaqueta como Node SEA (.exe ~80MB) y cada
 *     dep extra suma. http nativo es 0 KB, y el ruteo que necesitamos es
 *     trivial (5 endpoints fijos, 2 con path params).
 *  2. SEA-safety — Hono y compañia a veces traen plugins de Node natives
 *     que rompen el require() del bundler de esbuild. http no.
 *
 * ============================================================================
 * CONTRATO DE LA API LOCAL (consumida por el tray companion)
 * ============================================================================
 *
 * Bind:     127.0.0.1:17891   (loopback, nunca expuesto a la red)
 * Auth:     Authorization: Bearer <local_api_token>
 *           Token vive en %USERPROFILE%\.bait-print-agent\config.json
 *           bajo el campo `local_api_token`. El companion lo lee del mismo
 *           archivo (NSSM pinnea USERPROFILE asi servicio + companion comparten home).
 * Errores:  Todos los responses son JSON. 401 sin auth, 404 ruta inexistente,
 *           5xx errores internos con `{ ok: false, error: '<slug>', detail?: string }`.
 *
 * Endpoints:
 *  GET  /v1/status
 *       Estado del agente: { agent: {id,name,version,location_id,restaurant_id},
 *                            supabase_connected, realtime_status,
 *                            discovered_printers: [...], last_heartbeat_at,
 *                            last_job_at, jobs_pending_count,
 *                            jobs_waiting_printer_count }
 *
 *  GET  /v1/jobs/recent?limit=20
 *       Ultimos N jobs (max 100, default 20) de la location del agente.
 *       Array en `jobs`: [{id, created_at, status, attempts, last_error,
 *                          printed_at, payload, job_type, print_area_id}]
 *
 *  POST /v1/jobs/:id/reprint
 *       CAS reset de status -> 'pending'. Solo aplica si status IN
 *       ('failed', 'printed', 'waiting_printer'). Devuelve {ok, new_status}.
 *       409 si el job esta en 'printing' o 'pending' (no se pisa).
 *
 *  POST /v1/printers/:printerId/test                              [STUB]
 *       Crea un print_job dummy de tipo "test" apuntado a esa printer.
 *       Por ahora 501 not_implemented — ver TODO en handlers.ts.
 *
 *  POST /v1/service/refresh-queue
 *       Fuerza un backfill manual de la cola (similar a lo que hace
 *       startRealtimeListener al arrancar). Devuelve {ok, processed}.
 * ============================================================================
 */

import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AgentConfig } from '../config.js';
import type { Logger } from '../logger.js';
import {
  handleStatus,
  handleJobsRecent,
  handleJobReprint,
  handlePrinterTest,
  handleRefreshQueue,
  type AgentRuntimeState,
  type LocalApiContext,
  type HandlerResult
} from './handlers.js';

/**
 * Puerto fijo en 127.0.0.1. El companion lo tiene hardcodeado: si lo
 * cambias aca, hay que cambiarlo tambien en el otro repo.
 */
export const LOCAL_API_PORT = 17891;
export const LOCAL_API_HOST = '127.0.0.1';

/**
 * Limite de body que aceptamos por request. Ningun endpoint nuestro
 * envia mas que un puñado de bytes; cualquier cosa por encima de 64KB es
 * basura/ataque.
 */
const MAX_BODY_BYTES = 64 * 1024;

export type StartLocalApiOptions = {
  supabase: SupabaseClient;
  config: AgentConfig;
  logger: Logger;
  state: AgentRuntimeState;
  /** Token compartido. Generado por ensureLocalApiToken() en index.ts. */
  token: string;
  /** Override del puerto (default 17891). Util para tests. */
  port?: number;
};

/**
 * Definicion de una ruta. El matcher es regex contra `${method} ${pathname}`,
 * con groups capturados como path params.
 *
 * Por que regex y no un router map: tenemos 5 rutas, 2 con path params.
 * Un router de 30 lineas sin deps es mas barato (en bundle y en mantenimiento)
 * que pulling Hono.
 */
type Route = {
  method: 'GET' | 'POST';
  pattern: RegExp;
  paramNames: readonly string[];
  handler: (ctx: LocalApiContext) => Promise<HandlerResult>;
};

const ROUTES: ReadonlyArray<Route> = [
  {
    method: 'GET',
    pattern: /^\/v1\/status\/?$/,
    paramNames: [],
    handler: handleStatus
  },
  {
    method: 'GET',
    pattern: /^\/v1\/jobs\/recent\/?$/,
    paramNames: [],
    handler: handleJobsRecent
  },
  {
    method: 'POST',
    pattern: /^\/v1\/jobs\/([^/]+)\/reprint\/?$/,
    paramNames: ['id'],
    handler: handleJobReprint
  },
  {
    method: 'POST',
    pattern: /^\/v1\/printers\/([^/]+)\/test\/?$/,
    paramNames: ['printerId'],
    handler: handlePrinterTest
  },
  {
    method: 'POST',
    pattern: /^\/v1\/service\/refresh-queue\/?$/,
    paramNames: [],
    handler: handleRefreshQueue
  }
];

/**
 * Arranca el HTTP server local. Bindea SOLO a 127.0.0.1 (nunca 0.0.0.0)
 * y aborta el proceso si el puerto esta ocupado — el companion necesita
 * saber siempre donde buscar, asi que NO buscamos puerto random.
 *
 * Retorna el server para que el caller pueda hacer close() en shutdown.
 */
export function startLocalApi(opts: StartLocalApiOptions): http.Server {
  const { supabase, config, logger, state, token } = opts;
  const port = opts.port ?? LOCAL_API_PORT;

  const server = http.createServer((req, res) => {
    void handleRequest(req, res, { supabase, config, logger, state, token });
  });

  // listen(port, host) — el host es CRITICO. Sin el, Node bindea a `::`
  // (todas las interfaces) y el agente queda expuesto en LAN.
  server.listen(port, LOCAL_API_HOST, () => {
    logger.info(
      { host: LOCAL_API_HOST, port },
      `Local API escuchando en http://${LOCAL_API_HOST}:${port}`
    );
  });

  // Si el puerto esta ocupado (otro agente corriendo, alguien usando el
  // mismo puerto), abortamos: el companion espera puerto fijo y un fallback
  // a otro puerto le rompe la UX.
  server.on('error', (err) => {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EADDRINUSE') {
      logger.error(
        { port, host: LOCAL_API_HOST },
        `Puerto ${port} ocupado en ${LOCAL_API_HOST}. ¿Hay otro agente corriendo? El companion espera puerto fijo, no se puede usar otro.`
      );
    } else {
      logger.error(
        { err: err.message, code },
        'Local API server tiro un error inesperado'
      );
    }
    // Tirar el proceso porque sin la API local el companion no funciona.
    // Es mejor fail-fast que dejar el agente "a medias".
    process.exit(1);
  });

  return server;
}

// ====================================================================
// Internals
// ====================================================================

type RequestDeps = {
  supabase: SupabaseClient;
  config: AgentConfig;
  logger: Logger;
  state: AgentRuntimeState;
  token: string;
};

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: RequestDeps
): Promise<void> {
  const startedAt = Date.now();
  const method = (req.method ?? '').toUpperCase();
  // URL en req.url es absoluta solo en CONNECT/proxy; para GET/POST normales
  // es path + query. Le ponemos un host arbitrario para usar URL().
  const url = new URL(req.url ?? '/', `http://${LOCAL_API_HOST}`);
  const pathname = url.pathname;
  const requestLine = `${method} ${pathname}`;

  // Defensa basica: NO procesamos requests que vengan de hosts no-loopback.
  // El bind a 127.0.0.1 ya nos cubre 99% de los casos, pero por las dudas
  // chequeamos el remoteAddress.
  const remote = req.socket.remoteAddress ?? '';
  if (!isLoopback(remote)) {
    deps.logger.warn(
      { remote, requestLine },
      'Request desde host no-loopback rechazado (no deberia ser posible con bind 127.0.0.1)'
    );
    sendJson(res, 403, { ok: false, error: 'forbidden' });
    return;
  }

  // CORS preflight: el companion corre en un webview Tauri (origin
  // http://tauri.localhost en Win11), asi que cualquier request con header
  // custom (Authorization) gatilla un OPTIONS preflight antes. Hay que
  // responderlo ANTES de la auth (el preflight NO incluye el Authorization
  // header — por eso fallaba antes y la UI mostraba "Desconectado").
  //
  // Nuestra defensa real es bind a 127.0.0.1 + Bearer token; el origin del
  // browser no es relevante para la seguridad de este endpoint, asi que
  // devolvemos Allow-Origin: * y Allow-Headers con Authorization.
  if (method === 'OPTIONS') {
    res.statusCode = 204;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
    res.end();
    return;
  }

  // Auth: header Authorization: Bearer <token>
  const auth = req.headers['authorization'];
  if (!auth || typeof auth !== 'string') {
    sendJson(res, 401, { ok: false, error: 'missing_authorization' });
    return;
  }
  if (!verifyBearer(auth, deps.token)) {
    deps.logger.warn(
      { requestLine, remote },
      'Auth fallo: token invalido'
    );
    sendJson(res, 401, { ok: false, error: 'invalid_token' });
    return;
  }

  // Solo aceptamos GET y POST en la version actual.
  if (method !== 'GET' && method !== 'POST') {
    sendJson(res, 405, {
      ok: false,
      error: 'method_not_allowed',
      detail: `Method ${method} not supported`
    });
    return;
  }

  // Match ruta.
  const match = findRoute(method, pathname);
  if (!match) {
    sendJson(res, 404, {
      ok: false,
      error: 'not_found',
      detail: `No route for ${requestLine}`
    });
    return;
  }

  // Body parse (solo POST). GET ignora body aunque venga.
  let body: unknown = null;
  if (method === 'POST') {
    try {
      body = await readJsonBody(req);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sendJson(res, 400, {
        ok: false,
        error: 'bad_body',
        detail: msg
      });
      return;
    }
  }

  // Query string a Record<string, string>. Si hay claves repetidas tomamos
  // la primera — ningun endpoint nuestro espera arrays en query.
  const query: Record<string, string> = {};
  for (const [k, v] of url.searchParams.entries()) {
    if (!(k in query)) query[k] = v;
  }

  const ctx: LocalApiContext = {
    supabase: deps.supabase,
    config: deps.config,
    logger: deps.logger,
    state: deps.state,
    params: match.params,
    query,
    body
  };

  try {
    const result = await match.route.handler(ctx);
    sendJson(res, result.status, result.body);
    const elapsed = Date.now() - startedAt;
    deps.logger.debug(
      { requestLine, status: result.status, elapsedMs: elapsed },
      `${requestLine} -> ${result.status} (${elapsed}ms)`
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    deps.logger.error(
      { err: msg, requestLine },
      'Handler tiro excepcion'
    );
    sendJson(res, 500, {
      ok: false,
      error: 'internal',
      detail: msg
    });
  }
}

/**
 * Match con regex. Retorna params si la ruta hace match, null si no.
 */
function findRoute(
  method: string,
  pathname: string
): { route: Route; params: Record<string, string> } | null {
  for (const route of ROUTES) {
    if (route.method !== method) continue;
    const m = route.pattern.exec(pathname);
    if (!m) continue;
    const params: Record<string, string> = {};
    for (let i = 0; i < route.paramNames.length; i++) {
      const name = route.paramNames[i];
      // m[0] es el match completo, m[1..n] son los grupos. paramNames[i]
      // corresponde al grupo i+1 en el regex.
      const value = m[i + 1];
      if (name && value !== undefined) {
        params[name] = decodeURIComponent(value);
      }
    }
    return { route, params };
  }
  return null;
}

/**
 * Lee el body del request como string y lo parsea como JSON. Si no hay
 * body (Content-Length 0 o request sin payload), retorna null.
 *
 * Cap a MAX_BODY_BYTES para evitar OOM con payloads enormes.
 */
function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let rejected = false;

    req.on('data', (chunk: Buffer) => {
      if (rejected) return;
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        rejected = true;
        // destroy() para no seguir recibiendo bytes; el client recibe
        // un reset y nuestro callback resuelve abajo.
        req.destroy();
        reject(new Error(`Body excede el limite (${MAX_BODY_BYTES} bytes)`));
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (rejected) return;
      if (chunks.length === 0) {
        resolve(null);
        return;
      }
      const raw = Buffer.concat(chunks).toString('utf-8').trim();
      if (raw.length === 0) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(
          new Error(
            `Body no es JSON valido: ${err instanceof Error ? err.message : String(err)}`
          )
        );
      }
    });

    req.on('error', (err) => {
      if (rejected) return;
      reject(err);
    });
  });
}

/**
 * Verifica el header Authorization. Acepta "Bearer <token>" y compara
 * con timingSafeEqual para evitar timing attacks (innecesario en loopback
 * pero es buena practica).
 */
function verifyBearer(authHeader: string, expectedToken: string): boolean {
  const prefix = 'Bearer ';
  if (!authHeader.startsWith(prefix)) return false;
  const provided = authHeader.slice(prefix.length).trim();
  if (provided.length === 0) return false;

  // Necesitan mismo length para timingSafeEqual; pad/comparison normal
  // si difieren para no leakear el length.
  const a = Buffer.from(provided, 'utf-8');
  const b = Buffer.from(expectedToken, 'utf-8');
  if (a.length !== b.length) return false;

  // crypto.timingSafeEqual lo importamos lazy para no inflar el bundle si
  // por alguna razon el server local no se usa.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { timingSafeEqual } = require('node:crypto') as typeof import('node:crypto');
  return timingSafeEqual(a, b);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  // CORS: el companion corre en webview Tauri (origin http://tauri.localhost
  // en Win11) y es siempre cross-origin a este server local. Sin estos
  // headers el browser bloquea las responses aunque el HTTP succeed.
  // La defensa real es el bind a 127.0.0.1 + Bearer token (ver comment del
  // OPTIONS preflight handler arriba).
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.end(payload);
}

/**
 * Chequea si una IP es loopback. Cubre IPv4 (127.x.x.x) y IPv6 (::1, ::ffff:127.x.x.x).
 */
function isLoopback(addr: string): boolean {
  if (!addr) return false;
  if (addr === '::1') return true;
  if (addr.startsWith('127.')) return true;
  if (addr.startsWith('::ffff:127.')) return true;
  return false;
}
