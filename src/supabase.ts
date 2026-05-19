import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { AgentConfig } from './config.js';

/**
 * Cliente Supabase del agente.
 *
 * Hay dos caminos posibles:
 *  1. Modo persistente (post-Sprint 3): config trae `auth_email` y
 *     `auth_password` que fueron entregados por el RPC claim_pairing_code.
 *     Creamos el client con anon key y autenticamos via signInWithPassword.
 *     RLS aplica como a cualquier user normal.
 *  2. Modo env-legacy (dev/testing): config trae `service_role_key` y
 *     creamos directamente con esa key. Bypassa RLS — NO distribuir a
 *     clientes finales.
 *
 * En ambos casos retornamos el SupabaseClient listo para hacer queries
 * (en el modo persistente, despues de que el sign-in completo).
 */
export async function createAuthenticatedSupabase(
  config: AgentConfig
): Promise<SupabaseClient> {
  // ------------------------------------------------------------------
  // Modo persistente: anon key + signInWithPassword.
  // ------------------------------------------------------------------
  if (config.auth_email && config.auth_password) {
    const client = createClient(config.supabase_url, config.supabase_anon_key, {
      auth: {
        autoRefreshToken: true,
        persistSession: false,
        detectSessionInUrl: false
      },
      realtime: {
        params: { eventsPerSecond: 10 }
      }
    });

    const { error } = await client.auth.signInWithPassword({
      email: config.auth_email,
      password: config.auth_password
    });

    if (error) {
      throw new Error(`Auth falló: ${error.message}`);
    }

    return client;
  }

  // ------------------------------------------------------------------
  // Modo env-legacy: service role key.
  // ------------------------------------------------------------------
  if (config.service_role_key) {
    return createClient(config.supabase_url, config.service_role_key, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false
      },
      realtime: {
        params: { eventsPerSecond: 10 }
      }
    });
  }

  throw new Error(
    'Config inválida: ni hay credenciales de pairing ni service_role_key.'
  );
}
