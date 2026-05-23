/**
 * Renderers ESC/POS: arman el contenido de tickets (jobs productivos +
 * pagina de prueba del companion) y delegan el envio al helper unificado
 * `sendEscPos` de `printers/escpos-transport.ts`.
 *
 * Toda la decision de "elegir transport" (USB spooler RAW Win32 vs TCP raw
 * 9100 vs COM virtual) vive en el helper. Aca solo importa el CONTENIDO
 * del ticket.
 *
 * Refactor v0.8.0:
 * ----------------
 * Antes: el contenido se generaba con `formatJob()` (strings ASCII) y se
 * iteraba con `tp.println()` linea por linea. Resultado: ticket plano, sin
 * doble altura, sin invert, sin QR, sin XL en el total.
 *
 * Ahora: dispatcheamos por `job.job_type` a las funciones de
 * `escpos-layouts.ts` que emiten comandos ESC/POS nativos (doble altura
 * en headers, badge invertido en PRE-CUENTA, QR opcional, TOTAL en XL,
 * "TOTAL ITEMS" destacado en comanda).
 *
 * Compat: si llega un job_type no mapeado o un payload que falla el type
 * guard, caemos al flow viejo (`formatJob` + println line by line) para
 * no romper jobs legacy o tipos futuros como `sii_receipt`.
 */

import type { Logger } from '../logger.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  type PrintJobRow,
  isKitchenJobPayload,
  isBillPreviewPayload,
  isBillProformaPayload,
  isCashClosePayload,
} from '../types.js';
import { formatJob } from './console.js';
import type { PrinterRow } from '../printers/registry.js';
import type { DiscoveredPrinter } from '../printers/discover.js';
import { AGENT_VERSION } from '../constants.js';
import { sendEscPos, type PopulatePrinter, type CaptureContext } from '../printers/escpos-transport.js';
import {
  renderKitchenOrderEscPos,
  renderKitchenCancelEscPos,
  renderBillPreviewEscPos,
  renderBillProformaEscPos,
  renderCashCloseEscPos,
} from './escpos-layouts.js';

/**
 * Default del ancho del papel en chars cuando NO hay info en el payload
 * ni en el PrinterRow (ej. test page sintetico). Mig 060 bait-pos suma
 * `printers.width_chars` y el payload `printer.width_chars` — el resolver
 * abajo prioriza esos sobre este default.
 */
const PRINTER_WIDTH_DEFAULT = 32;

/**
 * Resuelve el ancho del papel en chars en este orden:
 *   1. `payload.printer.width_chars` (mig 060 RPC enqueue_*)
 *   2. `printerRow.width_chars` (mig 060 SELECT del registry)
 *   3. PRINTER_WIDTH_DEFAULT (32)
 *
 * Esto es lo que se usa para:
 *   - Construir ThermalPrinter con `width` correcto (afecta leftRight padding).
 *   - Pasarlo a los layouts ESC/POS para que los separadores `'='.repeat(W)`
 *     ocupen el ancho real del papel.
 */
/**
 * Extrae el `style` del print_options del payload para etiquetar la captura
 * ESC/POS. Util para que Claude pueda filtrar capturas por estilo cuando
 * diagnostica un layout especifico.
 *
 * Si el payload no tiene print_options o el style no esta seteado, retorna
 * null y el captor escribe "(default)" en el header del .txt. No tiramos.
 */
function resolvePrintStyle(payload: unknown): string | null {
  if (
    payload &&
    typeof payload === 'object' &&
    'print_options' in payload &&
    payload.print_options &&
    typeof payload.print_options === 'object' &&
    'style' in payload.print_options
  ) {
    const s = (payload.print_options as { style?: unknown }).style;
    if (typeof s === 'string' && s.length > 0) return s;
  }
  return null;
}

function resolvePaperWidth(payload: unknown, printer: PrinterRow): number {
  const fromPayload =
    payload &&
    typeof payload === 'object' &&
    'printer' in payload &&
    payload.printer &&
    typeof payload.printer === 'object' &&
    'width_chars' in payload.printer
      ? (payload.printer as { width_chars?: number }).width_chars
      : undefined;
  if (typeof fromPayload === 'number' && fromPayload > 0) {
    return fromPayload;
  }
  if (typeof printer.width_chars === 'number' && printer.width_chars > 0) {
    return printer.width_chars;
  }
  return PRINTER_WIDTH_DEFAULT;
}

/**
 * Lineas que destacamos en negrita: cabeceras tipo "COCINA - MESA 4",
 * totales, anulaciones. El match es por keywords case-insensitive.
 *
 * Solo se usa en el flow legacy (fallback) y en `renderTestPage`. Los layouts
 * nuevos en `escpos-layouts.ts` aplican bold/invert/double-height
 * directamente sin depender de este matcher.
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
 * Construye el `populate` callback que el transport va a invocar con un
 * `ThermalPrinter` ya instanciado. Hace el dispatch por job_type a la
 * funcion ESC/POS correspondiente.
 *
 * Si el job_type no tiene layout dedicado (sii_receipt, futuros) o el
 * payload no matchea el type guard esperado, cae al flow legacy:
 * `formatJob()` genera el ASCII + iteramos linea por linea aplicando
 * bold por keyword. Esto preserva compat con cualquier job pendiente
 * pre-v0.8.0.
 */
