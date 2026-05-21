/**
 * Layouts ESC/POS directos.
 *
 * A diferencia de `console.ts`/`virtual.ts` que generan strings ASCII y los
 * iteran con `println`, este modulo emite comandos ESC/POS nativos sobre el
 * `ThermalPrinter` (doble altura, invert, setTextSize, printQR). El resultado
 * en papel es mas legible: titulos grandes, totales en XL, badges invertidos,
 * QR escaneable.
 *
 * Cada funcion recibe `(tp, payload)` y NO devuelve nada — manipula el buffer
 * del printer directamente. El caller (`renderer/usb.ts`) se encarga del
 * transport (USB spooler RAW, TCP 9100, COM virtual) y de llamar `tp.cut()`
 * + `tp.beep()` segun la config de la printer.
 *
 * Convenciones de robustez:
 *  - Cualquier campo opcional (`null`/`undefined`) se omite — no rompemos
 *    el render si falta address, phone, payment, qr url, footer phrase.
 *  - `waiter_name` cae a `'-'` cuando viene vacio (no usamos email fallback
 *    aca: eso es responsabilidad de la RPC que arma el payload).
 *  - El ancho del papel default es 32 chars (58mm). `tp.leftRight(left, right)`
 *    se encarga de paddear segun el width del printer instance (sin que el
 *    caller calcule columnas a mano).
 */

import {
  printer as ThermalPrinter,
} from 'node-thermal-printer';
import {
  type KitchenJobPayload,
  type KitchenJobItem,
  type BillPreviewPayload,
  type BillProformaPayload,
  type BillItem,
  type CashClosePayload,
  type BillPaymentInfo,
  type RestaurantPrintInfo,
} from '../types.js';
import { formatCLP, formatTime, formatDateTime } from './format.js';

/**
 * Tipo del printer ya instanciado por el transport. Usamos el tipo runtime
 * del default export de node-thermal-printer (mismo truco que `escpos-transport.ts`).
 */
type Printer = InstanceType<typeof ThermalPrinter>;

/**
 * Ancho del papel en chars. Mismo valor que el resto del agente (58mm).
 * `tp.leftRight` lee `tp.getWidth()` internamente, asi que mientras el
 * transport instancie el printer con `width: 32`, los layouts funcionan sin
 * pasarle el ancho. Lo dejamos exportado por si un layout quiere paddear
 * a mano (ej: separadores con `=`).
 */
export const ESCPOS_WIDTH = 32;

// ====================================================================
// Helpers comunes
// ====================================================================

/**
 * Header de un local: nombre centrado + direccion + comuna/fono.
 *
 * Robusto: si address/comuna/phone vienen null o vacios, se omiten. Si solo
 * hay name, imprime solo eso. Termina con `drawLine()` separador.
 */
function printRestaurantHeader(tp: Printer, r: RestaurantPrintInfo): void {
  tp.alignCenter();
  tp.bold(true);
  tp.println(r.name);
  tp.bold(false);

  const address = r.address?.trim();
  if (address && address.length > 0) {
    tp.println(address);
  }

  const comuna = r.comuna?.trim() ?? '';
  const phone = r.phone?.trim() ?? '';
  if (comuna.length > 0 || phone.length > 0) {
    const parts: string[] = [];
    if (comuna.length > 0) parts.push(comuna);
    if (phone.length > 0) parts.push(`Fono ${phone}`);
    tp.println(parts.join(' · '));
  }

  tp.alignLeft();
  tp.drawLine();
}

/**
 * Footer comun a bill_preview y bill_proforma: separator + QR opcional + frase.
 *
 * - Si `print_qr_url` esta seteado, imprime QR centrado con label encima.
 *   Usamos correction 'M' (medium) y cellSize 6 para que escanee bien en 58mm.
 * - Frase: si `print_footer_phrase` viene, se imprime tal cual; sino "Gracias
 *   por su preferencia".
 */
function printBillFooter(tp: Printer, r: RestaurantPrintInfo): void {
  const qrUrl = r.print_qr_url?.trim();
  if (qrUrl && qrUrl.length > 0) {
    tp.alignCenter();
    const label = r.print_qr_label?.trim();
    if (label && label.length > 0) {
      tp.println(label);
    }
    tp.printQR(qrUrl, { cellSize: 6, correction: 'M' });
    tp.alignLeft();
    tp.drawLine();
  }

  const phrase = r.print_footer_phrase?.trim();
  const footer = phrase && phrase.length > 0 ? phrase : 'Gracias por su preferencia!';
  tp.alignCenter();
  tp.println(footer);
  tp.alignLeft();
}

