/**
 * Console renderer (Sprint 2): toma un PrintJobRow y muestra en stdout
 * un ASCII art que simula la salida de una impresora termica 58mm (32 chars).
 *
 * No habla con hardware real: solo console.log. La idea es validar el
 * pipeline Realtime -> renderJob -> marcar printed antes de cablear ESC/POS.
 */

import {
  type PrintJobRow,
  type KitchenJobPayload,
  type KitchenJobItem,
  type BillPreviewPayload,
  type BillProformaPayload,
  type CashClosePayload,
  isKitchenJobPayload,
  isBillPreviewPayload,
  isBillProformaPayload,
  isCashClosePayload
} from '../types.js';
import { type Logger } from '../logger.js';
import {
  line,
  divider,
  padCenter,
  padLeft,
  formatCLP,
  formatTime,
  formatDateTime,
  wrap
} from './format.js';

const WIDTH = 32;

/**
 * Construye el string ASCII completo del job (sin imprimirlo). Es la
 * funcion compartida entre el renderer de consola y el virtual: ambos
 * generan el mismo bloque y deciden donde mandarlo (stdout vs archivo).
 *
 * Si el job_type no tiene layout, retorna un fallback con dump del
 * payload + warning, asi el caller puede igual marcarlo como printed.
 */
export function formatJob(job: PrintJobRow, logger: Logger): string {
  switch (job.job_type) {
    case 'kitchen_order':
    case 'bar_order': {
      if (isKitchenJobPayload(job.payload)) {
        return renderKitchenOrder(job.job_type, job.payload);
      }
      return unsupportedFallback(job, logger, 'payload no matchea KitchenJobPayload');
    }

    case 'kitchen_cancel': {
      if (isKitchenJobPayload(job.payload)) {
        return renderKitchenCancel(job.payload);
      }
      return unsupportedFallback(job, logger, 'payload no matchea KitchenJobPayload');
    }

    case 'bill_preview': {
      if (isBillPreviewPayload(job.payload)) {
        return renderBillPreview(job.payload);
      }
      return unsupportedFallback(job, logger, 'payload no matchea BillPreviewPayload');
    }

    case 'bill_proforma': {
      if (isBillProformaPayload(job.payload)) {
        return renderBillProforma(job.payload);
      }
      return unsupportedFallback(job, logger, 'payload no matchea BillProformaPayload');
    }

    case 'cash_close': {
      if (isCashClosePayload(job.payload)) {
        return renderCashClose(job.payload);
      }
      return unsupportedFallback(job, logger, 'payload no matchea CashClosePayload');
    }

    case 'sii_receipt': {
      // El payload de sii_receipt no esta cerrado todavia (Sprint 4).
      logger.warn(`job_type sii_receipt no soportado todavia (Sprint 4)`);
      const out: string[] = [];
      out.push(line(WIDTH));
      out.push(padCenter('TODO: SII RECEIPT', WIDTH));
      out.push(padCenter('Implementar en Sprint 4', WIDTH));
      out.push(line(WIDTH));
      out.push(JSON.stringify(job.payload, null, 2));
      out.push('');
      return out.join('\n');
    }

    default: {
      return unsupportedFallback(job, logger, 'job_type desconocido');
    }
  }
}

/**
 * Punto de entrada del renderer de consola. Construye el bloque ASCII
 * y lo manda a stdout como un unico console.log con '\n' embebido.
 */
export async function renderJob(job: PrintJobRow, logger: Logger): Promise<void> {
  logger.info(`Renderizando job ${job.id} tipo ${job.job_type}`);
  console.log(formatJob(job, logger));
}

// ====================================================================
// Helpers internos por layout
// ====================================================================

/**
 * Fallback string cuando un payload no matchea su type guard o llega un
 * job_type sin layout. Loguea warning y retorna el dump del payload para
 * que igual quede visible en el output.
 */
function unsupportedFallback(job: PrintJobRow, logger: Logger, reason: string): string {
  logger.warn(`job_type ${job.job_type} no soportado en renderer todavia: ${reason}`);
  return JSON.stringify(job.payload, null, 2) + '\n';
}

