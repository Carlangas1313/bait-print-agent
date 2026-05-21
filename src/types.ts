/**
 * Tipos compartidos del agente.
 *
 * Espejo de los tipos del repo bait-pos (apps/web/lib/actions/print-jobs.ts).
 * Si esos cambian, hay que mantener este archivo sincronizado.
 */

export type JobType =
  | 'kitchen_order'
  | 'bar_order'
  | 'bill_preview'
  | 'bill_proforma'
  | 'sii_receipt'
  | 'cash_close'
  | 'kitchen_cancel';

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
 * Datos del local (header + footer de boletas/precuentas). Los 3 campos
 * print_* vienen de mig 051 y son opcionales — si el restaurante no los
 * configuro, los renderers caen al default ("Gracias por su preferencia").
 */
export type RestaurantPrintInfo = {
  name: string;
  address?: string | null;
  comuna?: string | null;
  phone?: string | null;
  print_qr_url?: string | null;
  print_qr_label?: string | null;
  print_footer_phrase?: string | null;
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
    !('suggested_tip_amount' in p)
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
