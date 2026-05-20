/**
 * Renderers ESC/POS: arman el contenido de tickets (jobs productivos +
 * pagina de prueba del companion) y delegan el envio al helper unificado
 * `sendEscPos` de `printers/escpos-transport.ts`.
 *
 * Toda la decision de "elegir transport" (USB spooler RAW Win32 vs TCP raw
 * 9100 vs COM virtual) vive en el helper. Aca solo importa el CONTENIDO
 * del ticket — esto evita duplicacion y deja que sumar un renderer nuevo
 * (notificaciones de cierre, ticket de propinas, etc) sea trivial.
 */

import type { Logger } from '../logger.js';
import type { PrintJobRow } from '../types.js';
import { formatJob } from './console.js';
import type { PrinterRow } from '../printers/registry.js';
import type { DiscoveredPrinter } from '../printers/discover.js';
import { AGENT_VERSION } from '../constants.js';
import { sendEscPos } from '../printers/escpos-transport.js';

/**
 * Ancho del papel en chars. Misma constante que console.ts/format.ts.
 * Hoy fijo en 32 (58mm). Si en el futuro hay impresoras 80mm, leerlo del
 * `printer_type` o agregar columna `width` a la tabla `printers`.
 */
const PRINTER_WIDTH = 32;

/**
 * Lineas que destacamos en negrita: cabeceras tipo "COCINA - MESA 4",
 * totales, anulaciones. El match es por keywords case-insensitive.
 */
const BOLD_KEYWORDS = ['MESA', 'COCINA', 'BARRA', 'TOTAL', 'CIERRE', 'ANULACION'];

/**
 * Detecta si una linea debe ir en negrita (titulos, totales, headers).
 *
 * Se hace por keyword porque el contenido de las lineas viene del
 * `formatJob` compartido con console.ts, y no queremos duplicar la logica
 * de layout aca. Si el formatter cambia, este matcher sigue funcionando.
 */
function isBoldLine(rawLine: string): boolean {
  const upper = rawLine.toUpperCase();
  return BOLD_KEYWORDS.some((kw) => upper.includes(kw));
}

/**
 * Imprime un job en una impresora fisica via ESC/POS.
 *
 * Flujo (refactor v0.6.7):
 *  1. formatJob() genera el bloque ASCII del ticket (mismo contenido que
 *     consola/virtual).
 *  2. Por cada copy (default 1), llamamos a sendEscPos del helper unificado.
 *     El callback popula el ThermalPrinter con las lineas + bold + beep + cut.
 *     El helper elige el transport:
 *       - USB → Win32 spooler RAW (bypass driver del fabricante)
 *       - network → tcp://target:9100
 *       - bluetooth → \\.\COMn
 *
 * El renderer NO sabe qué transport se usa — solo arma contenido.
 *
 * No captura excepciones del transport: deja que se propaguen al
 * claimAndRun del realtime.ts, que las maneja con retry + backoff.
 */
