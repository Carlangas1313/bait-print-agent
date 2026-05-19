/**
 * Dispatcher de jobs: decide que renderer usar segun el modo activo del
 * agente, y para el modo `usb` resuelve la printer destino.
 *
 * Esta capa existe para que `realtime.ts` no tenga que conocer los detalles
 * de cada backend: pasa el job y el dispatcher se encarga.
 */

import type { Logger } from '../logger.js';
import type { PrintJobRow } from '../types.js';
import type { PrinterRow } from '../printers/registry.js';
import { pickPrinterForJob } from '../printers/registry.js';
import { renderJob } from './console.js';
import { renderJobToVirtual } from './virtual.js';
import { renderJobToPrinter } from './usb.js';

export type RenderMode = 'console' | 'virtual' | 'usb';

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
 * tira con mensaje claro — el job va al retry path del realtime, dandole
 * al admin tiempo a configurar la printer correcta en bait-app.cl.
 */
export async function dispatchJob(
  job: PrintJobRow,
  mode: RenderMode,
  printers: PrinterRow[],
  logger: Logger
): Promise<void> {
  switch (mode) {
    case 'console':
      return renderJob(job, logger);

    case 'virtual':
      return renderJobToVirtual(job, logger);

    case 'usb': {
      const printer = pickPrinterForJob(printers, job);
      if (!printer) {
        const where = job.print_area_id
          ? `print_area ${job.print_area_id}`
          : 'la caja default (is_primary)';
        throw new Error(
          `No hay impresora configurada para ${where}. ` +
            `Agrega una en bait-app.cl -> Configuracion -> Impresoras.`
        );
      }
      return renderJobToPrinter(job, printer, logger);
    }

    default: {
      // TS exhaustive check: si alguien agrega un nuevo modo y se olvida
      // de un case, el compilador lo cacha.
      const exhaustive: never = mode;
      throw new Error(`Modo de renderer desconocido: ${String(exhaustive)}`);
    }
  }
}
