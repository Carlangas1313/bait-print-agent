/**
 * Registry de impresoras fisicas configuradas para una location.
 *
 * Se carga al arrancar el agente (cuando agent_mode === 'usb') y se
 * refresca cada N minutos para captar cambios hechos desde bait-app.cl
 * (admin agrega/quita/modifica printers mientras el agente corre).
 *
 * El matching job -> printer es:
 *   1. Si el job trae print_area_id, buscar la printer con ese mismo
 *      print_area_id.
 *   2. Si no encuentra o el job no tiene print_area_id, usar la printer
 *      `is_primary = true` (la "caja default").
 *   3. Si tampoco hay primary, usar la primera disponible.
 *   4. Si la lista esta vacia, retornar null y el caller decide.
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
 * Elige la printer apropiada para un job dado:
 *
 *   1. Si el job tiene print_area_id, buscar match exacto.
 *   2. Si no, usar la printer marcada como is_primary.
 *   3. Si tampoco hay primary, agarrar la primera.
 *   4. Si no hay ninguna, retornar null (caller decide).
 */
export function pickPrinterForJob(
  printers: PrinterRow[],
  job: PrintJobRow
): PrinterRow | null {
  if (printers.length === 0) return null;

  // 1. Match exacto por print_area_id.
  if (job.print_area_id) {
    const exact = printers.find((p) => p.print_area_id === job.print_area_id);
    if (exact) return exact;
  }

  // 2. Primary (la "caja default").
  const primary = printers.find((p) => p.is_primary);
  if (primary) return primary;

  // 3. Cualquiera. Ya estan ordenadas por is_primary DESC, name ASC, asi
  // que la primera es la mas "razonable" en ausencia de match explicito.
  return printers[0] ?? null;
}