/**
 * Resuelve el titulo del header de cocina/barra a partir del job_type
 * y el area_name opcional del payload.
 *
 * - bar_order + area "Barra Central" -> "BARRA CENTRAL"
 * - bar_order sin area -> "BARRA"
 * - kitchen_order + area "Cocina Caliente" -> "COCINA CALIENTE"
 * - kitchen_order sin area -> "COCINA"
 */
function resolveStationLabel(jobType: 'kitchen_order' | 'bar_order', areaName: string | null): string {
  if (areaName && areaName.trim().length > 0) {
    return areaName.trim().toUpperCase();
  }
  return jobType === 'bar_order' ? 'BARRA' : 'COCINA';
}

/**
 * Resuelve el destino: "MESA 4", "VENTA DIRECTA" o channel_code en MAYUS.
 */
function resolveDestination(payload: KitchenJobPayload): string {
  if (payload.table_number) {
    return `MESA ${payload.table_number}`;
  }
  if (payload.channel_code) {
    return payload.channel_code.toUpperCase();
  }
  return 'VENTA DIRECTA';
}

/**
 * Renderiza un item de cocina: linea principal + modifiers indentados + note.
 *
 * Formato:
 *   "  2x Lomo a lo pobre"
 *   "     - Sin huevo"
 *   "     [Punto medio]"
 */
function renderKitchenItem(item: KitchenJobItem, qtyPrefix = '  '): string[] {
  const lines: string[] = [];
  lines.push(`${qtyPrefix}${item.quantity}x ${item.name}`);

  for (const mod of item.modifiers) {
    lines.push(`     - ${mod.name}`);
  }

  if (item.note && item.note.trim().length > 0) {
    lines.push(`     [${item.note.trim()}]`);
  }

  return lines;
}

/**
 * Layout kitchen_order / bar_order. Header + items + nota de la mesa.
 */
function renderKitchenOrder(jobType: 'kitchen_order' | 'bar_order', payload: KitchenJobPayload): string {
  const out: string[] = [];

  const station = resolveStationLabel(jobType, payload.area_name);
  const destination = resolveDestination(payload);
  const title = `${station} - ${destination}`;

  const waiter = payload.waiter_name ?? '—';
  const time = formatTime(payload.opened_at);
  const subtitle = `Mesero: ${waiter} · ${time}`;

  out.push(line(WIDTH));
  out.push(padCenter(title, WIDTH));
  out.push(padCenter(subtitle, WIDTH));
  out.push(line(WIDTH));
  out.push('');

  for (const item of payload.items) {
    for (const itemLine of renderKitchenItem(item)) {
      out.push(itemLine);
    }
  }

  if (payload.customer_note && payload.customer_note.trim().length > 0) {
    out.push(divider(WIDTH));
    // Wrap a width - 6 para dejar margen visual (3 espacios izq + 3 cushion)
    const noteLines = wrap(`Notas mesa: ${payload.customer_note.trim()}`, WIDTH - 6);
    for (const noteLine of noteLines) {
      out.push(`   ${noteLine}`);
    }
  }

  out.push(line(WIDTH));
  out.push('');

  return out.join('\n');
}

/**
 * Layout kitchen_cancel. Mismo esqueleto que kitchen_order pero header
 * "ANULACION - MESA X" y cada item con "[X]" en vez de cantidad cruda.
 */
