/**
 * Constantes embebidas en el binario distribuido.
 *
 * El cliente final no setea env vars: el .exe ya trae la URL y la anon key
 * del proyecto Supabase productivo de bait-pos hardcodeadas. Esto permite
 * que el flujo `setup --code XXXX-XXXX` funcione sin pedir nada mas al user.
 *
 * Para dev local puedes overridear via env vars: si `process.env.SUPABASE_URL`
 * o `process.env.SUPABASE_ANON_KEY` estan seteadas, ganan sobre estos defaults.
 */

export const DEFAULT_SUPABASE_URL = 'https://ladhxyybqvaevtbhelil.supabase.co';

export const DEFAULT_SUPABASE_ANON_KEY =
  'sb_publishable_tQQbRXmLpgqpwx4jdBG2OA_b0uS8tE1';

export const AGENT_VERSION = '0.9.12';

/**
 * Resuelve la URL de Supabase: env var > default hardcodeado.
 */
export function getSupabaseUrl(): string {
  return process.env.SUPABASE_URL?.trim() || DEFAULT_SUPABASE_URL;
}

/**
 * Resuelve la anon key de Supabase: env var > default hardcodeado.
 */
export function getSupabaseAnonKey(): string {
  return process.env.SUPABASE_ANON_KEY?.trim() || DEFAULT_SUPABASE_ANON_KEY;
}
