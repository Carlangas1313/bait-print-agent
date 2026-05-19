/**
 * Flow de pairing del agente.
 *
 * El usuario corre `bait-print-agent setup --code XXXX-XXXX`. Nosotros
 * llamamos al RPC `claim_pairing_code` con la anon key (sin auth, porque
 * todavia no tenemos credenciales) y guardamos lo que nos devuelve a
 * disco. A partir de ese momento, el agente arranca normal y usa esa
 * config persistente.
 */

import { createClient } from '@supabase/supabase-js';
import { AGENT_VERSION } from './constants.js';
import type { Logger } from './logger.js';
import {
  getConfigPath,
  writePersistentConfig,
  type PersistentConfig
} from './persistent-config.js';

const CODE_REGEX = /^[A-Z2-9]{4}-[A-Z2-9]{4}$/i;

/**
 * Shape esperado de la respuesta del RPC `claim_pairing_code`.
 * Supabase puede devolverlo como objeto o como array de un solo objeto
 * dependiendo de como este declarado en el SQL — manejamos ambos.
 */
type ClaimPairingCodeResult = {
  agent_id: string;
  restaurant_id: string;
  location_id: string;
  agent_name: string;
  auth_email: string;
  auth_password: string;
};

export async function setupAgent(
  code: string,
  supabaseUrl: string,
  supabaseAnonKey: string,
  logger: Logger
): Promise<void> {
  // ------------------------------------------------------------------
  // 1) Validar formato del code antes de quemar un round-trip a Supabase.
  // ------------------------------------------------------------------
  if (!CODE_REGEX.test(code)) {
    throw new Error('Código inválido. Formato esperado: XXXX-XXXX');
  }

  const normalizedCode = code.toUpperCase();

  logger.info({ code: normalizedCode }, 'Canjeando pairing code...');

  // ------------------------------------------------------------------
  // 2) Cliente Supabase temporal con anon key (sin sesion).
  // ------------------------------------------------------------------
  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false
    }
  });

  // ------------------------------------------------------------------
  // 3) Llamada al RPC. Los errores vienen ya traducidos al espanol
  //    desde el SQL function (codigo invalido / expirado / ya canjeado).
  // ------------------------------------------------------------------
  const { data, error } = await supabase.rpc('claim_pairing_code', {
    p_code: normalizedCode,
    p_agent_version: AGENT_VERSION
  });

  if (error) {
    throw new Error(error.message);
  }

  if (!data) {
    throw new Error(
      'El RPC respondio vacio. Revisa que el código no este expirado y volve a intentar.'
    );
  }

  // ------------------------------------------------------------------
  // 4) Normalizar la respuesta. Si vino array, tomamos el primer elemento.
  // ------------------------------------------------------------------
  const result: ClaimPairingCodeResult = Array.isArray(data) ? data[0] : data;

  if (
    !result ||
    !result.agent_id ||
    !result.restaurant_id ||
    !result.location_id ||
    !result.auth_email ||
    !result.auth_password
  ) {
    throw new Error(
      'La respuesta del RPC esta incompleta. Contacta al soporte de bait-pos.'
    );
  }

  // ------------------------------------------------------------------
  // 5) Armar y persistir la config.
  // ------------------------------------------------------------------
  const config: PersistentConfig = {
    agent_id: result.agent_id,
    restaurant_id: result.restaurant_id,
    location_id: result.location_id,
    agent_name: result.agent_name,
    auth_email: result.auth_email,
    auth_password: result.auth_password,
    supabase_url: supabaseUrl,
    supabase_anon_key: supabaseAnonKey,
    pairing_completed_at: new Date().toISOString(),
    agent_version: AGENT_VERSION
  };

  writePersistentConfig(config);

  // ------------------------------------------------------------------
  // 6) Feedback al usuario.
  // ------------------------------------------------------------------
  logger.info(
    {
      agentName: config.agent_name,
      restaurantId: config.restaurant_id,
      locationId: config.location_id,
      configPath: getConfigPath()
    },
    `✓ Agente ${config.agent_name} conectado a ${config.restaurant_id} / ${config.location_id}. Configuración guardada en ${getConfigPath()}.`
  );

  logger.info(
    'Ahora podes cerrar este setup y arrancar el agente normal con `bait-print-agent`.'
  );
}