function renderKitchenCancel(payload: KitchenJobPayload): string {
  const out: string[] = [];

  const destination = resolveDestination(payload);
  const title = `ANULACION - ${destination}`;

  const waiter = payload.waiter_name ?? '—';
  const time = formatTime(payload.opened_at);
  const subtitle = `Mesero: ${waiter} · ${time}`;

  out.push(line(WIDTH));
  out.push(padCenter(title, WIDTH));
  out.push(padCenter(subtitle, WIDTH));
  out.push(line(WIDTH));
  out.push('');

  for (const item of payload.items) {
    // Prefijo [X] indica anulacion. Mantenemos modifiers/notes por si la
    // anulacion es parcial (ej: "saquen solo el huevo").
    out.push(`  [X] ${item.quantity}x ${item.name}`);
    for (const mod of item.modifiers) {
      out.push(`     - ${mod.name}`);
    }
    if (item.note && item.note.trim().length > 0) {
      out.push(`     [${item.note.trim()}]`);
    }
  }

  if (payload.customer_note && payload.customer_note.trim().length > 0) {
    out.push(divider(WIDTH));
    const noteLines = wrap(`Motivo: ${payload.customer_note.trim()}`, WIDTH - 6);
    for (const noteLine of noteLines) {
      out.push(`   ${noteLine}`);
    }
  }

  out.push(line(WIDTH));
  out.push('');

  return out.join('\n');
}

/**
 * Renderiza una linea de item de boleta/proforma: nombre + "x{qty}" + monto
 * a la derecha. La columna del monto se reserva con padLeft a partir del
 * ancho restante.
 *
 * Ejemplo (32 chars):
 *   "Lomo a lo pobre   x2    24.000"
 *
 * Si el nombre es muy largo, lo trunca para dejar la columna de monto
 * alineada (preferimos truncar nombre a romper alineacion).
 */
function renderBillItemLine(
  name: string,
  qty: number,
  subtotal: number,
  width = WIDTH
): string {
  // formatCLP devuelve "$ 24.500"; en boletas el header ya muestra moneda
  // entonces sacamos el "$ " y mostramos solo el numero formateado.
  const amount = formatCLP(subtotal).replace('$ ', '');
  const qtyPart = `x${qty}`;

  // Reserva: nombre + 2 espacios + qty + 4 espacios + amount
  // Ej: "Lomo a lo pobre" + "  " + "x2" + "    " + "24.000"
  const amountCol = padLeft(amount, 8); // ancho fijo de la columna monto
  const reservedRight = qtyPart.length + 4 + amountCol.length;
  const nameMax = width - reservedRight;

  const safeName = name.length > nameMax ? name.slice(0, nameMax - 1) + '.' : name;
  const namePart = safeName.padEnd(nameMax, ' ');

  return `${namePart}${qtyPart}    ${amountCol}`;
}

/**
 * Layout bill_proforma. Header con datos del local, linea de mesa,
 * items, subtotal/IVA/total, footer NO tributario.
 */
function renderBillProforma(payload: BillProformaPayload): string {
  const out: string[] = [];

  // Header del local
  out.push(line(WIDTH));
  out.push(padCenter(payload.restaurant.name, WIDTH));
  if (payload.restaurant.address && payload.restaurant.address.trim().length > 0) {
    out.push(padCenter(payload.restaurant.address.trim(), WIDTH));
  }
  // Tercera linea con comuna + fono si alguno existe
  const comuna = payload.restaurant.comuna?.trim() ?? '';
  const phone = payload.restaurant.phone?.trim() ?? '';
  if (comuna.length > 0 || phone.length > 0) {
    const parts: string[] = [];
    if (comuna.length > 0) parts.push(comuna);
    if (phone.length > 0) parts.push(`Fono ${phone}`);
    out.push(padCenter(parts.join(' · '), WIDTH));
  }
  out.push(line(WIDTH));

  // Linea de mesa
  const time = formatTime(payload.opened_at);
  if (payload.table_number) {
    out.push(`Mesa ${payload.table_number}   Comensales: ${payload.guests}   ${time}`);
  } else {
    out.push(`Para llevar   Comensales: ${payload.guests}   ${time}`);
  }
  if (payload.waiter_name) {
    out.push(`Mesero: ${payload.waiter_name}`);
  }
  out.push(divider(WIDTH));
  out.push('');

  // Items
  for (const item of payload.items) {
    out.push(renderBillItemLine(item.name, item.quantity, item.subtotal));
  }

  out.push('');
  out.push(divider(WIDTH));

  // Subtotal + IVA + Total
  const subtotalLabel = 'Subtotal';
  const ivaLabel = 'IVA (19%)';
  const totalLabel = 'TOTAL';

  const subtotalAmount = formatCLP(payload.subtotal).replace('$ ', '');
  const ivaAmount = formatCLP(payload.iva).replace('$ ', '');
  const totalAmount = formatCLP(payload.total).replace('$ ', '');

  // Columna derecha de 10 chars para amounts (cubre hasta $9.999.999)
  out.push(subtotalLabel + padLeft(subtotalAmount, WIDTH - subtotalLabel.length));
  out.push(ivaLabel + padLeft(ivaAmount, WIDTH - ivaLabel.length));
  out.push(line(WIDTH));
  out.push(totalLabel + padLeft(totalAmount, WIDTH - totalLabel.length));
  out.push(line(WIDTH));
  out.push('');

  // Footer NO tributario
  out.push(padCenter('* Documento NO tributario *', WIDTH));
  out.push(padCenter('La boleta SII se entrega', WIDTH));
  out.push(padCenter('al momento del pago.', WIDTH));
  out.push('');
  out.push(padCenter('Gracias por su preferencia!', WIDTH));
  out.push('');

  return out.join('\n');
}

