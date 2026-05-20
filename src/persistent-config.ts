/**
 * Configuracion persistente del agente en disco.
 *
 * Se guarda en `<homedir>/.bait-print-agent/config.json` con permisos 0600
 * (solo el user lee/escribe). Es el output del flow `setup --code XXXX-XXXX`
 * y la fuente de verdad para el resto del runtime.
 *
 * ⚠️ Sprint 3c: encriptar este archivo con DPAPI (Windows) o keychain
 * (mac/linux). Por ahora la auth_password queda en plaintext protegida
 * solo por los perms del filesystem.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

const PersistentConfigSchema = z.object({
  agent_id: z.string().uuid(),
  restaurant_id: z.string().uuid(),
  location_id: z.string().uuid(),
  agent_name: z.string().min(1),
  auth_email: z.string().email(),
  auth_password: z.string().min(1),
  supabase_url: z.string().url(),
  supabase_anon_key: z.string().min(20),
  pairing_completed_at: z.string().datetime(),
  agent_version: z.string().min(1),
  /**
   * Token compartido para que el "tray companion" (app que vive en la sesion
   * del usuario, separada del servicio Windows) se autentique contra la API
   * local HTTP del agente. Se genera la primera vez que el agente carga la
   * config: si no existe, lo creamos con crypto.randomBytes(32) en base64 y
   * lo persistimos antes de arrancar el server local.
   *
   * Vive en este archivo a proposito: el companion lee el mismo config.json
   * (gracias al USERPROFILE pinneado por NSSM, ambos procesos comparten el
   * home), asi no hay que mantener dos archivos sincronizados.
   *
   * Opcional para no romper configs viejas — el bloque de `ensureLocalApiToken`
   * arregla al vuelo cualquier config legacy.
   */
  local_api_token: z.string().min(20).optional()
});

export type PersistentConfig = z.infer<typeof PersistentConfigSchema>;

/**
 * Directorio donde vive la config persistente. Mkdir recursive con
 * perms 0700 (solo el user puede entrar). En Windows los perms son
 * mas laxos por como funciona NTFS, pero el flag no rompe nada.
 */
export function getConfigDir(): string {
  const dir = path.join(os.homedir(), '.bait-print-agent');
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (err) {
    // Si ya existe, mkdir recursive no tira; cualquier otro error si.
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw err;
    }
  }
  return dir;
}

/**
 * Path absoluto al config.json.
 */
export function getConfigPath(): string {
  return path.join(getConfigDir(), 'config.json');
}

/**
 * Lee y valida la config persistente. Retorna null si el archivo no existe.
 * Si existe pero esta corrupto (JSON invalido o schema no matchea), tira
 * para que el caller decida si re-correr setup o abortar.
 */
export function readPersistentConfig(): PersistentConfig | null {
  const configPath = getConfigPath();

  if (!fs.existsSync(configPath)) {
    return null;
  }

  const raw = fs.readFileSync(configPath, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Config persistente corrupta (${configPath}): ${
        err instanceof Error ? err.message : String(err)
      }. Borra el archivo y vuelve a correr setup.`
    );
  }

  const result = PersistentConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  · ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(
      `Config persistente invalida (${configPath}):\n${issues}\nBorra el archivo y vuelve a correr setup.`
    );
  }

  return result.data;
}

/**
 * Escribe la config persistente al disco. Asegura que el directorio existe
 * y aplica perms 0600 al archivo (solo el user lee/escribe).
 */
export function writePersistentConfig(config: PersistentConfig): void {
  // Validar antes de escribir: si el caller arma algo medio raro,
  // preferimos tirar aca que dejar basura en el archivo.
  const validated = PersistentConfigSchema.parse(config);

  const configPath = getConfigPath();
  // Aseguramos el dir.
  getConfigDir();

  // writeFileSync con mode no siempre aplica los perms en archivos existentes;
  // explicitos via chmod despues para garantizar 0600.
  const json = JSON.stringify(validated, null, 2);
  fs.writeFileSync(configPath, json, { mode: 0o600 });
  try {
    fs.chmodSync(configPath, 0o600);
  } catch {
    // En Windows chmod es best-effort, lo ignoramos.
  }
}

/**
 * Borra la config persistente. Usado por `bait-print-agent reset`.
 * Si no existe, no tira (idempotente).
 */
export function deletePersistentConfig(): void {
  const configPath = getConfigPath();
  if (fs.existsSync(configPath)) {
    fs.unlinkSync(configPath);
  }
}

/**
 * Garantiza que el `local_api_token` exista en el config persistente.
 *
 * Si la config no trae token (porque viene de una version vieja donde el
 * campo no existia, o porque alguien lo borro a mano), generamos uno con
 * `crypto.randomBytes(32).toString('base64')` y lo escribimos al archivo
 * antes de devolver el valor.
 *
 * Es idempotente: si ya hay un token valido lo retorna tal cual, sin
 * reescribir nada.
 *
 * Devuelve el token vigente (ya sea el preexistente o el recien creado).
 * Si el agente esta corriendo en modo env-legacy (sin config persistente),
 * devuelve null — el caller decide si arranca un server local con token
 * efimero o si skip totalmente.
 *
 * Diseño:
 *  - Lo invocamos al arrancar el agente (justo antes de levantar el server
 *    local) asi siempre hay token cuando el companion intenta hablar.
 *  - El token es 32 bytes random base64 -> ~44 chars. Suficiente entropy
 *    para que un atacante local que no tenga read en %USERPROFILE% no lo
 *    adivine en tiempo razonable.
 */
export function ensureLocalApiToken(): string | null {
  const existing = readPersistentConfig();
  if (!existing) {
    // Modo env-legacy: no hay archivo donde persistir el token. Devolvemos
    // null y el caller decide si arranca el server local o no. En produccion
    // (clientes finales) esto no deberia pasar porque el flow es siempre
    // `setup --code XXXX-XXXX` antes de correr.
    return null;
  }

  if (existing.local_api_token && existing.local_api_token.length >= 20) {
    return existing.local_api_token;
  }

  const token = crypto.randomBytes(32).toString('base64');
  const updated: PersistentConfig = { ...existing, local_api_token: token };
  writePersistentConfig(updated);
  return token;
}
