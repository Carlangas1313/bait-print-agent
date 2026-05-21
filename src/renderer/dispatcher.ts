/**
 * Dispatcher de jobs: el flow productivo SIEMPRE pasa por `renderJobToPrinter`
 * (que internamente delega a `sendEscPos` y elige USB spooler RAW / TCP raw
 * 9100 / COM virtual segun `printer.connection_type`).
 *
 * Los renderers `console` y `virtual` son SOLO para debug/troubleshooting,
 * activables via env var `BAIT_DEBUG_RENDERER`. Nunca son la opcion default
 * del cliente final.
 *
 * Esta capa existe para que `realtime.ts` no tenga que conocer ninguno de
 * estos detalles: pasa el job + el debug_renderer (puede ser null) y nosotros
 * decidimos.
 *
 * ----------------------------------------------------------------------
 * Clasificacion de errores (v0.5.5+)
 *
 * En vez de tirar exceptions crudas para todo, retornamos un objeto
 * { kind: 'transient' | 'permanent', message } cuando algo falla. El caller
 * en realtime.ts usa esa clasificacion para decidir:
 *
 *   - transient -> backoff exponencial, status='waiting_printer'.
 *     Casos: impresora offline, timeout LAN, sin papel, network error.
 *
 *   - permanent -> status='failed' inmediato, sin reintento.
 *     Casos: payload no matchea su type guard, print_area_id apunta a algo
 *            inexistente, RLS deniega, connection_type no soportado, etc.
 * ----------------------------------------------------------------------
 */

import type { Logger } from '../logger.js';
import type { DebugRenderer } from '../config.js';
import type { PrintJobRow, ErrorKind } from '../types.js';
import type { PrinterRow } from '../printers/registry.js';
import { pickPrinterForJob } from '../printers/registry.js';
import { renderJob } from './console.js';
import { renderJobToVirtual } from './virtual.js';
import { renderJobToPrinter } from './usb.js';

/**
 * Resultado de un dispatch fallido. Lo retornamos en vez de tirar para
 * que el caller (realtime.ts) tome decisiones de retry sin tener que
 * inspeccionar mensajes de error.
 */
export type DispatchError = {
  kind: ErrorKind;
  message: string;
};

/**
 * Heuristica para clasificar excepciones en transient vs permanent.
 *
 * Por defecto asumimos transient (en producto real preferimos reintentar
 * un poco mas que descartar prematuramente). Solo marcamos permanent
 * cuando hay senial fuerte de que el error es estructural y no se va a
 * resolver solo por esperar:
 *
 *   - mensajes que matchean patrones de validacion / payload / config / RLS
 *   - errores tirados desde dispatcher mismo (no hay impresora, modo
 *     desconocido, connection_type no soportado).
 *
 * Si hay dudas, devolver 'transient' — el peor caso es "lo intentamos
 * 4 veces mas en 2h y al final lo dejamos en waiting_printer", lo cual
 * es benigno comparado con marcar failed un job que se podia salvar.
 */
function classifyError(err: unknown): DispatchError {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();

  // Errores estructurales conocidos. Lista pegajosa porque a futuro
  // podemos sumar mas patterns aca sin tocar callers.
  const permanentPatterns: ReadonlyArray<RegExp> = [
    // Validacion de payload (type guards, zod-like, JSON malformado).
    /payload no matchea/i,
    /payload.*invalid/i,
    /invalid.*payload/i,
    /unexpected.*payload/i,
    /zoderror/i,
    /validation/i,
    /malformed/i,

    // Config inconsistente / faltante.
    /no hay impresora configurada/i,
    /no tiene target configurado/i,
    /connection_type no soportado/i,
    /modo de renderer desconocido/i,
    /print_area.*no.*existe/i,
    /print_area.*not.*found/i,

    // Permisos / RLS (no se arregla con reintentar).
    /row-level security/i,
    /permission denied/i,
    /not allowed/i,
    /forbidden/i,
    /\b401\b/,
    /\b403\b/
  ];

  for (const re of permanentPatterns) {
    if (re.test(lower)) {
      return { kind: 'permanent', message };
    }
  }

  // Fallback: transient. Cubre offline, timeouts, sin papel, sockets
  // cerrados, refused connection, EPIPE, etc. Si reintentar no ayuda,
  // a la 4ta el job queda waiting_printer indefinido y el auto-recovery
  // del heartbeat lo va a despertar cuando vuelva la impresora.
  return { kind: 'transient', message };
}

/**
 * Ejecuta el job usando el renderer apropiado.
 *
 * - console: vuelca a stdout. Util para dev/CI y para debug rapido.
 * - virtual: escribe a archivo en ~/bait-print-out/. Util para QA visual
 *   sin hardware fisico.
 * - usb: imprime en hardware real via ESC/POS. Necesita `printers` con
 *   al menos una fila configurada para la location.
 *
 * Si el modo es `usb` y `pickPrinterForJob` no encuentra ninguna candidata,
 * clasificamos como `permanent`: el problema es de configuracion, no se
 * resuelve esperando — el admin tiene que agregar la printer en bait-app.cl.
 *
 * Retorna:
 *   - { ok: true } si todo salio bien.
 *   - { ok: false, error: DispatchError } si fallo.
 *
 * Internamente nunca tira: cualquier excepcion se atrapa y se clasifica.
 */
export type DispatchResult =
  | { ok: true }
  | { ok: false; error: DispatchError };

export async function dispatchJob(
  job: PrintJobRow,
  debugRenderer: DebugRenderer,
  printers: PrinterRow[],
  logger: Logger
): Promise<DispatchResult> {
  try {
    // Caso debug: bypass del renderer productivo. Util en dev y para
    // troubleshooting visual ("¿que ASCII va a mandar?") sin tocar el
    // hardware. Nunca se activa por default; solo via BAIT_DEBUG_RENDERER.
    if (debugRenderer === 'console') {
      await renderJob(job, logger);
      return { ok: true };
    }
    if (debugRenderer === 'virtual') {
      await renderJobToVirtual(job, logger);
      return { ok: true };
    }

    // Productivo: imprimir en hardware real via ESC/POS.
    const printer = pickPrinterForJob(printers, job);
    if (!printer) {
      const where = job.print_area_id
        ? `print_area ${job.print_area_id}`
        : 'la caja default (is_primary)';
      // Permanent: faltan datos de configuracion. Reintentar no ayuda.
      return {
        ok: false,
        error: {
          kind: 'permanent',
          message:
            `No hay impresora configurada para ${where}. ` +
            `Agrega una en bait-app.cl -> Configuracion -> Impresoras.`
        }
      };
    }
    await renderJobToPrinter(job, printer, logger);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: classifyError(err) };
  }
}
