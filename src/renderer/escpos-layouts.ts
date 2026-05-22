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
import type { SupabaseClient } from '@supabase/supabase-js';
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
import type { Logger } from '../logger.js';
import { formatCLP, formatTime, formatDateTime } from './format.js';
import { getLogoPath } from './logo-cache.js';

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
 *
 * --------------------------------------------------------------------
 * BUG REPORTADO (Carlos, 2026-05-22): "items aparecen cargados a la
 * izquierda en la pre-cuenta y boleta — el monto no se ve a la derecha".
 *
 * Estado del diagnostico: PENDIENTE (sin termica fisica disponible en
 * sesion Phase 4). El renderer YA usa tp.leftRight(), asi que el bug
 * no es "se olvidaron de alinear a la derecha". Hipotesis a verificar
 * con tickets reales en Phase 5 (QA con Carlos en La Cocina):
 *
 *   - Hipotesis A: formatCLP(...).replace('$ ', '') quita el signo peso
 *     y el separador de miles. El monto formatted termina mas corto de
 *     lo esperado ("8000" sale "8.000" pero sin "$ " son 5 chars; con
 *     "$ " serian 7). leftRight padea con espacios entre left y right;
 *     si el right es muy corto, el padding crece y visualmente queda
 *     "el numero pegado a la derecha pero la sensacion es de mucho
 *     whitespace en el medio". Fix candidato: NO quitar el '$ ' del
 *     monto (mantener "$ 8.000" como right).
 *
 *   - Hipotesis B: items con `note` se imprimen aparte con
 *     `tp.println(`   [${note}]`)` (ver printKitchenItem, no aplica a
 *     bill_*, pero si la cocina lo replica en bill, romperia). En el
 *     renderer actual de bill_*, los items NO tienen note — pero si
 *     en algun momento se sumara (kitchen + bill comparten KitchenJobItem
 *     vs BillItem son tipos distintos), revisar este path.
 *
 *   - Hipotesis C: tp.leftRight() en double-width no aplica para items
 *     (estan en width normal), pero el calculo de RIGHT_RESERVE no
 *     considera bien el caso "monto chico" — si amount="1.000" son 5
 *     chars + qtyPart="x1" son 2 + 2 espacios = 9 chars reservados a
 *     la derecha. nameMax = 32 - 9 - 2 = 21. Para "Cazuela" (7 chars)
 *     queda  "Cazuela x1                1.000" — visualmente OK pero
 *     muchos espacios en medio. NO es bug funcional.
 *
 * TODO Phase 5 (Carlos + termica fisica):
 *   1. Imprimir 4 items con distintas combinaciones de nombre/monto.
 *   2. Tomar foto del papel.
 *   3. Si confirma Hipotesis A: cambiar `replace('$ ', '')` por dejar
 *      el "$ " intacto. La columna se vera "$ 8.000" en vez de "8.000"
 *      pero queda mas pegada a la derecha del leftRight.
 *   4. Si confirma Hipotesis B: poner notas con leftRight tambien o
 *      como segunda linea indentada uniforme.
 *   5. Si es solo estetica (Hipotesis C): no aplicar fix, agregar nota
 *      en docs/PRINTING.md.
 * --------------------------------------------------------------------
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

/**
 * Set de chars CP437-safe permitidos para `print_ornament_char`. La mayoria
 * de termicas Rongta 58mm renderizan estos sin reemplazar por '?'. Ver D6
 * del spec (`docs/superpowers/specs/2026-05-22-print-templates-editor-design.md`).
 *
 * Si el dueño elige un char fuera de este set (UI debe filtrarlo, pero
 * defensivo aca tambien), `ornamentSep` reemplaza por '*' silenciosamente.
 */
const CP437_SAFE_ORNAMENTS = ['♥', '♦', '●', '○', '■', '▲', '►'] as const;
type Cp437Ornament = (typeof CP437_SAFE_ORNAMENTS)[number];

function isCp437SafeOrnament(char: string): char is Cp437Ornament {
  return (CP437_SAFE_ORNAMENTS as readonly string[]).includes(char);
}

/**
 * Imprime un separador horizontal de exactamente 32 chars. Si `char` es
 * truthy y CP437-safe, lo embebe centrado: `'='.repeat(14) + ' ' + char + ' '
 * + '='.repeat(15)` = 32 chars. Si `char` no es CP437-safe, reemplaza por '*'
 * (fallback defensivo, D6). Si `char` es null/undefined/'', imprime un linea
 * plana de 32 '='.
 *
 * Por que `ESCPOS_WIDTH = 32` constante: el ancho del papel del agente es
 * fijo (58mm). Si en el futuro se soporta 80mm, esta funcion necesita conocer
 * el width — pasarlo como parametro o leer de tp.getWidth().
 */