/**
 * Linea "label ...... amount" alineada a los bordes. Wrap de `tp.leftRight`
 * con formato CLP en la derecha. Si `indent` es true, prefija 2 espacios al
 * label (sub-items: efectivo dentro de ventas totales, etc).
 */
function printAmountRow(
  tp: Printer,
  label: string,
  amount: number,
  indent = false
): void {
  const left = indent ? `  ${label}` : label;
  tp.leftRight(left, formatCLP(amount).replace('$ ', ''));
}

/**
 * Item de boleta/precuenta: "Nombre  x{qty}   $amount". Si el nombre es muy
 * largo, lo truncamos con un punto al final — preferimos cortar a romper
 * la columna del monto.
 *
 * Usa `tp.leftRight` pero con qty embebido en el lado izquierdo para que el
 * monto quede pegado a la derecha (mas legible que columnas separadas).
 */
function printBillItem(tp: Printer, item: BillItem): void {
  const amount = formatCLP(item.subtotal).replace('$ ', '');
  const qtyPart = `x${item.quantity}`;
  // Reserva derecha aproximada: "x99   $999.999" ~ 14 chars. Nombre ocupa
  // el resto. Truncamos defensivamente para 32 chars (58mm).
  const RIGHT_RESERVE = qtyPart.length + amount.length + 2; // 2 espacios entre nombre y qty
  const nameMax = Math.max(8, ESCPOS_WIDTH - RIGHT_RESERVE - 2);
  const safeName =
    item.name.length > nameMax ? item.name.slice(0, nameMax - 1) + '.' : item.name;
  tp.leftRight(`${safeName} ${qtyPart}`, amount);
}

/**
 * Imprime un "badge" tipo " PRE-CUENTA " centrado con fondo negro (invert).
 * Compatible con la mayoria de termicas ESC/POS — fallback visual si el
 * driver ignora invert: queda como texto centrado en negrita.
 */
function printBadge(tp: Printer, text: string): void {
  tp.alignCenter();
  tp.bold(true);
  tp.invert(true);
  tp.println(` ${text} `);
  tp.invert(false);
  tp.bold(false);
  tp.alignLeft();
}

/**
 * Imprime el TOTAL en XL (doble altura + doble ancho) con la etiqueta a la
 * izquierda y el monto a la derecha. `setTextSize(height, width)` espera
 * height primero en node-thermal-printer 4.6.x.
 *
 * Nota: en setTextSize(2,2) el width efectivo del printer no cambia, asi que
 * usamos `println` con padding manual en vez de `leftRight` (que asume width
 * normal). Calculamos un layout simple "TOTAL  $X" centrado.
 */
function printXLTotal(tp: Printer, label: string, amount: number): void {
  const formatted = formatCLP(amount); // "$ 24.500"
  // En doble width el ancho efectivo se divide por 2 (16 chars en 58mm).
  // Centramos manualmente "TOTAL $24.500" o similar.
  const line = `${label} ${formatted}`;
  tp.alignCenter();
  tp.bold(true);
  tp.setTextSize(1, 1); // height=1, width=1 → un poco mas grande que normal
  // setTextSize(h,w) en node-thermal-printer: valores 0..7, donde 0=normal
  // y 1=2x. Para TOTAL queremos 2x altura y 1x ancho (mas legible y entra
  // mejor en 58mm que el quad area).
  tp.setTextDoubleHeight();
  tp.println(line);
  tp.setTextNormal();
  tp.bold(false);
  tp.alignLeft();
}

// ====================================================================
// Resolvers compartidos
// ====================================================================

/**
 * Resuelve el titulo de header de cocina/barra: area_name del payload o
 * fallback al tipo. Mismo comportamiento que `console.ts`.
 */
function resolveStationLabel(
  jobType: 'kitchen_order' | 'bar_order',
  areaName: string | null
): string {
  if (areaName && areaName.trim().length > 0) {
    return areaName.trim().toUpperCase();
  }
  return jobType === 'bar_order' ? 'BARRA' : 'COCINA';
}