/**
 * Layout bill_preview (PRE-CUENTA). Similar al bill_proforma pero con
 * propina sugerida 10% y sin metodo de pago (todavia no se cobro).
 * Solo se usa en el renderer de debug (console/virtual). El render real
 * en impresora va por escpos-layouts.ts con doble altura + QR.
 */
function renderBillPreview(payload: BillPreviewPayload): string {
  const out: string[] = [];

  // Header del local
  out.push(line(WIDTH));
  out.push(padCenter(payload.restaurant.name, WIDTH));
  if (payload.restaurant.address && payload.restaurant.address.trim().length > 0) {
    out.push(padCenter(payload.restaurant.address.trim(), WIDTH));
  }
  const comuna = payload.restaurant.comuna?.trim() ?? '';
  const phone = payload.restaurant.phone?.trim() ?? '';
  if (comuna.length > 0 || phone.length > 0) {
    const parts: string[] = [];
    if (comuna.length > 0) parts.push(comuna);
    if (phone.length > 0) parts.push(`Fono ${phone}`);
    out.push(padCenter(parts.join(' · '), WIDTH));
  }
  out.push(line(WIDTH));

  // Badge PRE-CUENTA + numero
  out.push(padCenter(`* PRE-CUENTA #${payload.order_number} *`, WIDTH));
  out.push(line(WIDTH));

  // Linea de mesa
  const time = formatTime(payload.opened_at);
  if (payload.table_number) {
    out.push(`Mesa ${payload.table_number}   Comensales: ${payload.guests}   ${time}`);
  } else {
    out.push(`Para llevar   Comensales: ${payload.guests}   ${time}`);
  }
  if (payload.waiter_name) {
    out.push(`Mesero: ${payload.waiter_name}`);
  }
  out.push(divider(WIDTH));
  out.push('');

  // Items
  for (const item of payload.items) {
    out.push(renderBillItemLine(item.name, item.quantity, item.subtotal));
  }

  out.push('');
  out.push(divider(WIDTH));

  // Subtotal + IVA + Total
  const subtotalLabel = 'Subtotal';
  const ivaLabel = 'IVA (19%)';
  const totalLabel = 'TOTAL';

  const subtotalAmount = formatCLP(payload.subtotal).replace('$ ', '');
  const ivaAmount = formatCLP(payload.iva).replace('$ ', '');
  const totalAmount = formatCLP(payload.total).replace('$ ', '');

  out.push(subtotalLabel + padLeft(subtotalAmount, WIDTH - subtotalLabel.length));
  out.push(ivaLabel + padLeft(ivaAmount, WIDTH - ivaLabel.length));
  out.push(line(WIDTH));
  out.push(totalLabel + padLeft(totalAmount, WIDTH - totalLabel.length));
  out.push(line(WIDTH));
  out.push('');

  // Propina sugerida
  out.push('Propina sugerida (10%):');
  const tipAmount = formatCLP(payload.suggested_tip_amount).replace('$ ', '');
  const totalWithTipAmount = formatCLP(payload.total_with_suggested_tip).replace('$ ', '');
  out.push('  Propina' + padLeft(tipAmount, WIDTH - '  Propina'.length));
  const totalTipLabel = 'TOTAL CON PROPINA';
  out.push(totalTipLabel + padLeft(totalWithTipAmount, WIDTH - totalTipLabel.length));
  out.push(divider(WIDTH));
  out.push('');

  // Footer NO tributario
  out.push(padCenter('* Documento NO tributario *', WIDTH));
  out.push(padCenter('La boleta SII se entrega', WIDTH));
  out.push(padCenter('al momento del pago.', WIDTH));
  out.push('');

  const footerPhrase = payload.restaurant.print_footer_phrase?.trim();
  const footer = footerPhrase && footerPhrase.length > 0 ? footerPhrase : 'Gracias por su preferencia!';
  out.push(padCenter(footer, WIDTH));
  out.push('');

  return out.join('\n');
}

