/**
 * Tipos compartidos del agente.
 *
 * Espejo de los tipos del repo bait-pos (apps/web/lib/actions/print-jobs.ts).
 * Si esos cambian, hay que mantener este archivo sincronizado.
 */

export type JobType =
  | 'kitchen_order'
  | 'bar_order'
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

export type BillProformaPayload = {
  order_id: string;
  table_number?: string | null;
  guests: number;
  opened_at: string;
  waiter_name?: string | null;
  items: Array<{
    name: string;
    quantity: number;
    unit_price: number;
    subtotal: number;
  }>;
  subtotal: number;
  iva: number;
  total: number;
  restaurant: {
    name: string;
    address?: string | null;
    comuna?: string | null;
    phone?: string | null;
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

export function isBillProformaPayload(p: unknown): p is BillProformaPayload {
  return (
    !!p &&
    typeof p === 'object' &&
    'items' in p &&
    Array.isArray((p as BillProformaPayload).items) &&
    'total' in p &&
    'restaurant' in p
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
