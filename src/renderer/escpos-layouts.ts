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
 * Default del ancho del papel en chars cuando el payload no trae
 * `printer.width_chars`. `tp.leftRight` lee `tp.getWidth()` internamente, asi
 * que mientras el transport instancie el printer con el `width` correcto
 * (mig 060 + payload.printer.width_chars), los layouts funcionan.
 *
 * Mig 060 bait-pos: las RPCs enqueue_* suman `payload.printer.width_chars`
 * (32/42/48). Los renderers leen ese valor con `getPayloadWidth()` y lo usan
 * para separadores `'='.repeat(W)` y otros sites que padean a mano.
 *
 * Si llega un payload pre-mig 060 (sin printer.width_chars), cae a 32 ->
 * comportamiento legacy (Rongta 58mm).
 */
export const ESCPOS_WIDTH = 32;

/**
 * Lee `payload.printer.width_chars` con fallback a ESCPOS_WIDTH (32). Se
 * usa en TODOS los render*Classic/Minimal/Brand/ThermalPro al inicio para
 * resolver el ancho real del papel (32 Rongta 58mm, 42 font B, 48 Epson 80mm).
 *
 * Acepta payload tipado como union de los 4 payloads concretos. La proyeccion
 * `as { printer?: { width_chars?: number } }` es defensiva: si llega un
 * payload pre-mig 060 sin el field, fall back limpio a 32.
 */
function getPayloadWidth(payload: unknown): number {
  if (
    payload &&
    typeof payload === 'object' &&
    'printer' in payload &&
    payload.printer &&
    typeof payload.printer === 'object' &&
    'width_chars' in payload.printer
  ) {
    const w = (payload.printer as { width_chars?: number }).width_chars;
    if (typeof w === 'number' && w > 0) return w;
  }
  return ESCPOS_WIDTH;
}

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
 * - Si `print_qr_url` esta seteado Y el toggle `showQr !== false`, imprime
 *   QR centrado con label encima. Usamos correction 'M' (medium) y cellSize 6
 *   para que escanee bien en 58mm.
 *   NOTE GENERICIDAD: `printQR` envia `GS ( k` (estandar ESC/POS para QR).
 *   En termicas baratas SIN soporte QR el comando se ignora y el papel sale
 *   sin codigo — el ticket sigue legible. Si en el futuro queremos fallback
 *   a texto plano, agregar un flag de capability detection y switchear aca.
 * - Frase: si `print_footer_phrase` viene, se imprime tal cual; sino
 *   "Gracias por su preferencia".
 *
 * Fix v0.9.7 (bug A3): respetar el toggle `showQr`. Antes el QR siempre se
 * imprimia cuando `print_qr_url` estaba seteado, ignorando la opcion del
 * dueno en /settings/print-templates.
 */
