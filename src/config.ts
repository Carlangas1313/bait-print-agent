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
  BAIT_AGENT_MODE: z.enum(['console', 'virtual', 'usb']).default('console'),
  LOG_LEVEL: z
    .enum(['trace', 'debug', 'info', 'warn', 'error'])
    .default('info'),
  HEARTBEAT_INTERVAL_SECONDS: z.coerce.number().int().min(10).max(300).default(30)
});

export type EnvConfig = z.infer<typeof EnvConfigSchema>;

// -------------------------------------------------------------------
// Schema unificado que consume el resto del runtime (realtime, heartbeat).
// -------------------------------------------------------------------
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
  agent_mode: 'console' | 'virtual' | 'usb';
  log_level: 'trace' | 'debug' | 'info' | 'warn' | 'error';
  heartbeat_interval_seconds: number;
};

/**
 * Helpers privados para leer overrides comunes (LOG_LEVEL, heartbeat, mode)
 * desde env vars cuando estamos en modo persistente. Defaults razonables
 * si no estan seteadas.
 */
const LogLevelSchema = z
  .enum(['trace', 'debug', 'info', 'warn', 'error'])
  .default('info');

const HeartbeatSchema = z.coerce.number().int().min(10).max(300).default(30);

const ModeSchema = z.enum(['console', 'virtual', 'usb']).default('console');

function readLogLevelOverride(): AgentConfig['log_level'] {
  return LogLevelSchema.parse(process.env.LOG_LEVEL ?? 'info');
}

function readHeartbeatOverride(): number {
  return HeartbeatSchema.parse(
    process.env.HEARTBEAT_INTERVAL_SECONDS ?? 30
  );
}

function readModeOverride(): AgentConfig['agent_mode'] {
  return ModeSchema.parse(process.env.BAIT_AGENT_MODE ?? 'console');
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
    agent_mode: readModeOverride(),
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
    agent_mode: env.BAIT_AGENT_MODE,
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