function buildPopulate(
  job: PrintJobRow,
  printer: PrinterRow,
  logger: Logger,
  supabase: SupabaseClient | undefined
): PopulatePrinter {
  return async (tp) => {
    let usedEscPosLayout = false;

    switch (job.job_type) {
      case 'kitchen_order':
      case 'bar_order': {
        if (isKitchenJobPayload(job.payload)) {
          await renderKitchenOrderEscPos(tp, job.payload, job.job_type, supabase, logger);
          usedEscPosLayout = true;
        }
        break;
      }
      case 'kitchen_cancel': {
        if (isKitchenJobPayload(job.payload)) {
          await renderKitchenCancelEscPos(tp, job.payload, supabase, logger);
          usedEscPosLayout = true;
        }
        break;
      }
      case 'bill_preview': {
        if (isBillPreviewPayload(job.payload)) {
          await renderBillPreviewEscPos(tp, job.payload, supabase, logger);
          usedEscPosLayout = true;
        }
        break;
      }
      case 'bill_proforma': {
        if (isBillProformaPayload(job.payload)) {
          await renderBillProformaEscPos(tp, job.payload, supabase, logger);
          usedEscPosLayout = true;
        }
        break;
      }
      case 'cash_close': {
        if (isCashClosePayload(job.payload)) {
          await renderCashCloseEscPos(tp, job.payload, supabase, logger);
          usedEscPosLayout = true;
        }
        break;
      }
      // sii_receipt y cualquier otro job_type futuro caen al fallback abajo.
    }

    // Fallback: si no entramos a ningun layout ESC/POS nativo (job_type
    // desconocido o payload invalido), generamos el ASCII viejo y lo
    // emitimos linea por linea para que el job no se pierda. Logueamos
    // warning para que el operador lo vea en los logs.
    if (!usedEscPosLayout) {
      logger.warn(
        { jobId: job.id, jobType: job.job_type },
        `No hay layout ESC/POS dedicado para ${job.job_type} o payload invalido — fallback ASCII`
      );
      const content = formatJob(job, logger);
      const lines = content.split('\n');
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
    }

    if (printer.beep) tp.beep();
    if (printer.cut_paper) tp.cut();
  };
}

/**
 * Imprime un job en una impresora fisica via ESC/POS.
 *
 * Flujo (refactor v0.8.0):
 *  1. `buildPopulate(job, printer, logger)` arma el callback que dispatch
 *     por job_type a la funcion de `escpos-layouts.ts` apropiada.
 *  2. Por cada copy (default 1), llamamos a `sendEscPos` del helper unificado
 *     con ese callback. El helper elige el transport:
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
  logger: Logger,
  /**
   * Cliente Supabase autenticado. Threaded down from `dispatchJob`. Si no
   * viene (caso debug renderer u otros futuros sin sesion), el helper
   * `printLogoIfEnabled` skipa el logo silenciosamente.
   */
  supabase?: SupabaseClient
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

  const copies = Math.max(1, printer.copies ?? 1);
  // Mig 060: resolver el width real del papel para construir ThermalPrinter
  // con el `width` correcto. Prioridad: payload.printer.width_chars >
  // printer.width_chars > 32.
  const width = resolvePaperWidth(job.payload, printer);

  // Contexto de captura ESC/POS (v0.9.6). Solo aplica al flow USB exitoso —
  // el transport ignora captureContext en network/bluetooth porque ahi no
  // tenemos visibilidad del buffer final (lo construye/manda ThermalPrinter
  // directo al socket).
  const style = resolvePrintStyle(job.payload);

  for (let copy = 1; copy <= copies; copy++) {
    const populate = buildPopulate(job, printer, logger, supabase);
    const captureContext: CaptureContext = {
      jobId: copies === 1 ? job.id : `${job.id}_copy${copy}`,
      jobType: job.job_type,
      style
    };
    try {
      await sendEscPos(printer, populate, logger, width, captureContext);
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
      copies,
      width
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

  // BUG QUE FIX:
  // Para USB, `target` debe ser el QUEUE NAME de Windows, NO el PortName/
  // device_id (USB001, COM7, etc). El helper resolveWindowsQueueName
  // prioriza target sobre name, y antes poniamos device_id que es el port —
  // tiraba el error CLIXML porque Win32 OpenPrinter("USB001") no existe.
  //
  // Solucion: para USB queremos que tanto name como target apunten al
  // queue name (`discovered.name` = "PrintCaja"). Para network/bluetooth,
  // device_id es el target legitimo (IP:9100 o COMn).
  const target =
    connectionType === 'usb' ? discovered.name : discovered.device_id;

  return {
    id: `test-${discovered.device_id}`,
    name: discovered.name,
    printer_type: 'thermal_test',
    connection_type: connectionType,
    target,
    print_area_id: null,
    is_primary: false,
    copies: 1,
    cut_paper: true,
    beep: false,
    // Test page: 32 por default (no sabemos el ancho real del descubrimiento).
    // Si en el futuro el descubrimiento expone el ancho fisico de la printer,
    // setearlo aca.
    width_chars: 32
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
  const width = PRINTER_WIDTH_DEFAULT;
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

  // CaptureContext sintetico para test page. Asi el .txt queda etiquetado
  // como tipo "test" y el operador lo distingue facil de un kitchen_order.
  const captureContext: CaptureContext = {
    jobId: `testpage-${discovered.device_id}-${Date.now()}`,
    jobType: 'test',
    style: null
  };

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
    }, logger, undefined, captureContext);
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