/**
 * Resuelve destino: "MESA 4", "VENTA DIRECTA" o channel_code en MAYUS.
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
 * Imprime un item de cocina con modificadores y nota indentados.
 * Modifiers van con guion, notas entre corchetes.
 */
function printKitchenItem(tp: Printer, item: KitchenJobItem): void {
  tp.bold(true);
  tp.println(`${item.quantity}x ${item.name}`);
  tp.bold(false);

  for (const mod of item.modifiers) {
    tp.println(`   - ${mod.name}`);
  }

  if (item.note && item.note.trim().length > 0) {
    tp.println(`   [${item.note.trim()}]`);
  }
}

// ====================================================================
// Layouts publicos
// ====================================================================

/**
 * Comanda mejorada: header en doble altura "COCINA CALIENTE / MESA 1",
 * subtitle con mozo + hora + COMENSALES, items en bold con modifiers,
 * "TOTAL ITEMS: N" destacado al final.
 *
 * El total de items es la suma de quantities, no el count de lineas — eso
 * lo que la cocina mira para saber cuanto va a salir.
 */
export function renderKitchenOrderEscPos(
  tp: Printer,
  payload: KitchenJobPayload,
  jobType: 'kitchen_order' | 'bar_order' = 'kitchen_order'
): void {
  const station = resolveStationLabel(jobType, payload.area_name);
  const destination = resolveDestination(payload);
  const waiter = payload.waiter_name?.trim() || '-';
  const time = formatTime(payload.opened_at);

  // Header XL en 2 lineas: estacion arriba, destino abajo.
  tp.alignCenter();
  tp.bold(true);
  tp.setTextDoubleHeight();
  tp.println(station);
  tp.println(destination);
  tp.setTextNormal();
  tp.bold(false);

  // Subtitle: mozo · hora · comensales
  tp.println(`Mesero: ${waiter} · ${time}`);
  tp.println(`Comensales: ${payload.guests}`);
  tp.alignLeft();
  tp.drawLine();
  tp.newLine();

  // Items
  for (const item of payload.items) {
    printKitchenItem(tp, item);
  }

  // Nota del cliente
  if (payload.customer_note && payload.customer_note.trim().length > 0) {
    tp.drawLine();
    tp.println(`Notas mesa: ${payload.customer_note.trim()}`);
  }

  // Total items destacado (suma de quantities)
  const totalItems = payload.items.reduce((acc, it) => acc + it.quantity, 0);
  tp.drawLine();
  tp.alignCenter();
  tp.bold(true);
  tp.setTextDoubleHeight();
  tp.println(`TOTAL ÍTEMS: ${totalItems}`);
  tp.setTextNormal();
  tp.bold(false);
  tp.alignLeft();
  tp.newLine();
}

/**
 * Anulacion: header invertido "ANULACION" + destino, mismo cuerpo que
 * kitchen_order pero items con prefijo [X] para que en cocina sea evidente
 * que tienen que SACAR de la comanda anterior.
 */
export function renderKitchenCancelEscPos(
  tp: Printer,
  payload: KitchenJobPayload
): void {
  const destination = resolveDestination(payload);
  const waiter = payload.waiter_name?.trim() || '-';
  const time = formatTime(payload.opened_at);

  // Header: badge invertido "ANULACION" + destino en doble altura
  tp.alignCenter();
  tp.bold(true);
  tp.invert(true);
  tp.setTextDoubleHeight();
  tp.println(' ANULACION ');
  tp.invert(false);
  tp.println(destination);
  tp.setTextNormal();
  tp.bold(false);

  tp.println(`Mesero: ${waiter} · ${time}`);
  tp.alignLeft();
  tp.drawLine();
  tp.newLine();

  for (const item of payload.items) {
    tp.bold(true);
    tp.println(`[X] ${item.quantity}x ${item.name}`);
    tp.bold(false);
    for (const mod of item.modifiers) {
      tp.println(`    - ${mod.name}`);
    }
    if (item.note && item.note.trim().length > 0) {
      tp.println(`    [${item.note.trim()}]`);
    }
  }

  if (payload.customer_note && payload.customer_note.trim().length > 0) {
    tp.drawLine();
    tp.println(`Motivo: ${payload.customer_note.trim()}`);
  }

  tp.drawLine();
  tp.newLine();
}

