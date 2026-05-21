import { z } from 'zod';
import { readPersistentConfig } from './persistent-config.js';

/**
 * Config del agente en runtime.
 *
 * Hay dos modos de obtenerla:
 *   1. Persistente (preferido, post-Sprint 3): se generó con
 *      `bait-print-agent setup --code XXXX-XXXX` y vive en
 *      `<homedir>/.bait-print-agent/config.json`. Usa auth_email/password
 *      via signInWithPassword.
 *   2. Env vars (legacy, dev local): SERVICE_ROLE_KEY + IDs como antes.
 *      Sigue funcionando para no romper el flow de desarrollo, pero no
 *      se distribuye al cliente final.
 */

// -------------------------------------------------------------------
// Schema env-based (legacy). Lo dejamos para dev/testing local.
// -------------------------------------------------------------------
const EnvConfigSchema = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  BAIT_AGENT_ID: z.string().uuid(),
  BAIT_RESTAURANT_ID: z.string().uuid(),
  BAIT_LOCATION_ID: z.string().uuid(),
  LOG_LEVEL: z
    .enum(['trace', 'debug', 'info', 'warn', 'error'])
    .default('info'),
  HEARTBEAT_INTERVAL_SECONDS: z.coerce.number().int().min(10).max(300).default(30)
});

export type EnvConfig = z.infer<typeof EnvConfigSchema>;

// -------------------------------------------------------------------
// Schema unificado que consume el resto del runtime (realtime, heartbeat).
// -------------------------------------------------------------------
/**
 * Override de renderer SOLO para debug/dev. En produccion, el renderer
 * siempre es `renderJobToPrinter` (que via sendEscPos enruta a USB spooler
 * Win32 / TCP raw 9100 / COM virtual segun `printer.connection_type` de
 * cada printer individual).
 *
 * Activable por env var `BAIT_DEBUG_RENDERER`:
 *   - 'console'  → ticket a stdout (sin tocar impresoras fisicas)
 *   - 'virtual'  → ticket a archivo en ~/bait-print-out/ (sin imprimir)
 *   - sin setear → modo productivo (default y unico que el cliente final usa)
 *
 * El concepto previo `agent_mode` con default 'console' fue la causa del
 * bug reportado por Carlos (jobs marcados printed sin que la Rongta sacara
 * papel): el servicio arrancaba en console y renderizaba a stdout.log sin
 * tocar impresoras. Eliminamos esa config user-facing — console/virtual
 * son herramientas de debug, no opciones de produccion.
 */
export type DebugRenderer = 'console' | 'virtual' | null;

export type AgentConfig = {
  agent_id: string;
  restaurant_id: string;
  location_id: string;
  agent_name: string;
  supabase_url: string;
  supabase_anon_key: string;
  /** Solo seteado en modo persistente (post-pairing). */
  auth_email: string | null;
  /** Solo seteado en modo persistente (post-pairing). */
  auth_password: string | null;
  /** Solo seteado en modo env-legacy. Bypassa RLS. */
  service_role_key: string | null;
  /**
   * null = modo productivo (default).
   * 'console'/'virtual' = bypass del renderer real (solo dev/troubleshooting).
   */
  debug_renderer: DebugRenderer;
  log_level: 'trace' | 'debug' | 'info' | 'warn' | 'error';
  heartbeat_interval_seconds: number;
};

/**
 * Helpers privados para leer overrides comunes desde env vars.
 */
const LogLevelSchema = z
  .enum(['trace', 'debug', 'info', 'warn', 'error'])
  .default('info');

const HeartbeatSchema = z.coerce.number().int().min(10).max(300).default(30);

function readLogLevelOverride(): AgentConfig['log_level'] {
  return LogLevelSchema.parse(process.env.LOG_LEVEL ?? 'info');
}

function readHeartbeatOverride(): number {
  return HeartbeatSchema.parse(
    process.env.HEARTBEAT_INTERVAL_SECONDS ?? 30
  );
}

/**
 * Lee `BAIT_DEBUG_RENDERER` del env. Acepta solo 'console' o 'virtual';
 * cualquier otro valor (incluido sin setear) → null = productivo.
 *
 * Tambien aceptamos el viejo `BAIT_AGENT_MODE=console|virtual` como alias
 * temporal solo para no romper terminales de dev en transicion. Si el value
 * viene 'usb' (productivo viejo), lo mapeamos a null. Una vez todos los
 * setups esten en v0.7+, removemos este alias.
 */
function readDebugRendererOverride(): DebugRenderer {
  const raw = (process.env.BAIT_DEBUG_RENDERER ?? '').trim().toLowerCase();
  if (raw === 'console' || raw === 'virtual') return raw;

  // Compat temporal: BAIT_AGENT_MODE (legacy).
  const legacy = (process.env.BAIT_AGENT_MODE ?? '').trim().toLowerCase();
  if (legacy === 'console' || legacy === 'virtual') return legacy;

  return null;
}

/**
 * Intenta cargar la config desde el archivo persistente. Retorna null
 * si el archivo no existe (entonces probamos env-based).
 */
export function loadConfigFromPersistent(): AgentConfig | null {
  const persistent = readPersistentConfig();
  if (!persistent) return null;

  return {
    agent_id: persistent.agent_id,
    restaurant_id: persistent.restaurant_id,
    location_id: persistent.location_id,
    agent_name: persistent.agent_name,
    supabase_url: persistent.supabase_url,
    supabase_anon_key: persistent.supabase_anon_key,
    auth_email: persistent.auth_email,
    auth_password: persistent.auth_password,
    service_role_key: null,
    debug_renderer: readDebugRendererOverride(),
    log_level: readLogLevelOverride(),
    heartbeat_interval_seconds: readHeartbeatOverride()
  };
}

/**
 * Intenta cargar la config desde env vars (legacy). Retorna null si
 * el parseo falla — el caller decide si tirar o probar otra fuente.
 */
function loadConfigFromEnv(): AgentConfig | null {
  const parsed = EnvConfigSchema.safeParse(process.env);
  if (!parsed.success) return null;

  const env = parsed.data;
  return {
    agent_id: env.BAIT_AGENT_ID,
    restaurant_id: env.BAIT_RESTAURANT_ID,
    location_id: env.BAIT_LOCATION_ID,
    agent_name: 'agente-env-legacy',
    supabase_url: env.SUPABASE_URL,
    supabase_anon_key: '',
    auth_email: null,
    auth_password: null,
    service_role_key: env.SUPABASE_SERVICE_ROLE_KEY,
    debug_renderer: readDebugRendererOverride(),
    log_level: env.LOG_LEVEL,
    heartbeat_interval_seconds: env.HEARTBEAT_INTERVAL_SECONDS
  };
}

/**
 * Carga la config priorizando el archivo persistente. Si no hay nada,
 * cae al env-based legacy. Si tampoco, aborta con instrucciones claras.
 */
export function loadConfig(): AgentConfig {
  const persistent = loadConfigFromPersistent();
  if (persistent) return persistent;

  const envBased = loadConfigFromEnv();
  if (envBased) return envBased;

  console.error(
    '❌ No hay configuración disponible.\n' +
      '   Ejecuta `bait-print-agent setup --code XXXX-XXXX` primero\n' +
      '   o exporta las env vars del modo legacy (ver .env.example).'
  );
  process.exit(1);
}