function printBillFooter(
  tp: Printer,
  r: RestaurantPrintInfo,
  opts?: { showQr?: boolean }
): void {
  const showQr = opts?.showQr !== false; // default true
  const qrUrl = r.print_qr_url?.trim();
  if (showQr && qrUrl && qrUrl.length > 0) {
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
  tp.leftRight(left, formatCLP(amount));
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
 * BUG REPORTADO (Carlos, 2026-05-22) y FIXEADO:
 *   "items aparecen cargados a la izquierda — el monto no se ve a la derecha"
 *
 * Causa raíz (foto del ticket lo confirmó): la impresora era 80mm pero el
 * renderer usaba PRINTER_WIDTH=32 hardcoded (asumía Rongta 58mm). El padding
 * de leftRight() calculaba sobre 32 cols, dejando el monto en el medio del
 * papel en lugar del borde derecho.
 *
 * Fixes aplicados:
 *   1. (mig 060) Columna `printers.width_chars` configurable per impresora
 *      con valores 32/42/48 (58mm A/58mm B/80mm A). Default 32 = compat.
 *   2. (este file) El renderer recibe `width` por parámetro desde el payload
 *      (payload.printer.width_chars), threadeado a leftRight, ornamentSep,
 *      printBillItem, etc. Fallback a 32 si el payload no trae printer.
 *   3. (este file) Se quitó el `.replace('$ ', '')` en formatCLP — los items
 *      ahora muestran "$ 8.000" igual que el TOTAL, consistencia visual.
 *
 * El dueño tiene que configurar el ancho correcto en /settings/printers
 * para cada impresora (default 32 sigue funcionando para Rongta 58mm).
 * --------------------------------------------------------------------
 */
function printBillItem(tp: Printer, item: BillItem, width: number = ESCPOS_WIDTH): void {
  const amount = formatCLP(item.subtotal);
  const qtyPart = `x${item.quantity}`;
  // Reserva derecha aproximada: "x99   $999.999" ~ 14 chars. Nombre ocupa
  // el resto. Truncamos defensivamente al width del papel (32/42/48).
  const RIGHT_RESERVE = qtyPart.length + amount.length + 2; // 2 espacios entre nombre y qty
  const nameMax = Math.max(8, width - RIGHT_RESERVE - 2);
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
 * Imprime el TOTAL destacado (doble altura) con la etiqueta a la izquierda y
 * el monto a la derecha. Centrado para dar enfasis visual sin necesitar
 * `GS ! n` (que no es universal).
 *
 * v0.9.7: solo aplicamos `setTextDoubleHeight()` (ESC ! 0x10) — un comando
 * ESC/POS basico que cualquier termica respeta. Antes habia un setTextSize(1,1)
 * dead-code arriba del doubleHeight; eliminado.
 *
 * Si en el futuro se quiere doble ancho tambien, sumar `setTextDoubleWidth()`
 * — ambos via ESC ! n. Por ahora preferimos solo doble altura para evitar
 * que la linea "TOTAL $999.999" pase del ancho del papel en 58mm.
 */
function printXLTotal(
  tp: Printer,
  label: string,
  amount: number,
  fontSize: 'normal' | 'large' | undefined = 'normal'
): void {
  const formatted = formatCLP(amount); // "$ 24.500"
  const line = `${label} ${formatted}`;
  tp.alignCenter();
  tp.bold(true);
  tp.setTextDoubleHeight();
  tp.println(line);
  tp.setTextNormal();
  // v0.9.8: si el ticket global esta en large, restaurarlo despues del
  // emphasis para no salirnos del modo grande hasta el final del render.
  restoreFontSize(tp, fontSize);
  tp.bold(false);
  tp.alignLeft();
}

/**
 * Set ASCII 7-bit puro de chars permitidos para `print_ornament_char` (mig 063).
 * Cualquier termica imprime estos chars fielmente sin necesitar tablas de
 * caracteres adicionales (CP437/Latin1).
 *
 * Historia: hasta v0.9.0 el set era CP437 (♥ ♦ ● ○ ■ ▲ ►). Aunque CP437 los
 * define, `node-thermal-printer` envia UTF-8 a la termica y esta NO los mapea
 * a sus bytes CP437 → resultado: `?` o garbage en el papel. Fix pragmatico:
 * ASCII puro (bytes 0x20-0x7E) que cualquier impresora renderiza.
 *
 * Si el dueño elige un char fuera de este set (UI debe filtrarlo, pero
 * defensivo aca tambien), `ornamentSep` reemplaza por '*' silenciosamente.
 */
const SAFE_ORNAMENTS = ['*', '+', '-', '=', '#', 'o', 'x', '~', '.', ':'] as const;
type SafeOrnament = (typeof SAFE_ORNAMENTS)[number];

function isSafeOrnament(char: string): char is SafeOrnament {
  return (SAFE_ORNAMENTS as readonly string[]).includes(char);
}

/**
 * Imprime un separador horizontal de exactamente `width` chars. Si `char` es
 * truthy y ASCII-safe (set definido arriba), lo embebe centrado con `=` a
 * ambos lados. Si `char` no esta en el set permitido, reemplaza por '*'
 * (fallback defensivo, D6). Si `char` es null/undefined/'', imprime una linea
 * plana de `width` chars `=`.
 *
 * Mig 060: width pasado por parametro (32/42/48). Default ESCPOS_WIDTH=32
 * conserva el comportamiento legacy.
 */
function ornamentSep(
  tp: Printer,
  char: string | null | undefined,
  width: number = ESCPOS_WIDTH
): void {
  if (!char || char.length === 0) {
    tp.println('='.repeat(width));
    return;
  }

  // Fallback ASCII: si no esta en el set permitido, usar '*'. No tiramos
  // error para no romper el ticket completo por un char malo.
  const safe = isSafeOrnament(char) ? char : '*';
  // Embebe char centrado: ' char ' (3 chars). El resto se divide en ambos
  // lados con asimetria de 1 char si width es impar (extra `=` a la derecha
  // por convencion, replica el comportamiento legacy 14/15 con width=32).
  const remaining = width - 3; // -1 char, -2 espacios
  const leftLen = Math.floor(remaining / 2);
  const rightLen = remaining - leftLen;
  tp.println('='.repeat(leftLen) + ' ' + safe + ' ' + '='.repeat(rightLen));
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
  // Default ON: si el dueño subió un logo (print_logo_path) y NO desactivó
  // explícitamente el toggle, imprimimos. Solo se skipa cuando
  // `showLogo === false` (opt-out explícito).
  //
  // Bug original (Carlos 2026-05-22): la lógica anterior exigía
  // `showLogo === true`. Si el dueño subía el logo en /settings pero no
  // visitaba /settings/print-templates para guardar print_options, llegaba
  // `print_options: {}` con showLogo=undefined → logo NUNCA se imprimía.
  // Fix: respetar el opt-in del upload como default y dejar el toggle
  // únicamente como opt-out.
  if (payload.print_options?.showLogo === false) return;

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
    // Aire después del logo: el header del ticket queda pegado al PNG si no
    // dejamos espacio. 2 newlines = ~3mm en termica estandar — suficiente
    // separacion para que el nombre del restaurant respire.
    tp.newLine();
    tp.newLine();
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

/**
 * Aplica el tamano de letra "large" a TODA la salida del render. Antes
 * (v0.9.7) solo afectaba al header (nombre + titulo). Carlos pidio en
 * 2026-05-23 que afecte al ticket completo — items, totales, payment,
 * etc. — para que el efecto sea visible y consistente.
 *
 * Llamadores (v0.9.8): aplicar UNA VEZ al inicio de cada render* function
 * (despues de leer fontSize de payload.print_options, antes del primer
 * println) y reset UNA VEZ al final del render. No es necesario aplicar
 * en el bracket del header: la salida queda en large hasta el reset.
 *
 *   applyFontSize(tp, fontSize);   // toda la salida en large
 *   ... render entero ...
 *   resetFontSize(tp);             // vuelve a normal antes de cut/feed
 *
 * Para emphasis blocks intermedios (ej. TOTAL XL, badge ANULACION) que
 * usan tp.setTextDoubleHeight() + tp.setTextNormal() para crear contraste,
 * usar restoreFontSize(tp, fontSize) DESPUES del setTextNormal para volver
 * al estado "large global" si corresponde.
 *
 * GENERICIDAD ESC/POS (v0.9.7): usamos `setTextDoubleHeight()` via
 * `ESC ! n` (0x1B 0x21 0x10), el comando original universal en cualquier
 * termica que respeta el estandar ESC/POS basico.
 *
 * CAVEAT DOBLE ANCHO (v0.9.8, conservador): la decision actual es aplicar
 * SOLO `setTextDoubleHeight()` y NO `setTextDoubleWidth()`. Razon: con
 * doble ancho el numero efectivo de chars por linea cae a la mitad
 * (32 cols pasan a 16, 48 cols pasan a 24), lo que rompe items con
 * nombres largos y montos a la derecha. Mantener solo doble alto preserva
 * el layout 32/42/48 cols actual.
 *
 * TODO (Carlos decide): si quieres double-double (alto+ancho) descomenta
 * la linea `tp.setTextDoubleWidth()` abajo. Aspecto: texto MUCHO mas
 * grande pero corres riesgo de truncamiento en items con nombres largos.
 *
 * NOTA sobre fontSize='small' (eliminado v0.9.7): antes hacia
 * `setTextSize(0, 0)` que en muchas termicas era NOOP. Carlos elimino
 * 'small' del enum — solo quedan 'normal' y 'large'. Si llega un payload
 * pre-v0.9.7 con fontSize='small', el switch cae al default silenciosamente.
 */
function applyFontSize(
  tp: Printer,
  fontSize: 'normal' | 'large' | undefined
): void {
  if (fontSize === 'large') {
    tp.setTextDoubleHeight();
    // TODO: si Carlos prefiere double-double, descomentar la linea siguiente.
    // tp.setTextDoubleWidth();
  }
  // 'normal' o undefined: noop.
}

/**
 * Resetea el tamano de letra a normal. Llamar al final del render para
 * que el siguiente job (otro ticket en la misma sesion) no herede large.
 *
 * `setTextNormal()` envia `ESC ! 0x00` que limpia los bits de doble alto
 * y doble ancho (entre otros flags como bold y underline — los volvemos a
 * setear donde se necesiten).
 */
function resetFontSize(tp: Printer): void {
  tp.setTextNormal();
}

/**
 * Restaura el fontSize del usuario despues de un emphasis block intermedio
 * (TOTAL XL, badge ANULACION, etc). El patron usa setTextDoubleHeight ->
 * println -> setTextNormal para crear contraste; con fontSize='large' global
 * el setTextNormal nos sacaria del modo grande prematuramente, asi que
 * llamamos a restoreFontSize para volver a aplicar.
 *
 * Si fontSize='normal' o undefined: noop (el ticket ya esta en normal).
 */
function restoreFontSize(
  tp: Printer,
  fontSize: 'normal' | 'large' | undefined
): void {
  if (fontSize === 'large') {
    tp.setTextDoubleHeight();
    // TODO: si Carlos prefiere double-double, descomentar la linea siguiente.
    // tp.setTextDoubleWidth();
  }
}

/**
 * @deprecated v0.9.8: usar applyFontSize. Alias mantenido para no romper
 * imports/callsites que aun no migraron.
 */
function applyHeaderFontSize(
  tp: Printer,
  fontSize: 'normal' | 'large' | undefined
): void {
  applyFontSize(tp, fontSize);
}

/**
 * @deprecated v0.9.8: NO HACE NADA — antes salia del modo large despues
 * del bloque de header. Con la decision v0.9.8 de aplicar 'large' a TODO
 * el ticket, este "reset intermedio" rompe el flow (apaga large antes
 * de items/totales).
 *
 * Mantenemos la funcion como NO-OP para no tener que tocar todos los
 * callsites legacy en cada render*Style. El reset real ocurre UNA VEZ
 * al final del render via resetFontSize(tp) llamado desde el dispatcher
 * publico (render*EscPos).
 *
 * Si necesitas resetear en medio del render por una razon especifica,
 * llama directo a resetFontSize(tp). Pero la regla general es "large
 * persiste hasta el final del render".
 */
function resetHeaderFontSize(_tp: Printer): void {
  // intencionalmente vacio — ver docstring arriba.
}

/**
 * Lee el fontSize de un print_options de cualquier ticket. Defensa: si el
 * payload viene de una RPC pre-fontSize O trae el legacy 'small', devuelve
 * 'normal'.
 *
 * v0.9.7: eliminamos 'small' del enum publico pero aceptamos payloads
 * legacy con `fontSize: 'small'` y los tratamos como 'normal' silenciosamente.
 */
function getFontSize(
  print_options?: { fontSize?: 'small' | 'normal' | 'large' }
): 'normal' | 'large' {
  const v = print_options?.fontSize;
  if (v === 'large') return 'large';
  // 'small' (legacy), 'normal', undefined o cualquier otro -> normal.
  return 'normal';
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

// printKitchenItem (sin toggles) fue retirado en Task 4.8 — los unicos dos
// callers eran kitchen_order/cancel y ambos inlinan su propia logica:
//   - kitchen_order usa printKitchenItemWithToggles (definida abajo).
//   - kitchen_cancel inlinea el item con prefijo "[X]" — quiere DIFFERENT
//     formatting (no es un mero subset del kitchen_order).

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
  const time = formatTime(payload.opened_at);

  // Toggles del print_options con defaults rich del Anexo C del spec.
  // Si vienen undefined (RPC pre-mig 058), aplican estos defaults.
  // Casteamos a KitchenOrderOptions sabiendo que el dispatcher rutea ambos
  // kitchen_order/cancel a este mismo metodo; el dispatcher kitchen_cancel
  // tiene su propia funcion y sus propios toggles.
  const opts = (payload.print_options ?? {}) as {
    showOpenTime?: boolean;
    showHighlightedNotes?: boolean;
    showGiftMark?: boolean;
    showPrices?: boolean;
    showWaiter?: boolean;
    showGuests?: boolean;
    fontSize?: 'small' | 'normal' | 'large';
  };
  const showOpenTime = opts.showOpenTime ?? true;
  const showHighlightedNotes = opts.showHighlightedNotes ?? true;
  const showGiftMark = opts.showGiftMark ?? true;
  const showPrices = opts.showPrices ?? false; // default off para cocina
  const showWaiter = opts.showWaiter ?? true;
  const showGuests = opts.showGuests ?? true;
  const fontSize = getFontSize(opts);

  // Header XL en 2 lineas: estacion arriba, destino abajo.
  // fontSize=large encima del setTextDoubleHeight: en termicas con soporte
  // ESC/POS estandar, las dos se combinan dando 4x alto. La mayoria de
  // termicas chinas (Rongta) cap a 2x — no rompe, solo se ve como large.
  tp.alignCenter();
  tp.bold(true);
  applyHeaderFontSize(tp, fontSize);
  tp.setTextDoubleHeight();
  tp.println(station);
  tp.println(destination);
  resetHeaderFontSize(tp);
  tp.bold(false);

  // Subtitle line 1: hora + "Hace X min" si showOpenTime.
  // Fix v0.9.7 (consistencia con bug A5): la hora absoluta tambien sale gated
  // por showOpenTime. Antes la hora se imprimia siempre y el toggle solo
  // afectaba al "Hace X min".
  const headerLineParts: string[] = [];
  if (showOpenTime) {
    headerLineParts.push(time);
    const elapsedMin = minutesSinceOpened(payload.opened_at);
    if (elapsedMin != null) {
      headerLineParts.push(`Hace ${elapsedMin} min`);
    }
  }

  // Mesero opcional via toggle
  if (showWaiter) {
    const waiter = payload.waiter_name?.trim() || '-';
    headerLineParts.unshift(`Mesero: ${waiter}`);
  }

  if (headerLineParts.length > 0) {
    tp.println(headerLineParts.join(' · '));
  }

  // Comensales opcional via toggle
  if (showGuests) {
    tp.println(`Comensales: ${payload.guests}`);
  }

  tp.alignLeft();
  tp.drawLine();
  tp.newLine();

  // Items con toggles aplicados.
  for (const item of payload.items) {
    printKitchenItemWithToggles(tp, item, {
      showHighlightedNotes,
      showGiftMark,
      showPrices,
    });
  }

  // Nota del cliente (siempre — es parte del payload, no de los items)
  if (payload.customer_note && payload.customer_note.trim().length > 0) {
    tp.drawLine();
    if (showHighlightedNotes) {
      tp.bold(true);
      tp.invert(true);
      tp.println(` Notas mesa: ${payload.customer_note.trim()} `);
      tp.invert(false);
      tp.bold(false);
    } else {
      tp.println(`Notas mesa: ${payload.customer_note.trim()}`);
    }
  }

  // Total items destacado (suma de quantities)
  const totalItems = payload.items.reduce((acc, it) => acc + it.quantity, 0);
  tp.drawLine();
  tp.alignCenter();
  tp.bold(true);
  tp.setTextDoubleHeight();
  tp.println(`TOTAL ÍTEMS: ${totalItems}`);
  tp.setTextNormal();
  // v0.9.8: restaurar fontSize global despues del emphasis intermedio.
  restoreFontSize(tp, fontSize);
  tp.bold(false);
  tp.alignLeft();
  tp.newLine();
}

/**
 * Devuelve los minutos transcurridos desde `opened_at` (ISO string) hasta
 * ahora. Util para el toggle `showOpenTime` ("Hace X min"). Si el ISO es
 * invalido o cae en el futuro, retorna null.
 */
function minutesSinceOpened(isoString: string): number | null {
  const opened = new Date(isoString);
  if (Number.isNaN(opened.getTime())) return null;
  const diffMs = Date.now() - opened.getTime();
  if (diffMs < 0) return null;
  return Math.floor(diffMs / 60_000);
}

/**
 * Variante de `printKitchenItem` que aplica los toggles del print_options.
 * El original (sin toggles) queda como compat para callers internos —
 * aunque hoy solo lo usa kitchen_cancel.
 */
function printKitchenItemWithToggles(
  tp: Printer,
  item: KitchenJobItem,
  opts: {
    showHighlightedNotes: boolean;
    showGiftMark: boolean;
    showPrices: boolean;
  }
): void {
  tp.bold(true);
  // Si showPrices, embeber el precio (subtotal seria modifier sum + base —
  // no esta en KitchenJobItem). Por ahora KitchenJobItem solo trae name +
  // qty + modifiers (priceDelta). Skipping showPrices implementation full
  // hasta que la RPC mande el subtotal del item al payload de cocina.
  tp.println(`${item.quantity}x ${item.name}`);
  tp.bold(false);

  // ★ CORTESÍA si is_gift y showGiftMark
  if (opts.showGiftMark && item.is_gift) {
    tp.bold(true);
    tp.println('   ★ CORTESÍA');
    tp.bold(false);
  }

  for (const mod of item.modifiers) {
    if (opts.showPrices && mod.priceDelta !== 0) {
      // Si showPrices y el modifier tiene delta, mostrar el delta
      const fmt = formatCLP(mod.priceDelta);
      tp.println(`   - ${mod.name} (${mod.priceDelta > 0 ? '+' : ''}${fmt})`);
    } else {
      tp.println(`   - ${mod.name}`);
    }
  }

  if (item.note && item.note.trim().length > 0) {
    if (opts.showHighlightedNotes) {
      tp.bold(true);
      tp.invert(true);
      tp.println(`   [${item.note.trim()}]`);
      tp.invert(false);
      tp.bold(false);
    } else {
      tp.println(`   [${item.note.trim()}]`);
    }
  }
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
  const time = formatTime(payload.opened_at);

  // Toggles del KitchenCancelOptions con defaults rich.
  const opts = (payload.print_options ?? {}) as {
    showReason?: boolean;
    showWaiter?: boolean;
    fontSize?: 'small' | 'normal' | 'large';
  };
  const showReason = opts.showReason ?? true;
  const showWaiter = opts.showWaiter ?? true;
  const fontSize = getFontSize(opts);

  // Header: badge invertido "ANULACION" + destino en doble altura.
  // fontSize='large' suma a doubleHeight (ver renderKitchenOrderClassic).
  tp.alignCenter();
  tp.bold(true);
  tp.invert(true);
  applyHeaderFontSize(tp, fontSize);
  tp.setTextDoubleHeight();
  tp.println(' ANULACION ');
  tp.invert(false);
  tp.println(destination);
  resetHeaderFontSize(tp);
  tp.bold(false);

  // Subtitle: mesero (opcional) + hora
  if (showWaiter) {
    const waiter = payload.waiter_name?.trim() || '-';
    tp.println(`Mesero: ${waiter} · ${time}`);
  } else {
    tp.println(time);
  }
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

  // Motivo (customer_note) — solo si showReason
  if (showReason && payload.customer_note && payload.customer_note.trim().length > 0) {
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
  // Mig 060: width real del papel (32/42/48) desde payload.printer.width_chars.
  const width = getPayloadWidth(payload);
  const fontSize = getFontSize(payload.print_options);

  // Toggles bill_preview (mig 058). Defaults rich del Anexo C.
  // Fix v0.9.7 (bugs A1+A2+A3): respetar showAddress / showRut / showQr.
  const opts = (payload.print_options ?? {}) as {
    showAddress?: boolean;
    showRut?: boolean;
    showQr?: boolean;
  };
  const showAddress = opts.showAddress !== false; // default true
  const showRut = opts.showRut === true;           // default false en bill_preview
  const showQr = opts.showQr !== false;            // default true

  // Logo si esta activo (D4 + D5 del spec). Si falla, sigue sin logo.
  await printLogoIfEnabled(tp, payload, supabase, logger);

  // Header del local. fontSize='large': nombre/direccion en grande.
  // resetHeaderFontSize antes de los items para que los montos no se
  // descuadren.
  //
  // Antes (pre-v0.9.7) llamabamos a `printRestaurantHeader` que SIEMPRE
  // imprimia address + comuna ignorando el toggle showAddress. Ahora
  // inline para gate explicito.
  applyHeaderFontSize(tp, fontSize);
  tp.alignCenter();
  tp.bold(true);
  tp.println(payload.restaurant.name);
  tp.bold(false);
  if (showAddress) {
    const address = payload.restaurant.address?.trim();
    if (address && address.length > 0) tp.println(address);
    const comuna = payload.restaurant.comuna?.trim() ?? '';
    const phone = payload.restaurant.phone?.trim() ?? '';
    if (comuna.length > 0 || phone.length > 0) {
      const parts: string[] = [];
      if (comuna.length > 0) parts.push(comuna);
      if (phone.length > 0) parts.push(`Fono ${phone}`);
      tp.println(parts.join(' · '));
    }
  }
  // RUT: default OFF en bill_preview (no es doc legal).
  if (showRut && payload.restaurant.rut) {
    tp.println(`RUT: ${payload.restaurant.rut}`);
  }
  tp.alignLeft();
  tp.drawLine();
  resetHeaderFontSize(tp);

  // Slogan si esta seteado (mig 058).
  const slogan = payload.restaurant.slogan?.trim();
  if (slogan && slogan.length > 0) {
    tp.alignCenter();
    tp.println(`"${slogan}"`);
    tp.alignLeft();
  }

  // Separador con vineta ASCII (sobreescribe el drawLine() del header).
  ornamentSep(tp, payload.restaurant.print_ornament_char ?? null, width);

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
    printBillItem(tp, item, width);
  }

  tp.newLine();
  tp.drawLine();

  // Subtotal + IVA
  printAmountRow(tp, 'Subtotal', payload.subtotal);
  printAmountRow(tp, 'IVA (19%)', payload.iva);

  // TOTAL XL
  tp.drawLine();
  // v0.9.8: pasamos fontSize para que el helper restaure large despues
  // del emphasis. Sin esto, el setTextNormal interno del helper nos saca
  // del modo grande prematuramente y el resto del ticket vuelve a normal.
  printXLTotal(tp, 'TOTAL', payload.total, fontSize);
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
  ornamentSep(tp, payload.restaurant.print_ornament_char ?? null, width);

  // Footer (QR opcional + frase custom). Fix v0.9.7 bug A3: pasar showQr.
  printBillFooter(tp, payload.restaurant, { showQr });
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
  // Mig 060: width real del papel.
  const width = getPayloadWidth(payload);
  const fontSize = getFontSize(payload.print_options);

  // Toggles bill_proforma (mig 058). Defaults rich del Anexo C — notar que
  // showRut default es TRUE en proforma (es la boleta final, sí queremos
  // mostrar RUT del local).
  const opts = (payload.print_options ?? {}) as {
    showAddress?: boolean;
    showRut?: boolean;
    showQr?: boolean;
  };
  const showAddress = opts.showAddress !== false; // default true
  const showRut = opts.showRut !== false;          // default true en bill_proforma
  const showQr = opts.showQr !== false;            // default true

  // Logo si esta activo (D4 + D5 del spec). Si falla, sigue sin logo.
  await printLogoIfEnabled(tp, payload, supabase, logger);

  // Header del local (nombre + direccion + comuna/fono).
  // fontSize='large' agranda nombre+direccion. resetHeaderFontSize antes de
  // items para no romper el layout 32/42/48.
  //
  // v0.9.7: inline en vez de printRestaurantHeader para respetar showAddress
  // y agregar showRut (bug A1+A2).
  applyHeaderFontSize(tp, fontSize);
  tp.alignCenter();
  tp.bold(true);
  tp.println(payload.restaurant.name);
  tp.bold(false);
  if (showAddress) {
    const address = payload.restaurant.address?.trim();
    if (address && address.length > 0) tp.println(address);
    const comuna = payload.restaurant.comuna?.trim() ?? '';
    const phone = payload.restaurant.phone?.trim() ?? '';
    if (comuna.length > 0 || phone.length > 0) {
      const parts: string[] = [];
      if (comuna.length > 0) parts.push(comuna);
      if (phone.length > 0) parts.push(`Fono ${phone}`);
      tp.println(parts.join(' · '));
    }
  }
  if (showRut && payload.restaurant.rut) {
    tp.println(`RUT: ${payload.restaurant.rut}`);
  }
  tp.alignLeft();
  tp.drawLine();
  resetHeaderFontSize(tp);

  // Slogan si esta seteado (mig 058).
  const slogan = payload.restaurant.slogan?.trim();
  if (slogan && slogan.length > 0) {
    tp.alignCenter();
    tp.println(`"${slogan}"`);
    tp.alignLeft();
  }

  // Separador con vineta ASCII.
  ornamentSep(tp, payload.restaurant.print_ornament_char ?? null, width);

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
    printBillItem(tp, item, width);
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
  // v0.9.8: pasamos fontSize (ver nota arriba en classic).
  printXLTotal(tp, 'TOTAL', payload.total + tip, fontSize);
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
  ornamentSep(tp, payload.restaurant.print_ornament_char ?? null, width);

  // Footer (QR opcional + frase custom). Fix v0.9.7 bug A3: pasar showQr.
  printBillFooter(tp, payload.restaurant, { showQr });
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
  // Mig 060: width real del papel.
  const width = getPayloadWidth(payload);

  // Toggles de CashCloseOptions con defaults rich.
  const opts = (payload.print_options ?? {}) as {
    showHighlightedDiff?: boolean;
    showMethodBreakdown?: boolean;
    fontSize?: 'small' | 'normal' | 'large';
  };
  const showHighlightedDiff = opts.showHighlightedDiff ?? true;
  const showMethodBreakdown = opts.showMethodBreakdown ?? true;
  const fontSize = getFontSize(opts);

  // Header: usa restaurant (mig 058+) si esta disponible para incluir logo
  // y ornament. Si no, fallback al header generico de cash close.
  if (payload.restaurant) {
    // Phase 1 (mig 058) suma restaurant al payload de cash_close. Si esta,
    // usamos el header rich del local (nombre + direccion + slogan + ornament).
    // Logo: no llamamos a printLogoIfEnabled porque cash_close hoy no tiene
    // showLogo en sus toggles — si en el futuro se agrega, sumar la llamada
    // aca con un toggle especifico.
    applyHeaderFontSize(tp, fontSize);
    printRestaurantHeader(tp, payload.restaurant);
    resetHeaderFontSize(tp);

    const slogan = payload.restaurant.slogan?.trim();
    if (slogan && slogan.length > 0) {
      tp.alignCenter();
      tp.println(`"${slogan}"`);
      tp.alignLeft();
    }

    ornamentSep(tp, payload.restaurant.print_ornament_char ?? null, width);
  }

  // Header XL del cierre. fontSize='large' suma a doubleHeight (mayoria de
  // termicas chinas cap a 2x).
  tp.alignCenter();
  tp.bold(true);
  applyHeaderFontSize(tp, fontSize);
  tp.setTextDoubleHeight();
  tp.println('CIERRE DE CAJA');
  tp.setTextNormal();
  // v0.9.8: restaurar fontSize global tras el emphasis.
  restoreFontSize(tp, fontSize);
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

  // Ventas totales (siempre)
  tp.bold(true);
  printAmountRow(tp, 'Ventas totales', payload.total_sales);
  tp.bold(false);

  // Desglose por metodo (toggle showMethodBreakdown)
  if (showMethodBreakdown) {
    printAmountRow(tp, 'Efectivo', payload.total_cash, true);
    printAmountRow(tp, 'Tarjeta MP', payload.total_card_mp, true);
    printAmountRow(tp, 'Otras tarjetas', payload.total_card_other, true);
    printAmountRow(tp, 'Transferencia', payload.total_transfer, true);
    tp.newLine();
  }

  // Propinas + devoluciones + comandas (siempre)
  printAmountRow(tp, 'Propinas', payload.total_tips);
  printAmountRow(tp, 'Devoluciones', payload.total_refunds);
  tp.leftRight('Comandas totales:', String(payload.order_count));
  tp.newLine();

  // Caja esperada vs declarada (siempre)
  tp.drawLine();
  printAmountRow(tp, 'Efectivo esperado', payload.expected_cash);
  printAmountRow(tp, 'Efectivo declarado', payload.closing_cash);

  // Diferencia: si showHighlightedDiff, en bold + invert (sello visual fuerte).
  // Si OFF, solo bold (suave).
  if (showHighlightedDiff) {
    tp.bold(true);
    tp.invert(true);
    printAmountRow(tp, ' DIFERENCIA ', payload.difference);
    tp.invert(false);
    tp.bold(false);
  } else {
    tp.bold(true);
    printAmountRow(tp, 'DIFERENCIA', payload.difference);
    tp.bold(false);
  }

  // Notas
  if (payload.notes && payload.notes.trim().length > 0) {
    tp.drawLine();
    tp.println(`Notas: ${payload.notes.trim()}`);
  }

  // Si tenemos restaurant, cerrar con ornament + frase del footer.
  if (payload.restaurant) {
    ornamentSep(tp, payload.restaurant.print_ornament_char ?? null, width);
    printBillFooter(tp, payload.restaurant);
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
  // v0.9.8: aplicar fontSize globalmente al inicio + reset al final para
  // que 'large' afecte TODA la salida del ticket (no solo el header).
  // Los renderers internos siguen llamando applyHeaderFontSize por compat,
  // pero como resetHeaderFontSize ahora es no-op, large persiste hasta el
  // resetFontSize que cierra este dispatcher.
  const fontSize = getFontSize(payload.print_options);
  applyFontSize(tp, fontSize);
  try {
    const style = payload.print_options?.style ?? 'classic';
    switch (style) {
      case 'minimal':
        await renderBillPreviewMinimal(tp, payload, supabase, logger);
        break;
      case 'brand':
        await renderBillPreviewBrand(tp, payload, supabase, logger);
        break;
      case 'thermal_pro':
        await renderBillPreviewThermalPro(tp, payload, supabase, logger);
        break;
      case 'classic':
      default:
        await renderBillPreviewClassic(tp, payload, supabase, logger);
        break;
    }
  } finally {
    // Reset SIEMPRE — aunque el render tire un error, no queremos que el
    // proximo job en la misma sesion herede large.
    resetFontSize(tp);
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
  // v0.9.8: fontSize global (ver nota en renderBillPreviewEscPos).
  const fontSize = getFontSize(payload.print_options);
  applyFontSize(tp, fontSize);
  try {
    const style = payload.print_options?.style ?? 'classic';
    switch (style) {
      case 'minimal':
        await renderBillProformaMinimal(tp, payload, supabase, logger);
        break;
      case 'brand':
        await renderBillProformaBrand(tp, payload, supabase, logger);
        break;
      case 'thermal_pro':
        await renderBillProformaThermalPro(tp, payload, supabase, logger);
        break;
      case 'classic':
      default:
        await renderBillProformaClassic(tp, payload, supabase, logger);
        break;
    }
  } finally {
    resetFontSize(tp);
  }
}

/**
 * Dispatcher publico para kitchen_order. v0.9.5 suma styles minimal/brand/
 * thermal_pro (antes ignoraba el style y siempre llamaba a Classic). El
 * default sigue siendo classic — RPCs pre-mig 058 que no traen
 * print_options.style caen ahi.
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
  // v0.9.8: fontSize global (ver nota en renderBillPreviewEscPos).
  const fontSize = getFontSize(payload.print_options);
  applyFontSize(tp, fontSize);
  try {
    const style = payload.print_options?.style ?? 'classic';
    switch (style) {
      case 'minimal':
        renderKitchenOrderMinimal(tp, payload, jobType);
        break;
      case 'brand':
        renderKitchenOrderBrand(tp, payload, jobType);
        break;
      case 'thermal_pro':
        renderKitchenOrderThermalPro(tp, payload, jobType);
        break;
      case 'classic':
      default:
        renderKitchenOrderClassic(tp, payload, jobType);
        break;
    }
  } finally {
    resetFontSize(tp);
  }
}

/**
 * Dispatcher publico para kitchen_cancel. v0.9.5 suma styles alternativos.
 */
export async function renderKitchenCancelEscPos(
  tp: Printer,
  payload: KitchenJobPayload,
  _supabase?: SupabaseClient | undefined,
  _logger?: Logger
): Promise<void> {
  // v0.9.8: fontSize global (ver nota en renderBillPreviewEscPos).
  const fontSize = getFontSize(payload.print_options);
  applyFontSize(tp, fontSize);
  try {
    const style = payload.print_options?.style ?? 'classic';
    switch (style) {
      case 'minimal':
        renderKitchenCancelMinimal(tp, payload);
        break;
      case 'brand':
        renderKitchenCancelBrand(tp, payload);
        break;
      case 'thermal_pro':
        renderKitchenCancelThermalPro(tp, payload);
        break;
      case 'classic':
      default:
        renderKitchenCancelClassic(tp, payload);
        break;
    }
  } finally {
    resetFontSize(tp);
  }
}

/**
 * Dispatcher publico para cash_close. v0.9.5 suma styles alternativos. Los
 * toggles (showHighlightedDiff, showMethodBreakdown) y el fontSize del
 * payload se aplican dentro de cada render*Style.
 */
export async function renderCashCloseEscPos(
  tp: Printer,
  payload: CashClosePayload,
  _supabase?: SupabaseClient | undefined,
  _logger?: Logger
): Promise<void> {
  // v0.9.8: fontSize global (ver nota en renderBillPreviewEscPos).
  const fontSize = getFontSize(payload.print_options);
  applyFontSize(tp, fontSize);
  try {
    const style = payload.print_options?.style ?? 'classic';
    switch (style) {
      case 'minimal':
        renderCashCloseMinimal(tp, payload);
        break;
      case 'brand':
        renderCashCloseBrand(tp, payload);
        break;
      case 'thermal_pro':
        renderCashCloseThermalPro(tp, payload);
        break;
      case 'classic':
      default:
        renderCashCloseClassic(tp, payload);
        break;
    }
  } finally {
    resetFontSize(tp);
  }
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
  // Mig 060: width real del papel.
  const width = getPayloadWidth(payload);
  const fontSize = getFontSize(payload.print_options);

  // Toggles bill_preview (mig 058). Defaults rich del Anexo C.
  // Fix v0.9.7 (bugs A1+A2+A3): respetar showAddress / showRut / showQr en
  // minimal style. Antes el minimal imprimia address siempre y no soportaba
  // showRut ni showQr.
  const opts = (payload.print_options ?? {}) as {
    showAddress?: boolean;
    showRut?: boolean;
    showQr?: boolean;
  };
  const showAddress = opts.showAddress !== false; // default true
  const showRut = opts.showRut === true;           // default false en bill_preview
  const showQr = opts.showQr !== false;            // default true

  // Logo respetando el toggle (en minimal generalmente OFF, pero respetamos
  // la config del dueño).
  await printLogoIfEnabled(tp, payload, supabase, logger);

  // Nombre del local: simple, sin centrado bold gigante.
  // fontSize='large' encima del rendering minimal: el dueno eligio minimal
  // explicitamente, asi que respetamos su tamano elegido tambien.
  tp.alignLeft();
  applyHeaderFontSize(tp, fontSize);
  tp.println(payload.restaurant.name);
  if (showAddress) {
    const address = payload.restaurant.address?.trim();
    if (address && address.length > 0) {
      tp.println(address);
    }
    const comuna = payload.restaurant.comuna?.trim();
    if (comuna && comuna.length > 0) {
      tp.println(comuna);
    }
  }
  if (showRut && payload.restaurant.rut) {
    tp.println(`RUT: ${payload.restaurant.rut}`);
  }
  tp.newLine();

  // Titulo simple "PRE-CUENTA"
  tp.println('PRE-CUENTA');
  resetHeaderFontSize(tp);

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
    printBillItem(tp, item, width);
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

  // QR opcional segun toggle (fix v0.9.7 bug A3): si el dueno configuro QR
  // url y showQr no esta explicitamente OFF, lo imprimimos chico al pie.
  // Minimal style mantiene la estetica zen pero respeta el toggle.
  const qrUrl = payload.restaurant.print_qr_url?.trim();
  if (showQr && qrUrl && qrUrl.length > 0) {
    tp.alignCenter();
    const label = payload.restaurant.print_qr_label?.trim();
    if (label && label.length > 0) tp.println(label);
    tp.printQR(qrUrl, { cellSize: 5, correction: 'M' });
    tp.alignLeft();
    tp.newLine();
  }

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
  // Mig 060: width real del papel.
  const width = getPayloadWidth(payload);
  const fontSize = getFontSize(payload.print_options);

  // Toggles del bill_preview con defaults rich (mig 058).
  //  - showAddress default true: nombre del local sale con direccion debajo.
  //  - showRut default false en bill_preview (no es doc legal).
  //  - showQr default true (si print_qr_url seteado).
  // Bug v0.9.6: estos 3 toggles se ignoraban en brand.
  const opts = (payload.print_options ?? {}) as {
    showAddress?: boolean;
    showRut?: boolean;
    showQr?: boolean;
  };
  const showAddress = opts.showAddress !== false; // default true
  const showRut = opts.showRut === true;           // default false en bill_preview
  const showQr = opts.showQr !== false;            // default true

  const ornament = payload.restaurant.print_ornament_char ?? null;

  // Logo grande arriba (toggle del usuario).
  await printLogoIfEnabled(tp, payload, supabase, logger);

  // Nombre del local centrado + bold + doble altura.
  tp.alignCenter();
  tp.bold(true);
  applyHeaderFontSize(tp, fontSize);
  tp.setTextDoubleHeight();
  tp.println(payload.restaurant.name);
  tp.setTextNormal();
  // v0.9.8: restaurar fontSize global tras el emphasis del nombre.
  restoreFontSize(tp, fontSize);
  tp.bold(false);

  // Slogan en lineas debajo del nombre — invitacion + caracter brand.
  const slogan = payload.restaurant.slogan?.trim();
  if (slogan && slogan.length > 0) {
    tp.println(`"${slogan}"`);
  }

  // Direccion + comuna (toggle showAddress). Fix v0.9.7 (bug A1).
  if (showAddress) {
    const addr = payload.restaurant.address?.trim();
    if (addr && addr.length > 0) tp.println(addr);
    const comuna = payload.restaurant.comuna?.trim();
    if (comuna && comuna.length > 0) tp.println(comuna);
  }

  // RUT (toggle showRut, default OFF para bill_preview). Fix v0.9.7 (bug A2).
  // El RestaurantPrintInfo del agente acepta `rut` opcional desde v0.9.7;
  // RPCs viejas no lo envian todavia (Carlos lo agrega aparte) — el bloque
  // se skipa silenciosamente cuando no llega.
  if (showRut && payload.restaurant.rut) {
    tp.println(`RUT: ${payload.restaurant.rut}`);
  }
  tp.alignLeft();

  // Ornament separator
  ornamentSep(tp, ornament, width);

  // Titulo PRE-CUENTA centrado en bold
  tp.alignCenter();
  tp.bold(true);
  tp.println(`PRE-CUENTA #${payload.order_number}`);
  tp.bold(false);
  tp.alignLeft();
  ornamentSep(tp, ornament, width);

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
    printBillItem(tp, item, width);
  }
  tp.newLine();

  // Totales con énfasis brand
  printAmountRow(tp, '  Subtotal', payload.subtotal, true);
  printAmountRow(tp, '  IVA 19%', payload.iva, true);
  tp.drawLine();
  // v0.9.8: pasamos fontSize para que el helper restaure large despues
  // del emphasis. Sin esto, el setTextNormal interno del helper nos saca
  // del modo grande prematuramente y el resto del ticket vuelve a normal.
  printXLTotal(tp, 'TOTAL', payload.total, fontSize);
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

  ornamentSep(tp, ornament, width);

  // Footer: QR + frase con vinetas. Fix v0.9.7 bug A3: pasamos { showQr }
  // para que printBillFooter gateee el QR segun el toggle del dueno.
  printBillFooter(tp, payload.restaurant, { showQr });

  // Frase final destacada con ornament a los lados (si hay ornament safe-ASCII).
  // Si llega un char legacy CP437 (♥, ♦, etc), fallback a `*` igual que ornamentSep.
  if (ornament) {
    const safeOrn = isSafeOrnament(ornament) ? ornament : '*';
    tp.alignCenter();
    tp.bold(true);
    tp.println(`${safeOrn} ¡Gracias por elegirnos! ${safeOrn}`);
    tp.bold(false);
    tp.alignLeft();
  }

  ornamentSep(tp, ornament, width);
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
  // Mig 060: width real del papel.
  const width = getPayloadWidth(payload);
  const fontSize = getFontSize(payload.print_options);

  // Toggles bill_preview (fix v0.9.7 bugs A1+A2+A3).
  const opts = (payload.print_options ?? {}) as {
    showAddress?: boolean;
    showRut?: boolean;
    showQr?: boolean;
  };
  const showAddress = opts.showAddress !== false; // default true
  const showRut = opts.showRut === true;           // default false en bill_preview
  const showQr = opts.showQr !== false;            // default true

  // Logo respetando el toggle (en thermal_pro generalmente OFF para
  // priorizar densidad de info).
  await printLogoIfEnabled(tp, payload, supabase, logger);

  // Header denso: nombre + direccion en una linea.
  // fontSize='large' agranda el header (rompe densidad pero respeta opcion).
  tp.println('='.repeat(width));
  applyHeaderFontSize(tp, fontSize);
  const name = payload.restaurant.name;
  const addr = payload.restaurant.address?.trim();
  if (showAddress && addr && addr.length > 0) {
    tp.println(`${name} · ${addr}`);
  } else {
    tp.println(name);
  }

  // Comuna + telefono (gated por showAddress)
  if (showAddress) {
    const comuna = payload.restaurant.comuna?.trim();
    const phone = payload.restaurant.phone?.trim();
    if (comuna && phone) {
      tp.println(`${comuna} · Tel ${phone}`);
    } else if (comuna) {
      tp.println(comuna);
    } else if (phone) {
      tp.println(`Tel ${phone}`);
    }
  }
  // RUT (default OFF en bill_preview).
  if (showRut && payload.restaurant.rut) {
    tp.println(`RUT: ${payload.restaurant.rut}`);
  }
  resetHeaderFontSize(tp);
  tp.println('='.repeat(width));

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
    const unit = formatCLP(item.unit_price);
    const sub = formatCLP(item.subtotal);
    tp.leftRight(`   ${unit} c/u`, sub);
  }
  tp.drawLine();

  // Subtotal + IVA simple
  printAmountRow(tp, 'Subtotal', payload.subtotal);
  printAmountRow(tp, 'IVA 19%', payload.iva);
  tp.bold(true);
  printAmountRow(tp, 'TOTAL', payload.total);
  tp.bold(false);
  tp.println('='.repeat(width));

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
    const tipFmt = formatCLP(t.amount);
    const totalWithTip = formatCLP(payload.total + t.amount);
    tp.println(`  ${String(t.pct).padStart(2)}%  ${tipFmt} -> total ${totalWithTip}`);
  }
  tp.println('='.repeat(width));

  // Footer (sin ornament, mantener look pro). Fix v0.9.7 bug A3: showQr.
  printBillFooter(tp, payload.restaurant, { showQr });
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
  // Mig 060: width real del papel.
  const width = getPayloadWidth(payload);
  const fontSize = getFontSize(payload.print_options);

  // Toggles bill_proforma (fix v0.9.7 bugs A1+A2+A3). showRut default TRUE.
  const opts = (payload.print_options ?? {}) as {
    showAddress?: boolean;
    showRut?: boolean;
    showQr?: boolean;
  };
  const showAddress = opts.showAddress !== false; // default true
  const showRut = opts.showRut !== false;          // default true en bill_proforma
  const showQr = opts.showQr !== false;            // default true

  await printLogoIfEnabled(tp, payload, supabase, logger);

  tp.alignLeft();
  applyHeaderFontSize(tp, fontSize);
  tp.println(payload.restaurant.name);
  if (showAddress) {
    const address = payload.restaurant.address?.trim();
    if (address && address.length > 0) {
      tp.println(address);
    }
    const comuna = payload.restaurant.comuna?.trim();
    if (comuna && comuna.length > 0) {
      tp.println(comuna);
    }
  }
  if (showRut && payload.restaurant.rut) {
    tp.println(`RUT: ${payload.restaurant.rut}`);
  }
  tp.newLine();

  tp.println(`BOLETA #${payload.order_number}`);
  resetHeaderFontSize(tp);

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
    printBillItem(tp, item, width);
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

  // QR opcional segun toggle (fix v0.9.7 bug A3) — minimal usa cellSize chico.
  const qrUrl = payload.restaurant.print_qr_url?.trim();
  if (showQr && qrUrl && qrUrl.length > 0) {
    tp.alignCenter();
    const label = payload.restaurant.print_qr_label?.trim();
    if (label && label.length > 0) tp.println(label);
    tp.printQR(qrUrl, { cellSize: 5, correction: 'M' });
    tp.alignLeft();
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
  // Mig 060: width real del papel.
  const width = getPayloadWidth(payload);
  const fontSize = getFontSize(payload.print_options);

  // Toggles bill_proforma (fix v0.9.7 bugs A1+A2+A3). showRut default TRUE.
  const opts = (payload.print_options ?? {}) as {
    showAddress?: boolean;
    showRut?: boolean;
    showQr?: boolean;
  };
  const showAddress = opts.showAddress !== false; // default true
  const showRut = opts.showRut !== false;          // default true en bill_proforma
  const showQr = opts.showQr !== false;            // default true

  const ornament = payload.restaurant.print_ornament_char ?? null;

  await printLogoIfEnabled(tp, payload, supabase, logger);

  tp.alignCenter();
  tp.bold(true);
  applyHeaderFontSize(tp, fontSize);
  tp.setTextDoubleHeight();
  tp.println(payload.restaurant.name);
  tp.setTextNormal();
  // v0.9.8: restaurar fontSize global tras el emphasis del nombre.
  restoreFontSize(tp, fontSize);
  tp.bold(false);

  const slogan = payload.restaurant.slogan?.trim();
  if (slogan && slogan.length > 0) {
    tp.println(`"${slogan}"`);
  }
  // Direccion + comuna (toggle showAddress). Fix v0.9.7 bug A1.
  if (showAddress) {
    const addr = payload.restaurant.address?.trim();
    if (addr && addr.length > 0) tp.println(addr);
    const comuna = payload.restaurant.comuna?.trim();
    if (comuna && comuna.length > 0) tp.println(comuna);
  }
  // RUT (default ON en proforma — es la boleta final, OK mostrarlo).
  if (showRut && payload.restaurant.rut) {
    tp.println(`RUT: ${payload.restaurant.rut}`);
  }
  tp.alignLeft();

  ornamentSep(tp, ornament, width);

  tp.alignCenter();
  tp.bold(true);
  tp.println(`BOLETA #${payload.order_number}`);
  tp.bold(false);
  tp.alignLeft();
  ornamentSep(tp, ornament, width);

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
    printBillItem(tp, item, width);
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
  // v0.9.8: pasamos fontSize (ver nota arriba en classic).
  printXLTotal(tp, 'TOTAL', payload.total + tip, fontSize);
  tp.newLine();

  // Payment destacado (centrado + bold)
  if (payload.payment) {
    ornamentSep(tp, ornament, width);
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

  ornamentSep(tp, ornament, width);
  // Fix v0.9.7 bug A3: respetar showQr.
  printBillFooter(tp, payload.restaurant, { showQr });

  // Frase final destacada con ornament safe-ASCII (fallback `*` si llega CP437).
  if (ornament) {
    const safeOrn = isSafeOrnament(ornament) ? ornament : '*';
    tp.alignCenter();
    tp.bold(true);
    tp.println(`${safeOrn} ¡Gracias por elegirnos! ${safeOrn}`);
    tp.bold(false);
    tp.alignLeft();
  }

  ornamentSep(tp, ornament, width);
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
  // Mig 060: width real del papel.
  const width = getPayloadWidth(payload);
  const fontSize = getFontSize(payload.print_options);

  // Toggles bill_proforma (fix v0.9.7 bugs A1+A2+A3). showRut default TRUE.
  const opts = (payload.print_options ?? {}) as {
    showAddress?: boolean;
    showRut?: boolean;
    showQr?: boolean;
  };
  const showAddress = opts.showAddress !== false; // default true
  const showRut = opts.showRut !== false;          // default true en bill_proforma
  const showQr = opts.showQr !== false;            // default true

  await printLogoIfEnabled(tp, payload, supabase, logger);

  tp.println('='.repeat(width));
  applyHeaderFontSize(tp, fontSize);
  const name = payload.restaurant.name;
  const addr = payload.restaurant.address?.trim();
  if (showAddress && addr && addr.length > 0) {
    tp.println(`${name} · ${addr}`);
  } else {
    tp.println(name);
  }
  if (showAddress) {
    const comuna = payload.restaurant.comuna?.trim();
    const phone = payload.restaurant.phone?.trim();
    if (comuna && phone) {
      tp.println(`${comuna} · Tel ${phone}`);
    } else if (comuna) {
      tp.println(comuna);
    } else if (phone) {
      tp.println(`Tel ${phone}`);
    }
  }
  if (showRut && payload.restaurant.rut) {
    tp.println(`RUT: ${payload.restaurant.rut}`);
  }
  resetHeaderFontSize(tp);
  tp.println('='.repeat(width));

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
    const unit = formatCLP(item.unit_price);
    const sub = formatCLP(item.subtotal);
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
  tp.println('='.repeat(width));

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
    tp.println('='.repeat(width));
  }

  // Fix v0.9.7 bug A3: respetar showQr.
  printBillFooter(tp, payload.restaurant, { showQr });
  tp.newLine();
}

// ====================================================================
// Style variants para kitchen_order / kitchen_cancel / cash_close
// ====================================================================
//
// Hasta v0.9.4 estos 3 tipos solo tenian Classic implementado y los
// dispatchers siempre llamaban a Classic — los styles minimal/brand/
// thermal_pro elegidos en /settings/print-templates eran ignorados
// por el agente (engano al usuario).
//
// v0.9.5 suma las 9 variantes para que el style elegido por el dueno
// se respete. Replican la estructura del Classic con variaciones
// esteticas (minimal: aire/sin badges, brand: ornament/bold,
// thermal_pro: denso/igual ancho).
//
// Patron general (igual que bill_preview/bill_proforma):
//  - applyHeaderFontSize/resetHeaderFontSize en el header.
//  - fontSize='large' SOLO en header (nombre/titulo). Items quedan en
//    normal para no romper el layout 32/42/48.
// ====================================================================

/**
 * MINIMAL style para kitchen_order: header sobrio (sin doble altura),
 * items pelados sin badges invertidos, sin TOTAL ITEMS gigante al final.
 * Util para cocinas donde la comanda se lee de a 30cm — la jerarquia la
 * dan el espacio en blanco y el nombre claro de items.
 */
function renderKitchenOrderMinimal(
  tp: Printer,
  payload: KitchenJobPayload,
  jobType: 'kitchen_order' | 'bar_order' = 'kitchen_order'
): void {
  const station = resolveStationLabel(jobType, payload.printer_name, payload.area_name);
  const destination = resolveDestination(payload);
  const time = formatTime(payload.opened_at);

  const opts = (payload.print_options ?? {}) as {
    showOpenTime?: boolean;
    showHighlightedNotes?: boolean;
    showGiftMark?: boolean;
    showPrices?: boolean;
    showWaiter?: boolean;
    showGuests?: boolean;
    fontSize?: 'small' | 'normal' | 'large';
  };
  const showOpenTime = opts.showOpenTime ?? true;
  const showHighlightedNotes = opts.showHighlightedNotes ?? true;
  const showGiftMark = opts.showGiftMark ?? true;
  const showPrices = opts.showPrices ?? false;
  const showWaiter = opts.showWaiter ?? true;
  const showGuests = opts.showGuests ?? true;
  const fontSize = getFontSize(opts);

  // Header simple: nombre estacion + destino, sin doble altura. fontSize
  // sigue aplicandose si el dueno explicitamente eligio 'large'.
  tp.alignLeft();
  applyHeaderFontSize(tp, fontSize);
  tp.println(station);
  tp.println(destination);
  resetHeaderFontSize(tp);

  // Subtitle en linea unica: mesero . hora . "Hace X min".
  //
  // Fix v0.9.7 bug A5: la hora absoluta (e.g. "03:15") solo sale si
  // showOpenTime no esta explicitamente OFF. Antes la hora se pushaba
  // siempre, ignorando el toggle del dueno. El toggle "Hora apertura"
  // controla la hora completa (absoluta + "Hace X min"), no solo el
  // "Hace X min".
  const subtitleParts: string[] = [];
  if (showWaiter) {
    const waiter = payload.waiter_name?.trim() || '-';
    subtitleParts.push(waiter);
  }
  if (showGuests) {
    subtitleParts.push(`${payload.guests} pax`);
  }
  if (showOpenTime) {
    const elapsedMin = minutesSinceOpened(payload.opened_at);
    if (elapsedMin != null) {
      subtitleParts.push(`Hace ${elapsedMin} min`);
    }
    subtitleParts.push(time);
  }
  if (subtitleParts.length > 0) {
    tp.println(subtitleParts.join(' . '));
  }
  tp.newLine();

  // Items pelados, sin bold ni invert por defecto.
  for (const item of payload.items) {
    tp.println(`${item.quantity}x ${item.name}`);
    if (showGiftMark && item.is_gift) {
      tp.println('   * cortesia');
    }
    for (const mod of item.modifiers) {
      if (showPrices && mod.priceDelta !== 0) {
        const fmt = formatCLP(mod.priceDelta);
        tp.println(`   - ${mod.name} (${mod.priceDelta > 0 ? '+' : ''}${fmt})`);
      } else {
        tp.println(`   - ${mod.name}`);
      }
    }
    if (item.note && item.note.trim().length > 0) {
      // En minimal, las notas van en corchetes sin invertir (queda menos
      // chillon, mantiene el toggle de showHighlightedNotes con efecto
      // visible solo en corchetes vs sin).
      if (showHighlightedNotes) {
        tp.println(`   [${item.note.trim()}]`);
      } else {
        tp.println(`   ${item.note.trim()}`);
      }
    }
  }

  if (payload.customer_note && payload.customer_note.trim().length > 0) {
    tp.newLine();
    tp.println(`Notas mesa: ${payload.customer_note.trim()}`);
  }

  // Total items al final, en linea normal (sin doble altura).
  const totalItems = payload.items.reduce((acc, it) => acc + it.quantity, 0);
  tp.newLine();
  tp.println(`Total items: ${totalItems}`);
  tp.newLine();
}

/**
 * BRAND style para kitchen_order: header con ornament a los lados, doble
 * altura + bold como Classic pero sumando vinetas y ornament en los
 * separadores. Util si el dueno quiere que las comandas se vean con la
 * misma identidad visual que las boletas.
 */
function renderKitchenOrderBrand(
  tp: Printer,
  payload: KitchenJobPayload,
  jobType: 'kitchen_order' | 'bar_order' = 'kitchen_order'
): void {
  const width = getPayloadWidth(payload);
  const station = resolveStationLabel(jobType, payload.printer_name, payload.area_name);
  const destination = resolveDestination(payload);
  const time = formatTime(payload.opened_at);

  const opts = (payload.print_options ?? {}) as {
    showOpenTime?: boolean;
    showHighlightedNotes?: boolean;
    showGiftMark?: boolean;
    showPrices?: boolean;
    showWaiter?: boolean;
    showGuests?: boolean;
    fontSize?: 'small' | 'normal' | 'large';
  };
  const showOpenTime = opts.showOpenTime ?? true;
  const showHighlightedNotes = opts.showHighlightedNotes ?? true;
  const showGiftMark = opts.showGiftMark ?? true;
  const showPrices = opts.showPrices ?? false;
  const showWaiter = opts.showWaiter ?? true;
  const showGuests = opts.showGuests ?? true;
  const fontSize = getFontSize(opts);

  // Restaurant del payload (mig 058 lo agrego para kitchen_order). Si llega
  // undefined, el ornament cae a null y el separador queda plano.
  const ornament = payload.restaurant?.print_ornament_char ?? null;

  // Header con ornament arriba + nombre estacion + destino XL + ornament abajo.
  ornamentSep(tp, ornament, width);
  tp.alignCenter();
  tp.bold(true);
  applyHeaderFontSize(tp, fontSize);
  tp.setTextDoubleHeight();
  tp.println(station);
  tp.println(destination);
  resetHeaderFontSize(tp);
  tp.bold(false);
  tp.alignLeft();
  ornamentSep(tp, ornament, width);

  // Subtitle (igual estructura que Classic).
  // Fix v0.9.7 bug A5: hora absoluta gated por showOpenTime.
  const headerLineParts: string[] = [];
  if (showOpenTime) {
    headerLineParts.push(time);
    const elapsedMin = minutesSinceOpened(payload.opened_at);
    if (elapsedMin != null) {
      headerLineParts.push(`Hace ${elapsedMin} min`);
    }
  }
  if (showWaiter) {
    const waiter = payload.waiter_name?.trim() || '-';
    headerLineParts.unshift(`Mesero: ${waiter}`);
  }
  if (headerLineParts.length > 0) {
    tp.println(headerLineParts.join(' . '));
  }
  if (showGuests) {
    tp.println(`Comensales: ${payload.guests}`);
  }
  tp.newLine();

  // Items igual que Classic (con toggles)
  for (const item of payload.items) {
    printKitchenItemWithToggles(tp, item, {
      showHighlightedNotes,
      showGiftMark,
      showPrices,
    });
  }

  if (payload.customer_note && payload.customer_note.trim().length > 0) {
    ornamentSep(tp, ornament, width);
    if (showHighlightedNotes) {
      tp.bold(true);
      tp.invert(true);
      tp.println(` Notas mesa: ${payload.customer_note.trim()} `);
      tp.invert(false);
      tp.bold(false);
    } else {
      tp.println(`Notas mesa: ${payload.customer_note.trim()}`);
    }
  }

  // TOTAL ITEMS XL con ornament a los lados del separador previo.
  const totalItems = payload.items.reduce((acc, it) => acc + it.quantity, 0);
  ornamentSep(tp, ornament, width);
  tp.alignCenter();
  tp.bold(true);
  tp.setTextDoubleHeight();
  tp.println(`TOTAL ITEMS: ${totalItems}`);
  tp.setTextNormal();
  // v0.9.8: restaurar fontSize global tras el emphasis.
  restoreFontSize(tp, fontSize);
  tp.bold(false);
  tp.alignLeft();
  tp.newLine();
}

/**
 * THERMAL_PRO style para kitchen_order: header denso (1 linea), items con
 * detalle inline, sin doble altura. Max info por cm de papel — pensado
 * para cocinas operativas que valoran densidad sobre estetica.
 */
function renderKitchenOrderThermalPro(
  tp: Printer,
  payload: KitchenJobPayload,
  jobType: 'kitchen_order' | 'bar_order' = 'kitchen_order'
): void {
  const width = getPayloadWidth(payload);
  const station = resolveStationLabel(jobType, payload.printer_name, payload.area_name);
  const destination = resolveDestination(payload);
  const time = formatTime(payload.opened_at);

  const opts = (payload.print_options ?? {}) as {
    showOpenTime?: boolean;
    showHighlightedNotes?: boolean;
    showGiftMark?: boolean;
    showPrices?: boolean;
    showWaiter?: boolean;
    showGuests?: boolean;
    fontSize?: 'small' | 'normal' | 'large';
  };
  const showOpenTime = opts.showOpenTime ?? true;
  const showHighlightedNotes = opts.showHighlightedNotes ?? true;
  const showGiftMark = opts.showGiftMark ?? true;
  const showPrices = opts.showPrices ?? false;
  const showWaiter = opts.showWaiter ?? true;
  const showGuests = opts.showGuests ?? true;
  const fontSize = getFontSize(opts);

  // Header denso: estacion + destino en una sola linea con `.`.
  tp.println('='.repeat(width));
  applyHeaderFontSize(tp, fontSize);
  tp.bold(true);
  tp.println(`${station} . ${destination}`);
  tp.bold(false);
  resetHeaderFontSize(tp);
  tp.println('='.repeat(width));

  // Meta: mesero, pax, "Hace X min", hora — todo en una linea.
  // Fix v0.9.7 bug A5: hora absoluta gated por showOpenTime.
  const meta: string[] = [];
  if (showWaiter) {
    const waiter = payload.waiter_name?.trim() || '-';
    meta.push(waiter);
  }
  if (showGuests) {
    meta.push(`${payload.guests} pax`);
  }
  if (showOpenTime) {
    const elapsedMin = minutesSinceOpened(payload.opened_at);
    if (elapsedMin != null) {
      meta.push(`Hace ${elapsedMin} min`);
    }
    meta.push(time);
  }
  if (meta.length > 0) tp.println(meta.join(' . '));
  tp.drawLine();

  // Items con prices/notes en compact (sin bold, sin newlines extra)
  for (const item of payload.items) {
    tp.println(`${item.quantity}x ${item.name}`);
    if (showGiftMark && item.is_gift) {
      tp.println('   * CORTESIA');
    }
    for (const mod of item.modifiers) {
      if (showPrices && mod.priceDelta !== 0) {
        const fmt = formatCLP(mod.priceDelta);
        tp.println(`   - ${mod.name} (${mod.priceDelta > 0 ? '+' : ''}${fmt})`);
      } else {
        tp.println(`   - ${mod.name}`);
      }
    }
    if (item.note && item.note.trim().length > 0) {
      if (showHighlightedNotes) {
        tp.bold(true);
        tp.println(`   [${item.note.trim()}]`);
        tp.bold(false);
      } else {
        tp.println(`   [${item.note.trim()}]`);
      }
    }
  }

  if (payload.customer_note && payload.customer_note.trim().length > 0) {
    tp.drawLine();
    tp.println(`Notas mesa: ${payload.customer_note.trim()}`);
  }

  // TOTAL ITEMS sin doble altura, alineado izquierda.
  const totalItems = payload.items.reduce((acc, it) => acc + it.quantity, 0);
  tp.println('='.repeat(width));
  tp.bold(true);
  tp.println(`TOTAL ITEMS: ${totalItems}`);
  tp.bold(false);
  tp.newLine();
}

/**
 * MINIMAL style para kitchen_cancel: anulacion plana sin badge invertido.
 * "ANULACION" en bold solo, items con prefijo "[X]" sin enfasis, motivo
 * inline simple.
 */
function renderKitchenCancelMinimal(
  tp: Printer,
  payload: KitchenJobPayload
): void {
  const destination = resolveDestination(payload);
  const time = formatTime(payload.opened_at);

  const opts = (payload.print_options ?? {}) as {
    showReason?: boolean;
    showWaiter?: boolean;
    fontSize?: 'small' | 'normal' | 'large';
  };
  const showReason = opts.showReason ?? true;
  const showWaiter = opts.showWaiter ?? true;
  const fontSize = getFontSize(opts);

  // Header minimal: "ANULACION" en bold + destino debajo. Sin invertido,
  // sin doble altura.
  tp.alignLeft();
  applyHeaderFontSize(tp, fontSize);
  tp.bold(true);
  tp.println('ANULACION');
  tp.bold(false);
  tp.println(destination);
  resetHeaderFontSize(tp);

  // Subtitle inline
  if (showWaiter) {
    const waiter = payload.waiter_name?.trim() || '-';
    tp.println(`${waiter} . ${time}`);
  } else {
    tp.println(time);
  }
  tp.newLine();

  // Items con prefijo [X], sin bold
  for (const item of payload.items) {
    tp.println(`[X] ${item.quantity}x ${item.name}`);
    for (const mod of item.modifiers) {
      tp.println(`    - ${mod.name}`);
    }
    if (item.note && item.note.trim().length > 0) {
      tp.println(`    ${item.note.trim()}`);
    }
  }

  if (showReason && payload.customer_note && payload.customer_note.trim().length > 0) {
    tp.newLine();
    tp.println(`Motivo: ${payload.customer_note.trim()}`);
  }
  tp.newLine();
}

/**
 * BRAND style para kitchen_cancel: badge invertido como Classic + ornament
 * en separadores para que la anulacion mantenga el lenguaje visual del
 * resto del ticketing del local.
 */
function renderKitchenCancelBrand(
  tp: Printer,
  payload: KitchenJobPayload
): void {
  const width = getPayloadWidth(payload);
  const destination = resolveDestination(payload);
  const time = formatTime(payload.opened_at);

  const opts = (payload.print_options ?? {}) as {
    showReason?: boolean;
    showWaiter?: boolean;
    fontSize?: 'small' | 'normal' | 'large';
  };
  const showReason = opts.showReason ?? true;
  const showWaiter = opts.showWaiter ?? true;
  const fontSize = getFontSize(opts);

  const ornament = payload.restaurant?.print_ornament_char ?? null;

  // Header brand: ornament + badge invertido + destino + ornament
  ornamentSep(tp, ornament, width);
  tp.alignCenter();
  tp.bold(true);
  tp.invert(true);
  applyHeaderFontSize(tp, fontSize);
  tp.setTextDoubleHeight();
  tp.println(' ANULACION ');
  tp.invert(false);
  tp.println(destination);
  resetHeaderFontSize(tp);
  tp.bold(false);
  tp.alignLeft();
  ornamentSep(tp, ornament, width);

  if (showWaiter) {
    const waiter = payload.waiter_name?.trim() || '-';
    tp.println(`Mesero: ${waiter} . ${time}`);
  } else {
    tp.println(time);
  }
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

  if (showReason && payload.customer_note && payload.customer_note.trim().length > 0) {
    ornamentSep(tp, ornament, width);
    tp.println(`Motivo: ${payload.customer_note.trim()}`);
  }
  ornamentSep(tp, ornament, width);
  tp.newLine();
}

/**
 * THERMAL_PRO style para kitchen_cancel: header denso, items compactos.
 * Mismo principio que kitchen_order thermal_pro: max info, min chrome.
 */
function renderKitchenCancelThermalPro(
  tp: Printer,
  payload: KitchenJobPayload
): void {
  const width = getPayloadWidth(payload);
  const destination = resolveDestination(payload);
  const time = formatTime(payload.opened_at);

  const opts = (payload.print_options ?? {}) as {
    showReason?: boolean;
    showWaiter?: boolean;
    fontSize?: 'small' | 'normal' | 'large';
  };
  const showReason = opts.showReason ?? true;
  const showWaiter = opts.showWaiter ?? true;
  const fontSize = getFontSize(opts);

  tp.println('='.repeat(width));
  applyHeaderFontSize(tp, fontSize);
  tp.bold(true);
  tp.println(`ANULACION . ${destination}`);
  tp.bold(false);
  resetHeaderFontSize(tp);
  tp.println('='.repeat(width));

  if (showWaiter) {
    const waiter = payload.waiter_name?.trim() || '-';
    tp.println(`${waiter} . ${time}`);
  } else {
    tp.println(time);
  }
  tp.drawLine();

  for (const item of payload.items) {
    tp.println(`[X] ${item.quantity}x ${item.name}`);
    for (const mod of item.modifiers) {
      tp.println(`    - ${mod.name}`);
    }
    if (item.note && item.note.trim().length > 0) {
      tp.println(`    [${item.note.trim()}]`);
    }
  }

  if (showReason && payload.customer_note && payload.customer_note.trim().length > 0) {
    tp.drawLine();
    tp.println(`Motivo: ${payload.customer_note.trim()}`);
  }
  tp.println('='.repeat(width));
  tp.newLine();
}

/**
 * MINIMAL style para cash_close: layout sobrio, sin doble altura, sin
 * separadores fuertes ni badges. Pensado para cierres que se archivan
 * mucho — papel limpio y legible cuando se reabra en 6 meses.
 */
function renderCashCloseMinimal(
  tp: Printer,
  payload: CashClosePayload
): void {
  const opts = (payload.print_options ?? {}) as {
    showHighlightedDiff?: boolean;
    showMethodBreakdown?: boolean;
    fontSize?: 'small' | 'normal' | 'large';
  };
  const showHighlightedDiff = opts.showHighlightedDiff ?? true;
  const showMethodBreakdown = opts.showMethodBreakdown ?? true;
  const fontSize = getFontSize(opts);

  // Header simple: nombre del local + direccion si existe.
  tp.alignLeft();
  if (payload.restaurant) {
    applyHeaderFontSize(tp, fontSize);
    tp.println(payload.restaurant.name);
    const address = payload.restaurant.address?.trim();
    if (address && address.length > 0) {
      tp.println(address);
    }
    resetHeaderFontSize(tp);
  }
  tp.newLine();

  // Titulo simple
  tp.println('Cierre de caja diario');
  if (payload.location_name && payload.location_name.trim().length > 0) {
    tp.println(payload.location_name.trim());
  }
  tp.println(formatDateTime(payload.closed_at));
  const openedBy = payload.opened_by_name?.trim() || '-';
  const closedBy = payload.closed_by_name?.trim() || '-';
  tp.println(`Turno: ${openedBy} -> ${closedBy}`);
  tp.newLine();

  // Ventas sin bold
  printAmountRow(tp, 'Ventas totales', payload.total_sales);

  if (showMethodBreakdown) {
    printAmountRow(tp, 'Efectivo', payload.total_cash, true);
    printAmountRow(tp, 'Tarjeta MP', payload.total_card_mp, true);
    printAmountRow(tp, 'Otras tarjetas', payload.total_card_other, true);
    printAmountRow(tp, 'Transferencia', payload.total_transfer, true);
    tp.newLine();
  }

  printAmountRow(tp, 'Propinas', payload.total_tips);
  printAmountRow(tp, 'Devoluciones', payload.total_refunds);
  tp.leftRight('Comandas:', String(payload.order_count));
  tp.newLine();

  printAmountRow(tp, 'Esperado', payload.expected_cash);
  printAmountRow(tp, 'Declarado', payload.closing_cash);
  if (showHighlightedDiff) {
    // En minimal no usamos invert pleno — solo bold para senalar diferencia.
    tp.bold(true);
    printAmountRow(tp, 'Diferencia', payload.difference);
    tp.bold(false);
  } else {
    printAmountRow(tp, 'Diferencia', payload.difference);
  }

  if (payload.notes && payload.notes.trim().length > 0) {
    tp.newLine();
    tp.println(`Notas: ${payload.notes.trim()}`);
  }

  // Footer simple (sin ornament)
  if (payload.restaurant) {
    tp.newLine();
    const phrase =
      payload.restaurant.print_footer_phrase?.trim() || 'Gracias.';
    tp.println(phrase);
  }
  tp.newLine();
}

/**
 * BRAND style para cash_close: ornament en header y al cierre, nombre del
 * local con doble altura, slogan visible. Mantiene la identidad visual
 * del local incluso en un documento operativo como el cierre.
 */
function renderCashCloseBrand(
  tp: Printer,
  payload: CashClosePayload
): void {
  const width = getPayloadWidth(payload);

  const opts = (payload.print_options ?? {}) as {
    showHighlightedDiff?: boolean;
    showMethodBreakdown?: boolean;
    fontSize?: 'small' | 'normal' | 'large';
  };
  const showHighlightedDiff = opts.showHighlightedDiff ?? true;
  const showMethodBreakdown = opts.showMethodBreakdown ?? true;
  const fontSize = getFontSize(opts);

  const ornament = payload.restaurant?.print_ornament_char ?? null;

  // Header rich del restaurant con ornament
  if (payload.restaurant) {
    ornamentSep(tp, ornament, width);
    tp.alignCenter();
    tp.bold(true);
    applyHeaderFontSize(tp, fontSize);
    tp.setTextDoubleHeight();
    tp.println(payload.restaurant.name);
    tp.setTextNormal();
    // v0.9.8: restaurar fontSize global tras el emphasis del nombre.
    restoreFontSize(tp, fontSize);
    tp.bold(false);

    const slogan = payload.restaurant.slogan?.trim();
    if (slogan && slogan.length > 0) {
      tp.println(`"${slogan}"`);
    }
    resetHeaderFontSize(tp);
    tp.alignLeft();
    ornamentSep(tp, ornament, width);
  }

  // Titulo "CIERRE DE CAJA" centrado en bold (sin doble altura para no
  // competir con el nombre del local que ya esta XL).
  tp.alignCenter();
  tp.bold(true);
  tp.println('CIERRE DE CAJA DIARIO');
  tp.bold(false);
  tp.alignLeft();
  ornamentSep(tp, ornament, width);

  // Meta del cierre
  if (payload.location_name && payload.location_name.trim().length > 0) {
    tp.println(payload.location_name.trim());
  }
  tp.println(formatDateTime(payload.closed_at));
  const openedBy = payload.opened_by_name?.trim() || '-';
  const closedBy = payload.closed_by_name?.trim() || '-';
  tp.println(`Turno: ${openedBy} -> ${closedBy}`);
  tp.newLine();

  // Ventas
  tp.bold(true);
  printAmountRow(tp, 'Ventas totales', payload.total_sales);
  tp.bold(false);

  if (showMethodBreakdown) {
    printAmountRow(tp, 'Efectivo', payload.total_cash, true);
    printAmountRow(tp, 'Tarjeta MP', payload.total_card_mp, true);
    printAmountRow(tp, 'Otras tarjetas', payload.total_card_other, true);
    printAmountRow(tp, 'Transferencia', payload.total_transfer, true);
    tp.newLine();
  }

  printAmountRow(tp, 'Propinas', payload.total_tips);
  printAmountRow(tp, 'Devoluciones', payload.total_refunds);
  tp.leftRight('Comandas totales:', String(payload.order_count));
  tp.newLine();

  ornamentSep(tp, ornament, width);
  printAmountRow(tp, 'Efectivo esperado', payload.expected_cash);
  printAmountRow(tp, 'Efectivo declarado', payload.closing_cash);

  if (showHighlightedDiff) {
    tp.bold(true);
    tp.invert(true);
    printAmountRow(tp, ' DIFERENCIA ', payload.difference);
    tp.invert(false);
    tp.bold(false);
  } else {
    tp.bold(true);
    printAmountRow(tp, 'DIFERENCIA', payload.difference);
    tp.bold(false);
  }

  if (payload.notes && payload.notes.trim().length > 0) {
    ornamentSep(tp, ornament, width);
    tp.println(`Notas: ${payload.notes.trim()}`);
  }

  if (payload.restaurant) {
    ornamentSep(tp, ornament, width);
    printBillFooter(tp, payload.restaurant);
  }
  tp.newLine();
}

/**
 * THERMAL_PRO style para cash_close: header denso, breakdown compacto, sin
 * floralera visual. Util para cierres que se archivan en planilla (cabe
 * mas info por hoja).
 */
function renderCashCloseThermalPro(
  tp: Printer,
  payload: CashClosePayload
): void {
  const width = getPayloadWidth(payload);

  const opts = (payload.print_options ?? {}) as {
    showHighlightedDiff?: boolean;
    showMethodBreakdown?: boolean;
    fontSize?: 'small' | 'normal' | 'large';
  };
  const showHighlightedDiff = opts.showHighlightedDiff ?? true;
  const showMethodBreakdown = opts.showMethodBreakdown ?? true;
  const fontSize = getFontSize(opts);

  // Header denso del local
  tp.println('='.repeat(width));
  if (payload.restaurant) {
    applyHeaderFontSize(tp, fontSize);
    const addr = payload.restaurant.address?.trim();
    if (addr && addr.length > 0) {
      tp.println(`${payload.restaurant.name} . ${addr}`);
    } else {
      tp.println(payload.restaurant.name);
    }
    resetHeaderFontSize(tp);
  }
  tp.println('='.repeat(width));

  // Titulo
  tp.bold(true);
  tp.println('CIERRE DE CAJA DIARIO');
  tp.bold(false);
  if (payload.location_name && payload.location_name.trim().length > 0) {
    tp.println(payload.location_name.trim());
  }
  tp.println(formatDateTime(payload.closed_at));
  const openedBy = payload.opened_by_name?.trim() || '-';
  const closedBy = payload.closed_by_name?.trim() || '-';
  tp.println(`Turno: ${openedBy} -> ${closedBy}`);
  tp.drawLine();

  printAmountRow(tp, 'Ventas totales', payload.total_sales);
  if (showMethodBreakdown) {
    printAmountRow(tp, 'Efectivo', payload.total_cash, true);
    printAmountRow(tp, 'Tarjeta MP', payload.total_card_mp, true);
    printAmountRow(tp, 'Otras tarjetas', payload.total_card_other, true);
    printAmountRow(tp, 'Transferencia', payload.total_transfer, true);
  }
  printAmountRow(tp, 'Propinas', payload.total_tips);
  printAmountRow(tp, 'Devoluciones', payload.total_refunds);
  tp.leftRight('Comandas totales:', String(payload.order_count));
  tp.println('='.repeat(width));

  printAmountRow(tp, 'Efectivo esperado', payload.expected_cash);
  printAmountRow(tp, 'Efectivo declarado', payload.closing_cash);
  if (showHighlightedDiff) {
    tp.bold(true);
    printAmountRow(tp, 'DIFERENCIA', payload.difference);
    tp.bold(false);
  } else {
    printAmountRow(tp, 'DIFERENCIA', payload.difference);
  }

  if (payload.notes && payload.notes.trim().length > 0) {
    tp.drawLine();
    tp.println(`Notas: ${payload.notes.trim()}`);
  }
  tp.println('='.repeat(width));

  if (payload.restaurant) {
    const phrase =
      payload.restaurant.print_footer_phrase?.trim() || 'Gracias por su preferencia!';
    tp.println(phrase);
  }
  tp.newLine();
}
