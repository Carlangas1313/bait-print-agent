/**
 * Tipos compartidos del agente.
 *
 * Espejo de los tipos del repo bait-pos (apps/web/lib/actions/print-jobs.ts).
 * Si esos cambian, hay que mantener este archivo sincronizado.
 */

import type {
  BillPreviewOptions,
  BillProformaOptions,
  KitchenOrderOptions,
  KitchenCancelOptions,
  CashCloseOptions,
} from './types/print-options.js';

export type JobType =
  | 'kitchen_order'
  | 'bar_order'
  | 'bill_preview'
  | 'bill_proforma'
  | 'sii_receipt'
  | 'cash_close'
  | 'kitchen_cancel'
  // mig 082 bait-pos: facturas electronicas tributarias (33 / 34) y
  // notas de credito (61) con bloque RECEPTOR y marca legal correcta.
  // Antes salian como bill_proforma -> ticket identico a boleta -> invalido.
  | 'factura_final'
  | 'nota_credito_final';

export type JobStatus =
  | 'pending'
  | 'printing'
  | 'printed'
  | 'failed'
  | 'cancelled'
  // waiting_printer: el job entro en backoff exponencial porque tuvo un
  // error transient (impresora offline, timeout). next_retry_at apunta a
  // cuando el retry-scheduler debe resetearlo a 'pending'. Si la impresora
  // vuelve antes (auto-recovery via heartbeat), tambien se resetea a pending.
  | 'waiting_printer';

/**
 * Categoria del ultimo error de un job:
 *  - transient: vale la pena reintentar (impresora offline, red, timeout, sin papel).
 *  - permanent: no reintentar (payload invalido, print_area inexistente, RLS).
 */
export type ErrorKind = 'transient' | 'permanent';

export type PrintJobRow = {
  id: string;
  restaurant_id: string;
  location_id: string;
  print_area_id: string | null;
  /**
   * Printer fisica destino, resuelta por la RPC al encolar el job
   * (ver migration 050 bait-pos). Tiene precedencia sobre el lookup
   * historico por print_area_id (primary del area).
   *
   * Si esta NULL, el job es de un schema viejo (pre-050) y el agente
   * cae al flow legacy: matchear por print_area_id → printer is_primary.
   */
  target_printer_id: string | null;
  job_type: JobType;
  payload: Record<string, unknown>;
  order_id: string | null;
  cash_session_id: string | null;
  status: JobStatus;
  attempts: number;
  last_error: string | null;
  // Hora futura en la que el job vuelve a 'pending'. Solo seteado mientras
  // el job esta en status='waiting_printer'.
  next_retry_at: string | null;
  // Clasificacion del ultimo error. NULL si el job nunca fallo o esta sano.
  error_kind: ErrorKind | null;
  printed_at: string | null;
  created_at: string;
  updated_at: string;
};

// ====================================================================
// Payloads concretos por job_type
// ====================================================================

export type KitchenJobItem = {
  name: string;
  quantity: number;
  note: string | null;
  modifiers: Array<{ name: string; priceDelta: number }>;
  /**
   * Cortesia marcada en POS. Opcional para backwards compat con RPCs pre-mig 058.
   * Cuando true, el renderer imprime "★ CORTESÍA" en una linea aparte (si el
   * toggle `showGiftMark` de print_options.kitchen_order esta activo).
   */
  is_gift?: boolean | null;
};

export type KitchenJobPayload = {
  order_id: string;
  order_number?: string | null;
  table_number?: string | null;
  table_display_name?: string | null;
  channel_code: string | null;
  guests: number;
  opened_at: string;
  customer_note: string | null;
  waiter_name?: string | null;
  items: KitchenJobItem[];
  area_name: string | null;
  /**
   * Nombre de la impresora física destino (mig 050+056 lo setea en
   * el payload). El header del ticket usa este valor con preferencia
   * sobre area_name cuando esta presente — en areas con multiples
   * estaciones (ej. "Cocina" con Caliente/Fria/Pasta), el operador
   * necesita saber QUE estación específica recibió la copia.
   * Backwards compat: payloads viejos pre-mig 050 no traen este campo.
   */
  printer_name?: string | null;
  /**
   * Flag emitido por la RPC cuando el job es el consolidado del primary
   * del area (merge de todos los items del area). UI puede mostrar un
   * sello visual "COORDINACION" o similar.
   */
  is_consolidated?: boolean;
  /**
   * Slice del jsonb `restaurants.print_options.kitchen_order` (o kitchen_cancel
   * cuando el job_type=='kitchen_cancel'). Opcional para backwards compat: si
   * llega undefined, el renderer aplica defaults (style='classic', toggles
   * con sus defaults rich del Anexo C del spec).
   */
  print_options?: KitchenOrderOptions | KitchenCancelOptions;
  /**
   * Datos del local. Phase 1 (mig 058) lo agrego al payload de kitchen_order
   * para que el agente pueda renderizar logo/vineta/slogan en comandas (toggles
   * permitidos via print_options.kitchen_order.showLogo, etc en versiones futuras).
   *
   * Pre-mig 058: NULL/undefined. El renderer skipa header con local en ese caso.
   */
  restaurant?: RestaurantPrintInfo;
  /**
   * Mig 060: ancho del papel + identidad de la impresora destino. El renderer
   * lo lee para construir ThermalPrinter con el `width` correcto (32/42/48).
   * NULL/undefined en jobs pre-mig 060 -> fallback a 32 chars.
   */
  printer?: PrinterPayloadInfo;
};