function ornamentSep(tp: Printer, char: string | null | undefined): void {
  if (!char || char.length === 0) {
    tp.println('='.repeat(ESCPOS_WIDTH));
    return;
  }

  // Fallback CP437: si no esta en el set permitido, usar '*'. No tiramos
  // error para no romper el ticket completo por un char malo.
  const safe = isCp437SafeOrnament(char) ? char : '*';
  // 14 + ' ' + 1 (char) + ' ' + 15 = 32 chars. La asimetria (14 vs 15) es
  // para que el char quede en la posicion 15-16 visualmente centrado.
  tp.println('='.repeat(14) + ' ' + safe + ' ' + '='.repeat(15));
}

/**
 * Si el restaurant tiene logo configurado Y el print_options activo lo
 * pide (`showLogo: true`), descarga (cache + signed URL) y lo imprime
 * centrado. Si algo falla (signed URL expirada, fetch fail, printer no
 * soporta printImage), loguea warning y skipa — el ticket sigue saliendo
 * sin logo.
 *
 * `print_options` con `showLogo` opcional: cubre BillPreviewOptions,
 * BillProformaOptions y casos futuros donde sumemos `showLogo` a comanda.
 * Si el `print_options` viene undefined o el toggle es false, retorna
 * sin hacer nada.
 *
 * NOTE: la firma del helper es async. El caller (renderBillPreviewEscPos,
 * etc) debe awaitearlo. PopulatePrinter desde v0.9.0 acepta retorno
 * Promise<void>.
 */
async function printLogoIfEnabled(
  tp: Printer,
  payload: {
    restaurant: RestaurantPrintInfo;
    print_options?: { showLogo?: boolean };
  },
  supabase: SupabaseClient | undefined,
  logger: Logger
): Promise<void> {
  // Toggle del usuario: solo imprimimos si explicitamente esta on. Si
  // viene undefined (RPC pre-mig 058), aplica un default razonable que
  // es: imprimir SI hay logo configurado. Decision: respetar el toggle
  // estricto — si el dueño no eligio activarlo, no imprimir.
  if (payload.print_options?.showLogo !== true) return;

  const { print_logo_path, print_logo_hash } = payload.restaurant;
  if (!print_logo_path || !print_logo_hash) return;

  if (!supabase) {
    logger.warn(
      { restaurantName: payload.restaurant.name },
      'printLogoIfEnabled: sin supabase client, skipando logo'
    );
    return;
  }

  try {
    const localPath = await getLogoPath(print_logo_path, print_logo_hash, supabase);
    if (!localPath) return; // path/hash nulos en runtime (no deberia llegar aca)

    tp.alignCenter();
    // node-thermal-printer printImage es async. La firma del runtime acepta
    // path local a un PNG (idealmente 1-bit dithered 384px ancho como guarda
    // el pipeline de bait-pos).
    await tp.printImage(localPath);
    tp.alignLeft();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn(
      { restaurantName: payload.restaurant.name, error: msg },
      `printLogoIfEnabled fallo: ${msg} — sigo sin logo`
    );
    // Intentar alinear de nuevo a izquierda por si la falla dejo el estado
    // ambiguo (defensive).
    try {
      tp.alignLeft();
    } catch {
      // ignorar
    }
  }
}

// ====================================================================
// Resolvers compartidos
// ====================================================================

/**
 * Resuelve el titulo de header de cocina/barra. Precedencia:
 *   1. printer_name (mig 050+056 lo setea siempre)
 *   2. area_name (fallback payloads viejos)
 *   3. default por job_type
 * Ver console.ts para racional completo. Mismo comportamiento.
 */
