import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { AgentConfig } from './config.js';

/**
 * Cliente Supabase del agente.
 *
 * Sprint 2: usa SUPABASE_SERVICE_ROLE_KEY que bypassa RLS. Solo para
 * dev local mientras el flujo de JWT scoped (Sprint 3) no está listo.
 * No distribuir el .env a clientes finales — el service role tiene
 * acceso TOTAL a todos los restaurants del proyecto.
 *
 * Sprint 3 reemplazará esto con un JWT firmado por bait-pos backend
 * que incluya el restaurant_id y location_id como claims, y las RLS
 * los validarán como cualquier otro user authenticated.
 */
export function createSupabase(config: AgentConfig): SupabaseClient {
  return createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
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