/**
 * Datos del cobro asociados a una boleta final. Todos los sub-campos son
 * opcionales porque el flujo viejo (pre-mig 051) podia emitir bill_proforma
 * antes de capturar el cobro y queremos mantener compatibilidad.
 *
 * - method: identificador interno del medio de pago.
 * - method_label: texto humano que el agente imprime tal cual ("Efectivo",
 *   "Tarjeta MP"). La app web lo arma para no obligar al agente a tener
 *   tablas de traduccion.
 * - mp_last_four / mp_authorization_code: solo aplican cuando method='card_mp'.
 * - received_cash / change: solo aplican cuando method='cash'.
 */
export type BillPaymentInfo = {
  method: string;
  method_label: string;
  mp_last_four?: string | null;
  mp_authorization_code?: string | null;
  received_cash?: number | null;
  change?: number | null;
};

/**
 * Datos de la impresora destino que el agente usa para configurar el
 * ThermalPrinter (width) y para los layouts (separadores que dependen del
 * ancho del papel).
 *
 * Suma mig 060 (bait-pos). Las RPCs enqueue_* incluyen este objeto en el
 * payload top-level cuando hay target_printer_id resuelto. Si NULL (compat
 * con jobs pre-mig 060), el renderer cae al fallback ESCPOS_WIDTH=32.
 *
 *  - id: uuid de printers.id (informativo).
 *  - name: alias humano (informativo en logs).
 *  - width_chars: 32 (Rongta 58mm), 42 (58mm font B), 48 (Epson/Star 80mm).
 *    Default 32 si la RPC no lo trae.
 */
export type PrinterPayloadInfo = {
  id: string;
  name: string;
  width_chars: number;
};

/**
 * Datos del local (header + footer de boletas/precuentas). Los 3 campos
 * print_* vienen de mig 051 y son opcionales — si el restaurante no los
 * configuro, los renderers caen al default ("Gracias por su preferencia").
 *
 * Campos agregados en mig 058 (Phase 1 del feature "Editor de Imprimibles"):
 *  - print_logo_path: path interno en Storage (bucket privado restaurant-logos),
 *    ej '{restaurant_id}/{sha256_first12}-thermal.png'. NULL = sin logo.
 *  - print_logo_hash: sha256 truncado (12 chars) extraido del path, usado por
 *    el cache local del agente (~/.bait-print-agent/cache/logos/{hash}.png).
 *  - print_ornament_char: 1 caracter ASCII 7-bit para vinetas en separadores
 *    (* + - = # o x ~ . :). NULL = separadores planos sin vineta. Pre-mig 063
 *    eran chars CP437 (♥ ♦ ●) pero `node-thermal-printer` los enviaba como
 *    UTF-8 a la termica y salian como `?`. Fix: ASCII puro siempre imprime.
 *  - slogan: max 40 chars, usado por el style 'brand' bajo el nombre del local.
 *
 * v0.9.7: sumado `rut` opcional para que los renderers respeten el toggle
 * showRut. La RPC enqueue_bill_* todavia no envia este campo en el payload —
 * cuando llegue, el agente lo respeta sin cambios adicionales. Ver concern
 * en DONE_WITH_CONCERNS.
 *
 * Todos opcionales para mantener backwards compat con RPCs pre-mig 058.
 */
export type RestaurantPrintInfo = {
  name: string;
  rut?: string | null;
  address?: string | null;
  comuna?: string | null;
  phone?: string | null;
  print_qr_url?: string | null;
  print_qr_label?: string | null;
  print_footer_phrase?: string | null;
  print_logo_path?: string | null;
  print_logo_hash?: string | null;
  print_ornament_char?: string | null;
  slogan?: string | null;
};

/**
 * Item de boleta/precuenta. Mismo shape para bill_preview y bill_proforma.
 */
export type BillItem = {
  name: string;
  quantity: number;
  unit_price: number;
  subtotal: number;
};

