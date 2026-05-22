/**
 * Shape de `print_options` jsonb que las RPCs `enqueue_*` de bait-pos embeben
 * en el payload (Phase 1 del feature "Editor de Imprimibles", mig 058).
 *
 * Espejo del archivo `packages/shared/src/print-options.ts` del repo bait-pos.
 * Cuando Phase 2 (web side) cree ese paquete compartido, este archivo queda
 * como fallback local del agente y debe mantenerse en sincro.
 *
 * **Backwards compat (D8 del spec)**: todos los campos son opcionales en el
 * payload. Si el campo no viene (agente recibe payload de RPC vieja), el
 * renderer usa el default que aparece como comentario al lado del field.
 */

export type PrintStyle = 'classic' | 'minimal' | 'brand' | 'thermal_pro';
export type PrintDensity = 'compact' | 'normal' | 'spacious';

/**
 * Toggles compartidos por bill_preview y bill_proforma. Ambos heredan style +
 * showLogo + showAddress + showRut + showQr + density. La proforma agrega
 * cosas especificas del payment en el renderer (no en options).
 */
export type BillSharedOptions = {
  style?: PrintStyle;          // default 'classic'
  showLogo?: boolean;          // default true (depende de print_logo_path)
  showAddress?: boolean;       // default true
  showRut?: boolean;           // default false en bill_preview, true en bill_proforma
  showQr?: boolean;            // default true (si print_qr_url seteado)
  density?: PrintDensity;      // default 'normal'
};

export type BillPreviewOptions = BillSharedOptions;
export type BillProformaOptions = BillSharedOptions;

/**
 * Toggles para kitchen_order. NO tiene "style" porque Carlos decidio que la
 * comanda se queda en classic — son tickets operacionales, no de marca.
 */
export type KitchenOrderOptions = {
  style?: PrintStyle;            // default 'classic'
  showOpenTime?: boolean;        // default true — "Hace X min" en el header
  showHighlightedNotes?: boolean; // default true — notas en invertido + bold
  showGiftMark?: boolean;        // default true — items is_gift con "★ CORTESÍA"
  showPrices?: boolean;          // default false — generalmente OFF para cocina
  showWaiter?: boolean;          // default true — nombre del mesero en header
  showGuests?: boolean;          // default true — N comensales en header
  density?: PrintDensity;        // default 'normal'
};

export type KitchenCancelOptions = {
  style?: PrintStyle;            // default 'classic'
  showReason?: boolean;          // default true — motivo de anulacion (customer_note)
  showWaiter?: boolean;          // default true
  density?: PrintDensity;        // default 'compact'
};

export type CashCloseOptions = {
  style?: PrintStyle;            // default 'classic'
  showHighlightedDiff?: boolean;     // default true — DIFERENCIA en bold/destacada
  showMethodBreakdown?: boolean;     // default true — desglose efectivo/tarjeta/transfer
  density?: PrintDensity;            // default 'normal'
};

/**
 * Union helper: el renderer no necesita esta forma pero ayuda a tipear los
 * helpers que reciben "cualquier print_options" para leer `style` o `density`.
 */
export type AnyPrintOptions =
  | BillPreviewOptions
  | BillProformaOptions
  | KitchenOrderOptions
  | KitchenCancelOptions
  | CashCloseOptions;