/**
 * PRE-CUENTA: header del local, badge "PRE-CUENTA #N", datos de mesa,
 * items, subtotal/IVA/total XL, separador + sugerencia de propina 10%,
 * footer con QR opcional + frase custom.
 */
export function renderBillPreviewEscPos(
  tp: Printer,
  payload: BillPreviewPayload
): void {
  // Header del local
  printRestaurantHeader(tp, payload.restaurant);

  // Badge PRE-CUENTA + numero de orden
  printBadge(tp, `PRE-CUENTA #${payload.order_number}`);
  tp.newLine();

  // Linea de mesa/comensales/hora/mozo
  const time = formatTime(payload.opened_at);
  if (payload.table_number) {
    tp.println(`Mesa ${payload.table_number} · Comensales: ${payload.guests}`);
  } else {
    tp.println(`Para llevar · Comensales: ${payload.guests}`);
  }
  tp.println(`Hora: ${time}`);
  if (payload.waiter_name && payload.waiter_name.trim().length > 0) {
    tp.println(`Mesero: ${payload.waiter_name.trim()}`);
  }
  tp.drawLine();
  tp.newLine();

  // Items
  for (const item of payload.items) {
    printBillItem(tp, item);
  }

  tp.newLine();
  tp.drawLine();

  // Subtotal + IVA
  printAmountRow(tp, 'Subtotal', payload.subtotal);
  printAmountRow(tp, 'IVA (19%)', payload.iva);

  // TOTAL XL
  tp.drawLine();
  printXLTotal(tp, 'TOTAL', payload.total);
  tp.drawLine();
  tp.newLine();

  // Sugerencia de propina
  tp.bold(true);
  tp.println('Propina sugerida (10%):');
  tp.bold(false);
  printAmountRow(tp, '  Propina', payload.suggested_tip_amount, false);
  printAmountRow(tp, 'TOTAL CON PROPINA', payload.total_with_suggested_tip);
  tp.drawLine();
  tp.newLine();

  // Aviso NO tributario
  tp.alignCenter();
  tp.bold(true);
  tp.println('* Documento NO tributario *');
  tp.bold(false);
  tp.println('La boleta SII se entrega');
  tp.println('al momento del pago.');
  tp.alignLeft();
  tp.newLine();

  // Footer (QR opcional + frase custom)
  printBillFooter(tp, payload.restaurant);
  tp.newLine();
}

/**
 * BOLETA FINAL (proforma): similar al preview pero con metodo de pago,
 * propina cobrada y vuelto si efectivo. Sin sugerencia de propina (ya
 * pagada).
 */
export function renderBillProformaEscPos(
  tp: Printer,
  payload: BillProformaPayload
): void {
  // Header del local
  printRestaurantHeader(tp, payload.restaurant);

  // Badge BOLETA + numero
  printBadge(tp, `BOLETA #${payload.order_number}`);
  tp.newLine();

  // Linea de mesa/comensales/hora/mozo
  const time = formatTime(payload.opened_at);
  if (payload.table_number) {
    tp.println(`Mesa ${payload.table_number} · Comensales: ${payload.guests}`);
  } else {
    tp.println(`Para llevar · Comensales: ${payload.guests}`);
  }
  tp.println(`Hora: ${time}`);
  if (payload.waiter_name && payload.waiter_name.trim().length > 0) {
    tp.println(`Mesero: ${payload.waiter_name.trim()}`);
  }
  tp.drawLine();
  tp.newLine();

  // Items
  for (const item of payload.items) {
    printBillItem(tp, item);
  }

  tp.newLine();
  tp.drawLine();

  // Subtotal + IVA
  printAmountRow(tp, 'Subtotal', payload.subtotal);
  printAmountRow(tp, 'IVA (19%)', payload.iva);

  // Propina cobrada (si > 0)
  const tip = payload.tip_amount ?? 0;
  if (tip > 0) {
    printAmountRow(tp, 'Propina', tip);
  }

  // TOTAL XL = subtotal + iva + tip (lo manda la RPC en payload.total + tip si
  // el flow lo separa; aca tomamos lo que viene en `total` como base + tip).
  // Para evitar ambiguedad: imprimimos total tal cual viene; si la RPC ya
  // incluye propina, no la sumamos.
  tp.drawLine();
  printXLTotal(tp, 'TOTAL', payload.total + tip);
  tp.drawLine();
  tp.newLine();

  // Metodo de pago
  if (payload.payment) {
    printPaymentSection(tp, payload.payment, payload.total + tip);
    tp.drawLine();
    tp.newLine();
  }

  // Aviso NO tributario
  tp.alignCenter();
  tp.bold(true);
  tp.println('* Documento NO tributario *');
  tp.bold(false);
  tp.println('La boleta SII se entrega');
  tp.println('aparte si corresponde.');
  tp.alignLeft();
  tp.newLine();

  // Footer (QR opcional + frase custom)
  printBillFooter(tp, payload.restaurant);
  tp.newLine();
}