/**
 * PRE-CUENTA: snapshot del consumo de la mesa antes de cobrar. No es boleta
 * tributaria. Incluye sugerencia de propina del 10% sobre el total.
 */
export type BillPreviewPayload = {
  order_id: string;
  order_number: number;
  table_number?: string | null;
  guests: number;
  opened_at: string;
  waiter_name?: string | null;
  items: BillItem[];
  subtotal: number;
  iva: number;
  total: number;
  /**
   * Sugerencia de propina (10% sobre total) pre-calculada por la RPC.
   * El agente NO recalcula: imprime tal cual. Si en el futuro la web
   * quiere ofrecer mas tiers (5/10/15%), este shape cambia a array.
   */
  suggested_tip_amount: number;
  total_with_suggested_tip: number;
  restaurant: RestaurantPrintInfo;
  /**
   * Slice del jsonb `restaurants.print_options.bill_preview` (mig 058).
   * Opcional para backwards compat. Defaults aplicados en el renderer.
   */
  print_options?: BillPreviewOptions;
  /**
   * Mig 060: ver KitchenJobPayload.printer.
   */
  printer?: PrinterPayloadInfo;
};

/**
 * BOLETA FINAL (proforma). Mismo shape que bill_preview pero con datos del
 * cobro (metodo + propina cobrada + recibido/vuelto si efectivo).
 */
export type BillProformaPayload = {
  order_id: string;
  order_number: number;
  table_number?: string | null;
  guests: number;
  opened_at: string;
  waiter_name?: string | null;
  items: BillItem[];
  subtotal: number;
  iva: number;
  total: number;
  /**
   * Propina efectivamente cobrada (de orders.tip_amount). 0 si no hubo.
   */
  tip_amount: number;
  /**
   * Datos del cobro. NULL en flows legacy donde la boleta se emite sin
   * cobro registrado todavia (compat con pre-mig 051).
   */
  payment?: BillPaymentInfo | null;
  restaurant: RestaurantPrintInfo;
  /**
   * Slice del jsonb `restaurants.print_options.bill_proforma` (mig 058).
   * Opcional para backwards compat. Defaults aplicados en el renderer.
   */
  print_options?: BillProformaOptions;
  /**
   * Mig 060: ver KitchenJobPayload.printer.
   */
  printer?: PrinterPayloadInfo;
};

/**
 * Datos del receptor de un DTE tributario (factura o NC). Espejo del
 * bloque `receiver` que arman las RPCs enqueue_factura_final /
 * enqueue_nota_credito_final (mig 082 bait-pos).
 *
 * - rut + name son los critic os para la marca legal "FACTURA ELECTRONICA"
 *   con identificacion del receptor. Si solo viene rut, el renderer pone
 *   "Razon social: -" (defensivo).
 * - giro / address / comuna son embellecimiento; si vienen null, se omiten.
 */
export type DteReceiverInfo = {
  rut: string | null;
  name: string | null;
  giro: string | null;
  address: string | null;
  comuna: string | null;
};

/**
 * Snapshot del DTE emitido en el payload del print_job. `folio` puede ser
 * null si la mig RPC armo el payload antes que el provider respondiera —
 * el renderer imprime "FOLIO PENDIENTE" en ese caso (el agente re-leera
 * el job cuando el folio llegue async via /api/internal/dte-retry).
 */
export type DtePrintInfo = {
  type: string | null;
  folio: number | null;
  emitted_at: string | null;
};

/**
 * FACTURA ELECTRÓNICA (33 o 34). Mismo shape que BillProformaPayload + bloque
 * `receiver` + bloque `dte`. La marca legal en el papel es "FACTURA
 * ELECTRÓNICA Nº<folio>" en vez de "BOLETA #<order_number>".
 *
 * El renderer lee `dte.type` para distinguir 33 (factura afecta) vs 34
 * (factura exenta) y ajusta la marca legal correspondiente.
 *
 * Sumado en mig 082 bait-pos (2026-05-23). Antes Carlos cobraba con factura
 * y el ticket salia identico a boleta — invalido como respaldo tributario.
 */
export type FacturaFinalPayload = BillProformaPayload & {
  receiver: DteReceiverInfo;
  dte: DtePrintInfo;
};

/**
 * NOTA DE CRÉDITO (61) post-anulacion de orden ya cobrada con DTE. La marca
 * legal es "NOTA DE CRÉDITO Nº<folio>" + bloque `reference` indicando que
 * folio original anula (boleta o factura).
 *
 * `dte.nc_amount` es el monto efectivamente anulado (puede ser parcial).
 */
export type NotaCreditoFinalPayload = BillProformaPayload & {
  receiver: DteReceiverInfo;
  dte: DtePrintInfo & { nc_amount: number | null };
  reference: {
    original_folio: number | null;
    original_dte_type: string | null;
    reason: string | null;
  };
};

