/**
 * Virtual renderer: en vez de imprimir a stdout o a hardware ESC/POS,
 * escribe cada ticket a un archivo .txt en `<homedir>/bait-print-out/`.
 *
 * Util para:
 *  - QA visual sin necesitar impresora fisica.
 *  - Backup / auditoria local del flujo.
 *  - Demos donde el cliente quiere ver el ticket antes de cablear hardware.
 *
 * Estructura del path:
 *   ~/bait-print-out/<YYYY-MM-DD>/<HHmmss>-<job_type>-<job_id_short>.txt
 *
 * El job_id_short son los primeros 8 chars del UUID; suficiente para
 * desambiguar dentro de un mismo segundo sin hacer ilegible el nombre.
 *
 * Sprint 4: agregar opcion de PNG renderizado del mismo ASCII (requiere
 * canvas o sharp; por ahora solo .txt como pide la spec).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PrintJobRow } from '../types.js';
import type { Logger } from '../logger.js';
import { formatJob } from './console.js';

/**
 * Directorio base donde caen los tickets virtuales. Lo expongo por si
 * el caller necesita imprimirlo al startup.
 */
export function getVirtualOutDir(): string {
  return path.join(os.homedir(), 'bait-print-out');
}

/**
 * Renderiza el job a archivo .txt y loguea el path absoluto resultante.
 *
 * No tira si el formato falla: el caller (claimAndRun) confia en que
 * la promesa resuelva para marcar el job como printed. Si hay error
 * de I/O real (disco lleno, sin perms), si propagamos para que el job
 * vaya al retry path.
 */
export async function renderJobToVirtual(
  job: PrintJobRow,
  logger: Logger
): Promise<void> {
  logger.info(`Renderizando job ${job.id} tipo ${job.job_type} a archivo virtual`);

  const content = formatJob(job, logger);

  // Path: ~/bait-print-out/2026-05-19/183201-kitchen_order-7f3a.txt
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const min = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');

  const dateDir = `${yyyy}-${mm}-${dd}`;
  const time = `${hh}${min}${ss}`;
  const idShort = job.id.replace(/-/g, '').slice(0, 8);
  const filename = `${time}-${job.job_type}-${idShort}.txt`;

  const baseDir = getVirtualOutDir();
  const fullDir = path.join(baseDir, dateDir);
  fs.mkdirSync(fullDir, { recursive: true });

  const fullPath = path.join(fullDir, filename);
  fs.writeFileSync(fullPath, content, 'utf-8');

  logger.info({ path: fullPath, jobId: job.id }, `Ticket guardado en ${fullPath}`);
}
