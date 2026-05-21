/**
 * Registry de impresoras fisicas configuradas para una location.
 *
 * Se carga al arrancar el agente (cuando agent_mode === 'usb') y se
 * refresca cada N minutos para captar cambios hechos desde bait-app.cl
 * (admin agrega/quita/modifica printers mientras el agente corre).
 *
 * El matching job -> printer es (en orden de preferencia):
 *   1. Si el job trae target_printer_id (RPC migration 050+), match
 *      directo por id. Es la ruta moderna: la RPC ya decidio que
 *      printer fisica recibe esta comanda.
 *   2. Si target_printer_id es NULL pero el job trae print_area_id
 *      (jobs viejos, pre-050, o flows que no setean target), buscar
 *      por area: primary del area, sino primera printer del area.
 *   3. Sin target_printer_id ni print_area_id, fallback a la printer
 *      `is_primary = true` (la "caja default" del location).
 *   4. Si la lista esta vacia o nada matchea, retornar null y el caller
 *      decide (dispatcher lo clasifica como permanent).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Logger } from '../logger.js';
import type { PrintJobRow } from '../types.js';

/**
 * Fila de la tabla `printers` que nos interesa al agente.
 *
 * Espejo parcial del schema de Supabase (migrations 040+). Mantener
 * sincronizado con `apps/web/lib/db/printers.ts` del repo bait-pos.
 *
 * Notas:
 * - `printer_type` es informativo (thermal_kitchen, thermal_bar, etc.).
 *   No lo usamos para elegir driver — siempre asumimos ESC/POS Epson-compat.
 *   Si en el futuro hay que distinguir Star vs Epson, este es el campo.
 * - `connection_type` se valida contra union de strings; cualquier otro
 *   valor (ej. `virtual`, `bluetooth` futuro) lo filtramos al cargar.
 */
export type PrinterRow = {
  id: string;
  name: string;
  printer_type: string | null;
  connection_type: 'usb' | 'network' | 'bluetooth' | string;
  target: string | null;
  print_area_id: string | null;
  is_primary: boolean;
  copies: number;
  cut_paper: boolean;
  beep: boolean;
};

/**
 * Connection types que el driver real soporta. `virtual` y otros quedan
 * filtrados en `loadPrintersForLocation`.
 */
const SUPPORTED_CONNECTIONS: ReadonlyArray<string> = ['usb', 'network', 'bluetooth'];

/**
 * Carga las impresoras activas de una location. Filtra los connection_type
 * que el driver real no sabe manejar (ej. 'virtual') para que el
 * `pickPrinterForJob` solo vea opciones realmente imprimibles.
 *
 * Loguea un breakdown por connection_type para que en los logs sea facil
 * ver cuantas USB, LAN, BT tiene cargadas el agente.
 */
export async function loadPrintersForLocation(
  supabase: SupabaseClient,
  locationId: string,
  logger: Logger
): Promise<PrinterRow[]> {
  const { data, error } = await supabase
    .from('printers')
    .select(
      'id, name, printer_type, connection_type, target, print_area_id, is_primary, copies, cut_paper, beep'
    )
    .eq('location_id', locationId)
    .eq('active', true)
    .order('is_primary', { ascending: false })
    .order('name', { ascending: true });

  if (error) {
    logger.error(
      { err: error, locationId },
      'Error cargando impresoras de la location'
    );
    throw new Error(`No pude cargar impresoras: ${error.message}`);
  }

  const all = (data ?? []) as PrinterRow[];

  // Filtramos los connection_type que el driver real no sabe manejar.
  // 'virtual' es legit en la DB (lo usa la UI antes de configurar hardware),
  // pero no tiene sentido pasarselo a node-thermal-printer.
  const supported = all.filter((p) =>
    SUPPORTED_CONNECTIONS.includes(p.connection_type)
  );

  const skipped = all.length - supported.length;

  // Breakdown por tipo de conexion para el log inicial.
  const breakdown = supported.reduce<Record<string, number>>((acc, p) => {
    acc[p.connection_type] = (acc[p.connection_type] ?? 0) + 1;
    return acc;
  }, {});

  // Breakdown por print_area_id (cuantas matchean a cada area).
  const byArea = supported.reduce<Record<string, number>>((acc, p) => {
    const key = p.print_area_id ?? '(sin area / default)';
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});

  logger.info(
    {
      locationId,
      total: all.length,
      supported: supported.length,
      skipped,
      breakdown,
      byArea
    },
    `Cargue ${supported.length} impresoras (${all.length} en DB, ${skipped} filtradas por connection_type no soportado)`
  );

  return supported;
}

/**
 * Elige la printer apropiada para un job dado.
 *
 * Orden de preferencia (cada paso solo aplica si el anterior no resolvio):
 *
 *   1. **target_printer_id explicito** (RPC migration 050+): match directo
 *      por id en el array. Si la printer fue desactivada o eliminada
 *      entre el encolado y el dispatch, NO caemos a fallback — retornamos
 *      null. Razon: la RPC decidio especificamente esa printer (ej. una
 *      estacion concreta dentro de un area multi-terminal). Caer al
 *      primary del area aca enviaria el item a la printer equivocada.
 *      El dispatcher lo clasifica como permanent y el admin tiene que
 *      reactivar la printer o reasignar el item desde el editor.
 *
 *   2. **print_area_id (legacy fallback)**: jobs viejos pre-050 no traen
 *      target_printer_id. Mantenemos el comportamiento historico:
 *        a) primera printer con `print_area_id === job.print_area_id`,
 *        b) si no hay, primary del location ("caja default"),
 *        c) si tampoco, primera printer disponible.
 *
 *   3. **Sin info de routing**: job sin target_printer_id ni
 *      print_area_id (ej. bill_proforma viejo). Cae al primary del
 *      location.
 *
 *   4. Lista vacia o nada matchea: null → caller decide.
 */
export function pickPrinterForJob(
  printers: PrinterRow[],
  job: PrintJobRow
): PrinterRow | null {
  if (printers.length === 0) return null;

  // 1. Match explicito por target_printer_id (ruta moderna, RPC 050+).
  // Si vino seteado, esa es LA decision; no caemos a fallback por area.
  if (job.target_printer_id) {
    const exact = printers.find((p) => p.id === job.target_printer_id);
    return exact ?? null;
  }

  // 2. Fallback legacy: match por print_area_id (jobs pre-050).
  if (job.print_area_id) {
    const exact = printers.find((p) => p.print_area_id === job.print_area_id);
    if (exact) return exact;
  }

  // 3. Primary del location (la "caja default") para jobs sin area
  // ni printer explicita.
  const primary = printers.find((p) => p.is_primary);
  if (primary) return primary;

  // 4. Cualquiera. Ya estan ordenadas por is_primary DESC, name ASC, asi
  // que la primera es la mas "razonable" en ausencia de match explicito.
  return printers[0] ?? null;
}