export type CashClosePayload = {
  session_id: string;
  opened_at: string;
  closed_at: string;
  opened_by_name?: string | null;
  closed_by_name?: string | null;
  total_sales: number;
  total_cash: number;
  total_card_mp: number;
  total_card_other: number;
  total_transfer: number;
  total_tips: number;
  total_refunds: number;
  expected_cash: number;
  closing_cash: number;
  difference: number;
  order_count: number;
  notes?: string | null;
  location_name?: string | null;
  /**
   * Datos del local. Phase 1 (mig 058) lo agrego al payload de cash_close para
   * unificar el header con bill_preview/proforma (logo, vineta, slogan).
   *
   * Opcional para backwards compat con cash_close pre-mig 058 (mig 050 no lo
   * tenia). Si viene undefined el renderer construye un header generico.
   */
  restaurant?: RestaurantPrintInfo;
  /**
   * Slice del jsonb `restaurants.print_options.cash_close` (mig 058).
   * Opcional para backwards compat. Defaults aplicados en el renderer.
   */
  print_options?: CashCloseOptions;
  /**
   * Mig 060: ver KitchenJobPayload.printer.
   */
  printer?: PrinterPayloadInfo;
};

// ====================================================================
// Type guards
// ====================================================================

export function isKitchenJobPayload(p: unknown): p is KitchenJobPayload {
  return (
    !!p &&
    typeof p === 'object' &&
    'items' in p &&
    Array.isArray((p as KitchenJobPayload).items) &&
    'order_id' in p
  );
}

export function isBillPreviewPayload(p: unknown): p is BillPreviewPayload {
  return (
    !!p &&
    typeof p === 'object' &&
    'items' in p &&
    Array.isArray((p as BillPreviewPayload).items) &&
    'total' in p &&
    'restaurant' in p &&
    'suggested_tip_amount' in p &&
    'total_with_suggested_tip' in p
  );
}

export function isBillProformaPayload(p: unknown): p is BillProformaPayload {
  return (
    !!p &&
    typeof p === 'object' &&
    'items' in p &&
    Array.isArray((p as BillProformaPayload).items) &&
    'total' in p &&
    'restaurant' in p &&
    // tip_amount es el discriminante vs BillPreviewPayload (que no lo tiene
    // como campo top-level). Si llega un payload pre-mig 051 sin tip_amount,
    // igual cae al render — el guard es laxo a proposito (`in` con number=0
    // o undefined ambos satisfacen). Defensa: el renderer trata tip_amount
    // como `?? 0`.
    !('suggested_tip_amount' in p) &&
    // mig 082: factura_final / nota_credito_final tambien comparten shape
    // base con BillProformaPayload + 'receiver' + 'dte'. El dispatcher
    // ya rutea por job_type, pero este guard lo hacemos exclusivo para
    // evitar que un payload de factura caiga a renderBillProforma si
    // alguna vez el routing falla.
    !('receiver' in p) &&
    !('dte' in p)
  );
}

/**
 * Discriminante exclusivo para factura_final. Requiere los bloques
 * `receiver` y `dte` (mig 082 bait-pos). El renderer toma el shape
 * BillProformaPayload + bloques + marca legal.
 *
 * Si alguno de los dos bloques no viene, cae al fallback ASCII.
 */
export function isFacturaFinalPayload(p: unknown): p is FacturaFinalPayload {
  return (
    !!p &&
    typeof p === 'object' &&
    'items' in p &&
    Array.isArray((p as FacturaFinalPayload).items) &&
    'total' in p &&
    'restaurant' in p &&
    'receiver' in p &&
    'dte' in p &&
    // El receptor puede tener rut=null si el cobro no lo capturo bien,
    // pero el bloque `receiver` igual tiene que estar presente como objeto.
    typeof (p as FacturaFinalPayload).receiver === 'object'
  );
}

/**
 * Discriminante para nota_credito_final. Igual que factura + bloque
 * `reference` al folio anulado.
 */
export function isNotaCreditoFinalPayload(
  p: unknown
): p is NotaCreditoFinalPayload {
  return (
    !!p &&
    typeof p === 'object' &&
    'items' in p &&
    Array.isArray((p as NotaCreditoFinalPayload).items) &&
    'total' in p &&
    'restaurant' in p &&
    'receiver' in p &&
    'dte' in p &&
    'reference' in p &&
    typeof (p as NotaCreditoFinalPayload).reference === 'object'
  );
}

export function isCashClosePayload(p: unknown): p is CashClosePayload {
  return (
    !!p &&
    typeof p === 'object' &&
    'session_id' in p &&
    'total_sales' in p
  );
}