export async function renderJobToPrinter(
  job: PrintJobRow,
  printer: PrinterRow,
  logger: Logger
): Promise<void> {
  logger.info(
    {
      jobId: job.id,
      jobType: job.job_type,
      printerName: printer.name,
      connectionType: printer.connection_type,
      target: printer.target
    },
    `Renderizando job ${job.id} en impresora "${printer.name}" (${printer.connection_type})`
  );

  const content = formatJob(job, logger);
  const lines = content.split('\n');
  const copies = Math.max(1, printer.copies ?? 1);

  for (let copy = 1; copy <= copies; copy++) {
    try {
      await sendEscPos(printer, (tp) => {
        for (const rawLine of lines) {
          if (rawLine.length === 0) {
            tp.newLine();
            continue;
          }
          const bold = isBoldLine(rawLine);
          if (bold) tp.bold(true);
          tp.println(rawLine);
          if (bold) tp.bold(false);
        }
        if (printer.beep) tp.beep();
        if (printer.cut_paper) tp.cut();
      }, logger);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Fallo print de job ${job.id} en "${printer.name}" (copia ${copy}/${copies}): ${msg}`
      );
    }
  }

  logger.info(
    {
      jobId: job.id,
      printerName: printer.name,
      connectionType: printer.connection_type,
      target: printer.target,
      copies
    },
    `Job impreso en ${printer.name} (${printer.connection_type}:${printer.target ?? ''})`
  );
}

/**
 * Construye una `PrinterRow` sintetica a partir de una impresora descubierta
 * del OS. Usada por `renderTestPage` para llamar a `sendEscPos` con el
 * mismo contrato que usa el flow productivo, sin necesidad de que la
 * impresora este configurada en bait-app.cl.
 *
 * Reglas:
 *  - kind 'usb' o 'unknown'  → connection_type='usb' en la PrinterRow.
 *    El helper sendEscPos enruta esto al spooler RAW Win32 usando el
 *    `name` como queue name, asi que funciona para cualquier driver
 *    (Rongta, Epson, etc) sin tocar `target`.
 *  - kind 'network'          → connection_type='network', target='ip:puerto'.
 *  - kind 'bluetooth'        → connection_type='bluetooth', target=COMn.
 *
 * Para el test page no necesitamos copies/beep — defaults (1 copia, sin beep,
 * con cut).
 */
function discoveredToSyntheticPrinter(
  discovered: DiscoveredPrinter
): PrinterRow {
  // Determinar connection_type para el helper. 'unknown' lo mapeamos a 'usb'
  // porque el spooler de Windows maneja cualquier queue registrada sin
  // importar el port name — es nuestro fallback universal en Windows.
  const connectionType: PrinterRow['connection_type'] =
    discovered.kind === 'unknown' ? 'usb' : discovered.kind;

  return {
    id: `test-${discovered.device_id}`,
    name: discovered.name,
    printer_type: 'thermal_test',
    connection_type: connectionType,
    // Para USB el helper ignora target (usa name como queue). Para network
    // y bluetooth el target ES requerido y viene del device_id del OS.
    target: discovered.device_id,
    print_area_id: null,
    is_primary: false,
    copies: 1,
    cut_paper: true,
    beep: false
  };
}

/**
 * Construye las lineas de la pagina de prueba. ASCII fijo, no usa formatJob
 * porque no queremos depender de un job_type real para el test (sumar 'test'
 * al schema de la DB seria overkill para esto).
 */
function buildTestPageLines(
  discovered: DiscoveredPrinter,
  agentName: string,
  locationName: string | null
): string[] {
  const width = PRINTER_WIDTH;
  const sep = '='.repeat(width);
  const dash = '-'.repeat(width);
  const now = new Date();
  const fecha =
    `${now.getDate().toString().padStart(2, '0')}/` +
    `${(now.getMonth() + 1).toString().padStart(2, '0')}/` +
    `${now.getFullYear()} ` +
    `${now.getHours().toString().padStart(2, '0')}:` +
    `${now.getMinutes().toString().padStart(2, '0')}:` +
    `${now.getSeconds().toString().padStart(2, '0')}`;

  const lines: string[] = [
    sep,
    centerLine('bAIt PRINT AGENT', width),
    centerLine('Test de impresion', width),
    sep,
    '',
    `Fecha:   ${fecha}`,
    `Agente:  ${agentName}`
  ];
  if (locationName) {
    lines.push(`Local:   ${locationName}`);
  }
  lines.push(`Version: ${AGENT_VERSION}`);
  lines.push('');
  lines.push(dash);
  lines.push('Impresora:');
  lines.push(`  ${discovered.name}`);
  lines.push(`  Conexion: ${discovered.kind.toUpperCase()}`);
  lines.push(`  Device:   ${discovered.device_id}`);
  lines.push(dash);
  lines.push('');
  lines.push('Si lees este ticket, la');
  lines.push('impresora esta funcionando');
  lines.push('correctamente.');
  lines.push('');
  lines.push(sep);
  return lines;
}

function centerLine(text: string, width: number): string {
  if (text.length >= width) return text.substring(0, width);
  const pad = Math.floor((width - text.length) / 2);
  return ' '.repeat(pad) + text;
}

/**
 * Imprime un test page en la impresora indicada. Usado por el endpoint
 * `POST /v1/printers/:id/test` del companion.
 *
 * Diseño: NO pasa por la cola print_jobs. El handler arma una `PrinterRow`
 * sintetica desde el DiscoveredPrinter (USB/network/bluetooth/unknown) y
 * delega TODO el transport al mismo `sendEscPos` que usa el flow productivo.
 *
 * Asi tenemos un solo path para "elegir transport segun kind" — si en el
 * futuro agregamos por ejemplo BLE-LE directo, una sola modificacion en
 * el helper hace que test + jobs productivos lo usen.
 */
export async function renderTestPage(
  discovered: DiscoveredPrinter,
  agentName: string,
  locationName: string | null,
  logger: Logger
): Promise<void> {
  logger.info(
    {
      printerName: discovered.name,
      kind: discovered.kind,
      deviceId: discovered.device_id
    },
    `Imprimiendo test page en "${discovered.name}" (${discovered.kind})`
  );

  const printer = discoveredToSyntheticPrinter(discovered);
  const lines = buildTestPageLines(discovered, agentName, locationName);

  try {
    await sendEscPos(printer, (tp) => {
      for (const raw of lines) {
        if (raw.length === 0) {
          tp.newLine();
          continue;
        }
        const bold = isBoldLine(raw);
        if (bold) tp.bold(true);
        tp.println(raw);
        if (bold) tp.bold(false);
      }
      tp.cut();
    }, logger);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Fallo test page en "${discovered.name}" (${discovered.kind}): ${msg}`
    );
  }

  logger.info(
    {
      printerName: discovered.name,
      kind: discovered.kind
    },
    `Test page impreso en "${discovered.name}"`
  );
}