/**
 * Helper para imprimir filas "etiqueta ............ monto" alineadas
 * a los bordes. Si indent es true, agrega 2 espacios al inicio (sub-items).
 */
function renderAmountRow(label: string, amount: number, indent = false): string {
  const prefix = indent ? '  ' : '';
  const formatted = formatCLP(amount).replace('$ ', '');
  const left = `${prefix}${label}`;
  return left + padLeft(formatted, WIDTH - left.length);
}

/**
 * Layout cash_close. Header + ventas totales (con desglose por metodo)
 * + propinas/devoluciones/comandas + caja esperada vs declarada + diff.
 */
function renderCashClose(payload: CashClosePayload): string {
  const out: string[] = [];

  // Header
  out.push(line(WIDTH));
  out.push(padCenter('CIERRE DE CAJA · DIARIO', WIDTH));
  if (payload.location_name && payload.location_name.trim().length > 0) {
    out.push(padCenter(payload.location_name.trim(), WIDTH));
  }
  out.push(padCenter(formatDateTime(payload.closed_at), WIDTH));

  const openedBy = payload.opened_by_name?.trim() ?? '—';
  const closedBy = payload.closed_by_name?.trim() ?? '—';
  out.push(padCenter(`Turno: ${openedBy} →`, WIDTH));
  out.push(padCenter(`       ${closedBy}`, WIDTH));
  out.push(line(WIDTH));
  out.push('');

  // Ventas totales + desglose
  out.push(renderAmountRow('Ventas totales', payload.total_sales));
  out.push(renderAmountRow('Efectivo', payload.total_cash, true));
  out.push(renderAmountRow('Tarjeta MP', payload.total_card_mp, true));
  out.push(renderAmountRow('Otras tarjetas', payload.total_card_other, true));
  out.push(renderAmountRow('Transferencia', payload.total_transfer, true));
  out.push('');

  // Propinas + devoluciones + comandas
  out.push(renderAmountRow('Propinas', payload.total_tips));
  out.push(renderAmountRow('Devoluciones', payload.total_refunds));
  const countLine = 'Comandas totales:';
  const countStr = String(payload.order_count);
  out.push(countLine + padLeft(countStr, WIDTH - countLine.length));
  out.push('');

  // Caja esperada vs declarada
  out.push(divider(WIDTH));
  out.push(renderAmountRow('Efectivo esperado', payload.expected_cash));
  out.push(renderAmountRow('Efectivo declarado', payload.closing_cash));
  out.push(renderAmountRow('Diferencia', payload.difference));

  // Notas opcionales del cierre
  if (payload.notes && payload.notes.trim().length > 0) {
    out.push(divider(WIDTH));
    const noteLines = wrap(`Notas: ${payload.notes.trim()}`, WIDTH - 4);
    for (const noteLine of noteLines) {
      out.push(`  ${noteLine}`);
    }
  }

  out.push(line(WIDTH));
  out.push('');

  return out.join('\n');
}