function resolveStationLabel(
  jobType: 'kitchen_order' | 'bar_order',
  printerName: string | null | undefined,
  areaName: string | null
): string {
  if (printerName && printerName.trim().length > 0) {
    return printerName.trim().toUpperCase();
  }
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
 *
 * NOTE (Task 4.4 refactor v0.9.0): renombrada de `renderKitchenOrderEscPos`
 * a `renderKitchenOrderClassic`. La funcion publica con el nombre original
 * vive abajo (seccion "Dispatchers") y elige entre styles via print_options.
 * Para kitchen_order no hay otros styles (Carlos prefiere classic) pero
 * mantenemos el dispatcher para consistencia + futura extensibilidad.
 */
function renderKitchenOrderClassic(
  tp: Printer,
  payload: KitchenJobPayload,
  jobType: 'kitchen_order' | 'bar_order' = 'kitchen_order'
): void {
  const station = resolveStationLabel(jobType, payload.printer_name, payload.area_name);
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
 *
 * NOTE (Task 4.4 refactor v0.9.0): renombrada a `renderKitchenCancelClassic`.
 * Dispatcher publico abajo.
 */
function renderKitchenCancelClassic(
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
 *
 * NOTE (Task 4.4 refactor v0.9.0): renombrada a `renderBillPreviewClassic`.
 * Dispatcher publico abajo elige entre 4 styles (classic/minimal/brand/thermal_pro)
 * segun `payload.print_options?.style`. Si no viene, default 'classic'.
 */
async function renderBillPreviewClassic(
  tp: Printer,
  payload: BillPreviewPayload,
  supabase: SupabaseClient | undefined,
  logger: Logger
): Promise<void> {
  // Logo si esta activo (D4 + D5 del spec). Si falla, sigue sin logo.
  await printLogoIfEnabled(tp, payload, supabase, logger);

  // Header del local (nombre + direccion + comuna/fono).
  printRestaurantHeader(tp, payload.restaurant);

  // Slogan si esta seteado (mig 058).
  const slogan = payload.restaurant.slogan?.trim();
  if (slogan && slogan.length > 0) {
    tp.alignCenter();
    tp.println(`"${slogan}"`);
    tp.alignLeft();
  }

  // Separador con vineta CP437 (sobreescribe el drawLine() del header).
  ornamentSep(tp, payload.restaurant.print_ornament_char ?? null);

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

  // Separador con vineta antes del footer
  ornamentSep(tp, payload.restaurant.print_ornament_char ?? null);

  // Footer (QR opcional + frase custom)
  printBillFooter(tp, payload.restaurant);
  tp.newLine();
}

/**
 * BOLETA FINAL (proforma): similar al preview pero con metodo de pago,
 * propina cobrada y vuelto si efectivo. Sin sugerencia de propina (ya
 * pagada).
 *
 * NOTE (Task 4.4 refactor v0.9.0): renombrada a `renderBillProformaClassic`.
 * Dispatcher publico abajo.
 */
async function renderBillProformaClassic(
  tp: Printer,
  payload: BillProformaPayload,
  supabase: SupabaseClient | undefined,
  logger: Logger
): Promise<void> {
  // Logo si esta activo (D4 + D5 del spec). Si falla, sigue sin logo.
  await printLogoIfEnabled(tp, payload, supabase, logger);

  // Header del local (nombre + direccion + comuna/fono).
  printRestaurantHeader(tp, payload.restaurant);

  // Slogan si esta seteado (mig 058).
  const slogan = payload.restaurant.slogan?.trim();
  if (slogan && slogan.length > 0) {
    tp.alignCenter();
    tp.println(`"${slogan}"`);
    tp.alignLeft();
  }

  // Separador con vineta CP437.
  ornamentSep(tp, payload.restaurant.print_ornament_char ?? null);

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

  // Separador con vineta antes del footer.
  ornamentSep(tp, payload.restaurant.print_ornament_char ?? null);

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
 *
 * NOTE (Task 4.4 refactor v0.9.0): renombrada a `renderCashCloseClassic`.
 * Dispatcher publico abajo.
 */
function renderCashCloseClassic(
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

// ====================================================================
// Dispatchers publicos (entry-points usados por usb.ts)
// ====================================================================
//
// El dispatcher lee `payload.print_options?.style` y rutea a la variante
// concreta del style. Si el style no esta implementado todavia para ese
// tipo de ticket, cae a Classic como fallback seguro.
//
// Las funciones concretas de cada style se implementan en Tasks 4.6 y 4.7
// (bill_preview + bill_proforma). Por ahora todos los styles distintos a
// classic caen a classic — esto cierra la refactorizacion sin cambiar
// comportamiento en runtime hasta que las nuevas funciones aparezcan.
// ====================================================================

/**
 * Dispatcher publico para bill_preview. Rutea por print_options.style.
 *
 * Defaults: si payload.print_options o payload.print_options.style vienen
 * undefined (RPC pre-mig 058), aplica style='classic'.
 *
 * Async porque el style 'brand' (y eventualmente otros) descarga el logo
 * via printLogoIfEnabled. PopulatePrinter desde v0.9.0 acepta retorno
 * Promise<void> — el transport awaitea.
 */
export async function renderBillPreviewEscPos(
  tp: Printer,
  payload: BillPreviewPayload,
  supabase: SupabaseClient | undefined,
  logger: Logger
): Promise<void> {
  const style = payload.print_options?.style ?? 'classic';
  switch (style) {
    case 'minimal':
      return renderBillPreviewMinimal(tp, payload, supabase, logger);
    case 'brand':
      return renderBillPreviewBrand(tp, payload, supabase, logger);
    case 'thermal_pro':
      return renderBillPreviewThermalPro(tp, payload, supabase, logger);
    case 'classic':
    default:
      return renderBillPreviewClassic(tp, payload, supabase, logger);
  }
}

/**
 * Dispatcher publico para bill_proforma. Misma logica que bill_preview.
 */
export async function renderBillProformaEscPos(
  tp: Printer,
  payload: BillProformaPayload,
  supabase: SupabaseClient | undefined,
  logger: Logger
): Promise<void> {
  const style = payload.print_options?.style ?? 'classic';
  switch (style) {
    case 'minimal':
      return renderBillProformaMinimal(tp, payload, supabase, logger);
    case 'brand':
      return renderBillProformaBrand(tp, payload, supabase, logger);
    case 'thermal_pro':
      return renderBillProformaThermalPro(tp, payload, supabase, logger);
    case 'classic':
    default:
      return renderBillProformaClassic(tp, payload, supabase, logger);
  }
}

/**
 * Dispatcher publico para kitchen_order. Carlos prefiere classic, asi que
 * el switch por style esta presente pero por ahora todos los styles caen
 * al mismo render. Los toggles del payload.print_options se aplican DENTRO
 * de renderKitchenOrderClassic (Task 4.8).
 *
 * Recibe supabase + logger por consistencia con bill_*. Hoy no se usan
 * (kitchen no imprime logo) pero permite enchufarlo en el futuro sin
 * tocar la firma de buildPopulate.
 */
export async function renderKitchenOrderEscPos(
  tp: Printer,
  payload: KitchenJobPayload,
  jobType: 'kitchen_order' | 'bar_order' = 'kitchen_order',
  _supabase?: SupabaseClient | undefined,
  _logger?: Logger
): Promise<void> {
  // Por disenio: kitchen_order no tiene styles alternativos (los tickets
  // operacionales son siempre classic). Si en el futuro se quieren styles,
  // sumar aca el switch.
  return renderKitchenOrderClassic(tp, payload, jobType);
}

/**
 * Dispatcher publico para kitchen_cancel.
 */
export async function renderKitchenCancelEscPos(
  tp: Printer,
  payload: KitchenJobPayload,
  _supabase?: SupabaseClient | undefined,
  _logger?: Logger
): Promise<void> {
  return renderKitchenCancelClassic(tp, payload);
}

/**
 * Dispatcher publico para cash_close. Un solo style por ahora; los toggles
 * (showHighlightedDiff, showMethodBreakdown) se aplican dentro del Classic
 * (Task 4.9).
 */
export async function renderCashCloseEscPos(
  tp: Printer,
  payload: CashClosePayload,
  _supabase?: SupabaseClient | undefined,
  _logger?: Logger
): Promise<void> {
  return renderCashCloseClassic(tp, payload);
}

// ====================================================================
// Style variants stubs (Tasks 4.6 + 4.7 los implementan completos)
// ====================================================================
//
// Por ahora todas las funciones de style alternativo caen al Classic.
// Esto permite que el dispatcher exista desde Task 4.4 sin que el runtime
// cambie de comportamiento — los styles "minimal"/"brand"/"thermal_pro"
// son indistinguibles de "classic" hasta que sus implementaciones lleguen.
// ====================================================================

/**
 * MINIMAL style para bill_preview:
 *   - Sin badges invertidos
 *   - Sin doble altura en el header (single-width)
 *   - Whitespace generoso, sin separadores fuertes
 *   - Sin ornament (mas zen, mas papel)
 *
 * Ver mockup en spec Anexo A.
 */
async function renderBillPreviewMinimal(
  tp: Printer,
  payload: BillPreviewPayload,
  supabase: SupabaseClient | undefined,
  logger: Logger
): Promise<void> {
  // Logo respetando el toggle (en minimal generalmente OFF, pero respetamos
  // la config del dueño).
  await printLogoIfEnabled(tp, payload, supabase, logger);

  // Nombre del local: simple, sin centrado bold gigante.
  tp.alignLeft();
  tp.println(payload.restaurant.name);
  const address = payload.restaurant.address?.trim();
  if (address && address.length > 0) {
    tp.println(address);
  }
  tp.newLine();

  // Titulo simple "PRE-CUENTA"
  tp.println('PRE-CUENTA');

  // Datos de mesa en linea simple
  const time = formatTime(payload.opened_at);
  const meta: string[] = [];
  if (payload.table_number) meta.push(`Mesa ${payload.table_number}`);
  if (payload.waiter_name && payload.waiter_name.trim().length > 0) {
    meta.push(payload.waiter_name.trim());
  }
  meta.push(time);
  meta.push(`${payload.guests} pax`);
  tp.println(meta.join(' · '));
  tp.newLine();

  // Items con formato "qty  nombre  monto" sin doble altura
  for (const item of payload.items) {
    printBillItem(tp, item);
  }
  tp.newLine();

  // Totales sin separadores fuertes, sin XL.
  printAmountRow(tp, 'Subtotal', payload.subtotal);
  printAmountRow(tp, 'IVA', payload.iva);
  printAmountRow(tp, 'Total', payload.total);
  tp.newLine();

  // Propina sugerida simple
  printAmountRow(tp, 'Propina 10%', payload.suggested_tip_amount);
  printAmountRow(tp, 'Con propina', payload.total_with_suggested_tip);
  tp.newLine();

  // Footer simple
  const phrase = payload.restaurant.print_footer_phrase?.trim() || 'Gracias.';
  tp.println(phrase);
  tp.newLine();
}

/**
 * BRAND style para bill_preview:
 *   - Logo grande arriba (asume showLogo activo por defecto)
 *   - Nombre del local centrado + slogan en cursiva visible
 *   - Ornament en separadores
 *   - QR grande al final
 *
 * Ver mockup en spec Anexo A.
 */
async function renderBillPreviewBrand(
  tp: Printer,
  payload: BillPreviewPayload,
  supabase: SupabaseClient | undefined,
  logger: Logger
): Promise<void> {
  const ornament = payload.restaurant.print_ornament_char ?? null;

  // Logo grande arriba (toggle del usuario).
  await printLogoIfEnabled(tp, payload, supabase, logger);

  // Nombre del local centrado + bold + doble altura.
  tp.alignCenter();
  tp.bold(true);
  tp.setTextDoubleHeight();
  tp.println(payload.restaurant.name);
  tp.setTextNormal();
  tp.bold(false);

  // Slogan en lineas debajo del nombre — invitacion + caracter brand.
  const slogan = payload.restaurant.slogan?.trim();
  if (slogan && slogan.length > 0) {
    tp.println(`"${slogan}"`);
  }
  tp.alignLeft();

  // Ornament separator
  ornamentSep(tp, ornament);

  // Titulo PRE-CUENTA centrado en bold
  tp.alignCenter();
  tp.bold(true);
  tp.println(`PRE-CUENTA #${payload.order_number}`);
  tp.bold(false);
  tp.alignLeft();
  ornamentSep(tp, ornament);

  // Meta data
  const time = formatTime(payload.opened_at);
  if (payload.table_number) {
    tp.println(`Mesa ${payload.table_number} · ${payload.guests} pax · ${time}`);
  } else {
    tp.println(`Para llevar · ${payload.guests} pax · ${time}`);
  }
  if (payload.waiter_name && payload.waiter_name.trim().length > 0) {
    tp.println(`Mesero: ${payload.waiter_name.trim()}`);
  }
  tp.newLine();

  // Items
  for (const item of payload.items) {
    printBillItem(tp, item);
  }
  tp.newLine();

  // Totales con énfasis brand
  printAmountRow(tp, '  Subtotal', payload.subtotal, true);
  printAmountRow(tp, '  IVA 19%', payload.iva, true);
  tp.drawLine();
  printXLTotal(tp, 'TOTAL', payload.total);
  tp.newLine();

  // Sugerencia de propina
  tp.bold(true);
  tp.println('Propina sugerida (10%):');
  tp.bold(false);
  printAmountRow(tp, '  Propina', payload.suggested_tip_amount, false);
  tp.bold(true);
  printAmountRow(tp, 'CON PROPINA', payload.total_with_suggested_tip);
  tp.bold(false);
  tp.newLine();

  ornamentSep(tp, ornament);

  // Footer: QR + frase con vinetas
  printBillFooter(tp, payload.restaurant);

  // Frase final destacada con ornament a los lados (si hay ornament).
  if (ornament) {
    tp.alignCenter();
    tp.bold(true);
    tp.println(`${ornament} ¡Gracias por elegirnos! ${ornament}`);
    tp.bold(false);
    tp.alignLeft();
  }

  ornamentSep(tp, ornament);
  tp.newLine();
}

/**
 * THERMAL_PRO style para bill_preview:
 *   - Header denso con direccion + RUT + telefono en una linea cada uno
 *   - Items con precio unitario debajo del nombre
 *   - 3 sugerencias de propina (10/15/20%)
 *   - Sin badges invertidos: minimal chrome, max info
 *
 * Ver mockup en spec Anexo A.
 */
async function renderBillPreviewThermalPro(
  tp: Printer,
  payload: BillPreviewPayload,
  supabase: SupabaseClient | undefined,
  logger: Logger
): Promise<void> {
  // Logo respetando el toggle (en thermal_pro generalmente OFF para
  // priorizar densidad de info).
  await printLogoIfEnabled(tp, payload, supabase, logger);

  // Header denso: nombre + direccion en una linea
  tp.println('='.repeat(ESCPOS_WIDTH));
  const name = payload.restaurant.name;
  const addr = payload.restaurant.address?.trim();
  if (addr && addr.length > 0) {
    tp.println(`${name} · ${addr}`);
  } else {
    tp.println(name);
  }

  // Comuna + telefono
  const comuna = payload.restaurant.comuna?.trim();
  const phone = payload.restaurant.phone?.trim();
  if (comuna && phone) {
    tp.println(`${comuna} · Tel ${phone}`);
  } else if (comuna) {
    tp.println(comuna);
  } else if (phone) {
    tp.println(`Tel ${phone}`);
  }
  tp.println('='.repeat(ESCPOS_WIDTH));

  // Titulo + numero
  tp.bold(true);
  tp.println(`PRE-CUENTA #${payload.order_number}`);
  tp.bold(false);

  // Fecha completa + mesa + mesero
  const time = formatTime(payload.opened_at);
  const dateTime = formatDateTime(payload.opened_at);
  tp.println(dateTime || time);
  const meta: string[] = [];
  if (payload.table_number) meta.push(`Mesa ${payload.table_number}`);
  if (payload.waiter_name && payload.waiter_name.trim().length > 0) {
    meta.push(payload.waiter_name.trim());
  }
  meta.push(`${payload.guests} comensales`);
  tp.println(meta.join(' · '));
  tp.drawLine();

  // Items con precio unitario debajo
  for (const item of payload.items) {
    tp.println(`${item.quantity} ${item.name}`);
    const unit = formatCLP(item.unit_price).replace('$ ', '');
    const sub = formatCLP(item.subtotal).replace('$ ', '');
    tp.leftRight(`   ${unit} c/u`, sub);
  }
  tp.drawLine();

  // Subtotal + IVA simple
  printAmountRow(tp, 'Subtotal', payload.subtotal);
  printAmountRow(tp, 'IVA 19%', payload.iva);
  tp.bold(true);
  printAmountRow(tp, 'TOTAL', payload.total);
  tp.bold(false);
  tp.println('='.repeat(ESCPOS_WIDTH));

  // 3 sugerencias de propina
  tp.bold(true);
  tp.println('PROPINA SUGERIDA:');
  tp.bold(false);
  const tipTiers: Array<{ pct: number; amount: number }> = [
    { pct: 10, amount: Math.round(payload.total * 0.10) },
    { pct: 15, amount: Math.round(payload.total * 0.15) },
    { pct: 20, amount: Math.round(payload.total * 0.20) },
  ];
  for (const t of tipTiers) {
    const tipFmt = formatCLP(t.amount).replace('$ ', '');
    const totalWithTip = formatCLP(payload.total + t.amount).replace('$ ', '');
    tp.println(`  ${String(t.pct).padStart(2)}%  ${tipFmt} -> total ${totalWithTip}`);
  }
  tp.println('='.repeat(ESCPOS_WIDTH));

  // Footer (sin ornament, mantener look pro)
  printBillFooter(tp, payload.restaurant);
  tp.newLine();
}

/**
 * MINIMAL style para bill_proforma:
 *   - Sin badges invertidos, single-width, whitespace generoso.
 *   - Mismo principio que bill_preview minimal pero con bloque de payment
 *     al pie (propina cobrada + metodo + recibido/vuelto si efectivo).
 */
async function renderBillProformaMinimal(
  tp: Printer,
  payload: BillProformaPayload,
  supabase: SupabaseClient | undefined,
  logger: Logger
): Promise<void> {
  await printLogoIfEnabled(tp, payload, supabase, logger);

  tp.alignLeft();
  tp.println(payload.restaurant.name);
  const address = payload.restaurant.address?.trim();
  if (address && address.length > 0) {
    tp.println(address);
  }
  tp.newLine();

  tp.println(`BOLETA #${payload.order_number}`);

  const time = formatTime(payload.opened_at);
  const meta: string[] = [];
  if (payload.table_number) meta.push(`Mesa ${payload.table_number}`);
  if (payload.waiter_name && payload.waiter_name.trim().length > 0) {
    meta.push(payload.waiter_name.trim());
  }
  meta.push(time);
  meta.push(`${payload.guests} pax`);
  tp.println(meta.join(' · '));
  tp.newLine();

  // Items
  for (const item of payload.items) {
    printBillItem(tp, item);
  }
  tp.newLine();

  // Totales
  const tip = payload.tip_amount ?? 0;
  printAmountRow(tp, 'Subtotal', payload.subtotal);
  printAmountRow(tp, 'IVA', payload.iva);
  if (tip > 0) {
    printAmountRow(tp, 'Propina', tip);
  }
  printAmountRow(tp, 'Total', payload.total + tip);
  tp.newLine();

  // Payment simple (sin XL ni decoraciones)
  if (payload.payment) {
    tp.println(`Pago: ${payload.payment.method_label}`);
    if (payload.payment.method === 'cash') {
      if (payload.payment.received_cash != null) {
        printAmountRow(tp, '  Recibido', payload.payment.received_cash);
      }
      if (payload.payment.change != null && payload.payment.change > 0) {
        printAmountRow(tp, '  Vuelto', payload.payment.change);
      }
    } else if (payload.payment.method === 'card_mp') {
      const last4 = payload.payment.mp_last_four?.trim();
      if (last4) tp.println(`  Tarjeta •••• ${last4}`);
    }
    tp.newLine();
  }

  const phrase = payload.restaurant.print_footer_phrase?.trim() || 'Gracias.';
  tp.println(phrase);
  tp.newLine();
}

/**
 * BRAND style para bill_proforma:
 *   - Mismo enfasis branding que bill_preview brand pero terminando con
 *     bloque de payment destacado y "BOLETA" en vez de "PRE-CUENTA".
 */
async function renderBillProformaBrand(
  tp: Printer,
  payload: BillProformaPayload,
  supabase: SupabaseClient | undefined,
  logger: Logger
): Promise<void> {
  const ornament = payload.restaurant.print_ornament_char ?? null;

  await printLogoIfEnabled(tp, payload, supabase, logger);

  tp.alignCenter();
  tp.bold(true);
  tp.setTextDoubleHeight();
  tp.println(payload.restaurant.name);
  tp.setTextNormal();
  tp.bold(false);

  const slogan = payload.restaurant.slogan?.trim();
  if (slogan && slogan.length > 0) {
    tp.println(`"${slogan}"`);
  }
  tp.alignLeft();

  ornamentSep(tp, ornament);

  tp.alignCenter();
  tp.bold(true);
  tp.println(`BOLETA #${payload.order_number}`);
  tp.bold(false);
  tp.alignLeft();
  ornamentSep(tp, ornament);

  const time = formatTime(payload.opened_at);
  if (payload.table_number) {
    tp.println(`Mesa ${payload.table_number} · ${payload.guests} pax · ${time}`);
  } else {
    tp.println(`Para llevar · ${payload.guests} pax · ${time}`);
  }
  if (payload.waiter_name && payload.waiter_name.trim().length > 0) {
    tp.println(`Mesero: ${payload.waiter_name.trim()}`);
  }
  tp.newLine();

  // Items
  for (const item of payload.items) {
    printBillItem(tp, item);
  }
  tp.newLine();

  // Totales
  const tip = payload.tip_amount ?? 0;
  printAmountRow(tp, '  Subtotal', payload.subtotal, true);
  printAmountRow(tp, '  IVA 19%', payload.iva, true);
  if (tip > 0) {
    printAmountRow(tp, '  Propina', tip, true);
  }
  tp.drawLine();
  printXLTotal(tp, 'TOTAL', payload.total + tip);
  tp.newLine();

  // Payment destacado (centrado + bold)
  if (payload.payment) {
    ornamentSep(tp, ornament);
    tp.alignCenter();
    tp.bold(true);
    tp.println(`Pago: ${payload.payment.method_label}`);
    tp.bold(false);
    tp.alignLeft();
    if (payload.payment.method === 'cash') {
      if (payload.payment.received_cash != null) {
        printAmountRow(tp, '  Recibido', payload.payment.received_cash);
      }
      if (payload.payment.change != null && payload.payment.change > 0) {
        printAmountRow(tp, '  Vuelto', payload.payment.change);
      }
    } else if (payload.payment.method === 'card_mp') {
      const last4 = payload.payment.mp_last_four?.trim();
      if (last4) {
        tp.println(`  Tarjeta •••• ${last4}`);
      }
      const auth = payload.payment.mp_authorization_code?.trim();
      if (auth) {
        tp.println(`  Cod. autorizacion: ${auth}`);
      }
    }
    tp.newLine();
  }

  ornamentSep(tp, ornament);
  printBillFooter(tp, payload.restaurant);

  if (ornament) {
    tp.alignCenter();
    tp.bold(true);
    tp.println(`${ornament} ¡Gracias por elegirnos! ${ornament}`);
    tp.bold(false);
    tp.alignLeft();
  }

  ornamentSep(tp, ornament);
  tp.newLine();
}

/**
 * THERMAL_PRO style para bill_proforma:
 *   - Header denso (nombre+direccion+RUT en 1-2 lineas).
 *   - Items con precio unitario debajo.
 *   - Sin sugerencias de propina (ya esta cobrada — esa info va en payment).
 *   - Payment compacto al pie.
 */
async function renderBillProformaThermalPro(
  tp: Printer,
  payload: BillProformaPayload,
  supabase: SupabaseClient | undefined,
  logger: Logger
): Promise<void> {
  await printLogoIfEnabled(tp, payload, supabase, logger);

  tp.println('='.repeat(ESCPOS_WIDTH));
  const name = payload.restaurant.name;
  const addr = payload.restaurant.address?.trim();
  if (addr && addr.length > 0) {
    tp.println(`${name} · ${addr}`);
  } else {
    tp.println(name);
  }
  const comuna = payload.restaurant.comuna?.trim();
  const phone = payload.restaurant.phone?.trim();
  if (comuna && phone) {
    tp.println(`${comuna} · Tel ${phone}`);
  } else if (comuna) {
    tp.println(comuna);
  } else if (phone) {
    tp.println(`Tel ${phone}`);
  }
  tp.println('='.repeat(ESCPOS_WIDTH));

  tp.bold(true);
  tp.println(`BOLETA #${payload.order_number}`);
  tp.bold(false);

  const time = formatTime(payload.opened_at);
  const dateTime = formatDateTime(payload.opened_at);
  tp.println(dateTime || time);
  const meta: string[] = [];
  if (payload.table_number) meta.push(`Mesa ${payload.table_number}`);
  if (payload.waiter_name && payload.waiter_name.trim().length > 0) {
    meta.push(payload.waiter_name.trim());
  }
  meta.push(`${payload.guests} comensales`);
  tp.println(meta.join(' · '));
  tp.drawLine();

  for (const item of payload.items) {
    tp.println(`${item.quantity} ${item.name}`);
    const unit = formatCLP(item.unit_price).replace('$ ', '');
    const sub = formatCLP(item.subtotal).replace('$ ', '');
    tp.leftRight(`   ${unit} c/u`, sub);
  }
  tp.drawLine();

  const tip = payload.tip_amount ?? 0;
  printAmountRow(tp, 'Subtotal', payload.subtotal);
  printAmountRow(tp, 'IVA 19%', payload.iva);
  if (tip > 0) {
    printAmountRow(tp, 'Propina', tip);
  }
  tp.bold(true);
  printAmountRow(tp, 'TOTAL', payload.total + tip);
  tp.bold(false);
  tp.println('='.repeat(ESCPOS_WIDTH));

  // Payment compacto
  if (payload.payment) {
    tp.bold(true);
    tp.println(`PAGO: ${payload.payment.method_label}`);
    tp.bold(false);
    if (payload.payment.method === 'cash') {
      if (payload.payment.received_cash != null) {
        printAmountRow(tp, '  Recibido', payload.payment.received_cash);
      }
      if (payload.payment.change != null && payload.payment.change > 0) {
        printAmountRow(tp, '  Vuelto', payload.payment.change);
      }
    } else if (payload.payment.method === 'card_mp') {
      const last4 = payload.payment.mp_last_four?.trim();
      if (last4) tp.println(`  Tarjeta •••• ${last4}`);
      const auth = payload.payment.mp_authorization_code?.trim();
      if (auth) tp.println(`  Auth: ${auth}`);
    }
    tp.println('='.repeat(ESCPOS_WIDTH));
  }

  printBillFooter(tp, payload.restaurant);
  tp.newLine();
}