/**
 * Seccion de medio de pago. Renderiza tarjeta MP con last4, efectivo con
 * recibido + vuelto, o solo el label en los demas casos.
 */
function printPaymentSection(
  tp: Printer,
  payment: BillPaymentInfo,
  _totalCharged: number
): void {
  tp.bold(true);
  tp.println(`Pago: ${payment.method_label}`);
  tp.bold(false);

  if (payment.method === 'cash') {
    if (payment.received_cash != null) {
      printAmountRow(tp, '  Recibido', payment.received_cash, false);
    }
    if (payment.change != null && payment.change > 0) {
      printAmountRow(tp, '  Vuelto', payment.change, false);
    }
    return;
  }

  if (payment.method === 'card_mp') {
    const last4 = payment.mp_last_four?.trim();
    if (last4 && last4.length > 0) {
      tp.println(`  Tarjeta •••• ${last4}`);
    }
    const auth = payment.mp_authorization_code?.trim();
    if (auth && auth.length > 0) {
      tp.println(`  Cod. autorizacion: ${auth}`);
    }
  }
}

/**
 * Cierre Z (cash_close) con header doble altura y desglose claro. Mismo
 * contenido que el render ASCII, mejor presentado.
 */
export function renderCashCloseEscPos(
  tp: Printer,
  payload: CashClosePayload
): void {
  // Header XL
  tp.alignCenter();
  tp.bold(true);
  tp.setTextDoubleHeight();
  tp.println('CIERRE DE CAJA');
  tp.setTextNormal();
  tp.println('DIARIO');
  tp.bold(false);

  if (payload.location_name && payload.location_name.trim().length > 0) {
    tp.println(payload.location_name.trim());
  }
  tp.println(formatDateTime(payload.closed_at));

  const openedBy = payload.opened_by_name?.trim() || '-';
  const closedBy = payload.closed_by_name?.trim() || '-';
  tp.println(`Turno: ${openedBy} → ${closedBy}`);

  tp.alignLeft();
  tp.drawLine();
  tp.newLine();

  // Ventas totales + desglose
  tp.bold(true);
  printAmountRow(tp, 'Ventas totales', payload.total_sales);
  tp.bold(false);
  printAmountRow(tp, 'Efectivo', payload.total_cash, true);
  printAmountRow(tp, 'Tarjeta MP', payload.total_card_mp, true);
  printAmountRow(tp, 'Otras tarjetas', payload.total_card_other, true);
  printAmountRow(tp, 'Transferencia', payload.total_transfer, true);
  tp.newLine();

  // Propinas + devoluciones + comandas
  printAmountRow(tp, 'Propinas', payload.total_tips);
  printAmountRow(tp, 'Devoluciones', payload.total_refunds);
  tp.leftRight('Comandas totales:', String(payload.order_count));
  tp.newLine();

  // Caja esperada vs declarada
  tp.drawLine();
  printAmountRow(tp, 'Efectivo esperado', payload.expected_cash);
  printAmountRow(tp, 'Efectivo declarado', payload.closing_cash);

  // Diferencia destacada
  tp.bold(true);
  printAmountRow(tp, 'DIFERENCIA', payload.difference);
  tp.bold(false);

  // Notas
  if (payload.notes && payload.notes.trim().length > 0) {
    tp.drawLine();
    tp.println(`Notas: ${payload.notes.trim()}`);
  }

  tp.drawLine();
  tp.newLine();
}
