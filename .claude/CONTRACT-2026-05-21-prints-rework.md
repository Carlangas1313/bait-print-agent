# Contract: Prints UX Rework (2026-05-21)

Este doc define los SHAPES exactos de payload + UI flow para los 3 paquetes
que se trabajan en paralelo. Cualquier cambio en uno requiere sync con los
otros dos.

## Cambios funcionales

1. **"Pedir cuenta" imprime PRE-CUENTA** (no espera al pago).
   - Sugerencia de propina 10% sobre subtotal+IVA.
   - Marca clara "NO es boleta oficial".

2. **"Cobrar" imprime BOLETA FINAL** (despues del pago).
   - Incluye metodo de pago, propina cobrada, monto recibido (si efectivo),
     vuelto.
   - Reemplaza el bill_proforma actual.

3. **Comanda muestra comensales** + total items destacado.

4. **Nombre del mozo** en lugar del email cuando full_name esta vacio:
   fallback `full_name ?? email.split('@')[0] ?? '—'`.
   UI: warning en /settings/users si full_name vacio + form para editarlo.

5. **Estetica diferenciada**: header con doble altura, total en XL, QR
   configurable (link libre del restaurant), frase de footer custom.

---

## Schema (Migration 051)

```sql
ALTER TABLE public.restaurants
  ADD COLUMN IF NOT EXISTS print_qr_url text NULL,
  ADD COLUMN IF NOT EXISTS print_qr_label text NULL,
  ADD COLUMN IF NOT EXISTS print_footer_phrase text NULL;

COMMENT ON COLUMN public.restaurants.print_qr_url IS
  'URL completa (https://...) para QR opcional en boletas. NULL = sin QR.';
COMMENT ON COLUMN public.restaurants.print_qr_label IS
  'Label corto sobre/bajo el QR. Ej: "Siguenos en IG", "Pedi delivery", "Resena". Max ~25 chars.';
COMMENT ON COLUMN public.restaurants.print_footer_phrase IS
  'Frase custom al pie de boletas/precuentas. Reemplaza el default "Gracias por su preferencia". Max ~80 chars.';
```

**Nuevo enum value (chequear si ya existe `bill_preview`):**

`print_jobs.job_type` debe aceptar `'bill_preview'`. Si es enum,
agregar valor; si es text con CHECK, agregar.

---

## RPCs

### `enqueue_bill_preview(p_order_id uuid) RETURNS uuid`

Idempotencia: re-llamar dentro de los ultimos 60s sobre el mismo order
devuelve el job_id existente sin crear uno nuevo (evita doble print por
doble click). Despues de 60s SI permite re-imprimir (el mozo borro el
papel anterior o el cliente cambio comensal).

Resolucion target_printer_id: misma que bill_proforma — primary "sin
area" del location (Principal).

Payload shape: ver `BillPreviewPayload` mas abajo.

### `enqueue_bill_proforma(p_order_id uuid, p_payment_method text, p_received_cash int, p_change int)` 

Extender la signature de mig 050. Mantener compat: si los nuevos args
vienen NULL, comportarse como antes. `tip_amount` se lee de `orders.tip_amount`
(no hace falta pasarlo, ya esta en la fila).

Payload: ver `BillProformaPayload` extendido mas abajo.

### Resto (`enqueue_kitchen_jobs`, `enqueue_kitchen_cancel`, `enqueue_cash_close`)

Sin cambios de signature. Solo asegurarse que en `enqueue_kitchen_jobs`
el payload `guests` ya esta (deberia, segun mig 050).

---

## Payload shapes (TypeScript)

### `BillPreviewPayload` (NUEVO)

```ts
type BillPreviewPayload = {
  order_id: string;
  order_number: number;      // de orders.order_number
  table_number?: string | null;
  guests: number;
  opened_at: string;          // ISO
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
  // NUEVO: sugerencia de propina (10% sobre total). El agent NO recalcula,
  // toma este valor para el render. Si la app web quiere ofrecer otras
  // sugerencias en el futuro, cambia esto a un array.
  suggested_tip_amount: number;
  total_with_suggested_tip: number;
  restaurant: {
    name: string;
    address?: string | null;
    comuna?: string | null;
    phone?: string | null;
    print_qr_url?: string | null;
    print_qr_label?: string | null;
    print_footer_phrase?: string | null;
  };
};
```

### `BillProformaPayload` (EXTENDIDO)

Mismo shape de mig 050 + estos campos NUEVOS opcionales:

```ts
type BillProformaPayload = {
  // ... (todo lo que ya tenia)
  order_number: number;            // NUEVO (de orders.order_number)
  // Datos del pago (todos opcionales — bill_proforma puede emitirse antes
  // de tener el cobro registrado en algunos flows legacy):
  payment?: {
    method: string;                // 'cash' | 'card_mp' | 'card_other' | 'transfer'
    method_label: string;          // Texto humano: "Tarjeta MP", "Efectivo"
    mp_last_four?: string | null;  // Solo si method='card_mp'
    mp_authorization_code?: string | null;
    received_cash?: number | null; // Solo si method='cash'
    change?: number | null;        // received_cash - total - tip
  } | null;
  tip_amount: number;              // De orders.tip_amount (0 si no hay)
  restaurant: {
    name: string;
    address?: string | null;
    comuna?: string | null;
    phone?: string | null;
    print_qr_url?: string | null;       // NUEVO
    print_qr_label?: string | null;     // NUEVO
    print_footer_phrase?: string | null; // NUEVO
  };
};
```

### `KitchenJobPayload` (sin cambios — `guests` ya esta)

El renderer del agente ahora SI lo va a usar (antes lo ignoraba).

---

## UI Web (/pos)

### "Pedir cuenta" en OrderView

Hoy: `requestBill()` → cambia status a `to_pay`, sin imprimir.

Nuevo: `requestBill()` → cambia status + dispara `enqueueBillPreview(orderId)`.
Surface `printError` en toast como warning si falla.

### PaymentFlow al cobrar

`closeOrder()` ya llama `enqueueBillProforma`. Cambiar a llamada nueva:

```ts
await enqueueBillProforma(orderId, {
  paymentMethod: 'cash' | 'card_mp' | 'card_other' | 'transfer',
  receivedCash: number | null,   // null si no es cash
  change: number | null,
});
```

`tip_amount` ya queda persistido en `orders.tip_amount` antes de
llamar — la RPC lo lee de ahi.

### /settings/users — UI editar full_name

Listar usuarios. Si `full_name` esta vacio o es el email literal, mostrar
warning amarillo "Falta nombre del usuario - aparecera el email en las
boletas". Click → editor inline.

### /settings/restaurant (o donde corresponda)

Tab nuevo "Impresion" con 3 campos:
- "URL del QR" (URL completa, opcional)
- "Texto sobre el QR" (max 25 chars, ej "Seguinos en IG")
- "Frase al pie" (textarea max 80 chars, default "Gracias por su preferencia!")

---

## Agent renderer (escpos directo)

Refactor: nuevo modulo `src/renderer/escpos-layouts.ts` con funciones que
reciben `(tp: ThermalPrinter, payload, restaurant)` y emiten directamente
los comandos ESC/POS. Reemplaza la generacion de strings ASCII +
iteracion `tp.println` que hace hoy `usb.ts`.

Funciones a exponer:
- `renderKitchenOrderEscPos(tp, payload)` — comanda mejorada (comensales + total items destacado)
- `renderKitchenCancelEscPos(tp, payload)` — sin cambios funcionales, solo estetica
- `renderBillPreviewEscPos(tp, payload)` — NUEVO (precuenta con propina sugerida)
- `renderBillProformaEscPos(tp, payload)` — boleta final con metodo de pago/vuelto
- `renderCashCloseEscPos(tp, payload)` — sin cambios funcionales, solo estetica

Tecnicas ESC/POS a usar:
- `tp.alignCenter()` / `tp.alignLeft()` (nativo, no usamos padCenter)
- `tp.setTextDoubleHeight()` / `tp.setTextDoubleWidth()` para titles
- `tp.setTextSize(w, h)` con (2,2) para TOTAL
- `tp.bold(true/false)` en lineas clave
- `tp.invert(true/false)` para badges tipo " PRE-CUENTA " (texto blanco sobre fondo negro)
- `tp.drawLine()` o el separador de '=' actual
- `tp.printQR(url, options)` si `print_qr_url` no nulo

`usb.ts` switchea por job_type y llama la funcion apropiada en lugar del
`formatJob()` actual. `console.ts`/`virtual.ts` quedan como fallback de
debug — pueden seguir usando strings ASCII (menos importante).

Types a actualizar en `src/types.ts`:
- Agregar `'bill_preview'` a `JobType`
- Agregar `BillPreviewPayload` con type guard `isBillPreviewPayload`
- Extender `BillProformaPayload` con `payment` + `tip_amount` + `order_number`

---

## Coordinacion entre agentes

Cada paquete trabaja en su capa pero TODOS dependen del contract de payloads
de aca arriba. Si un agente necesita cambiar un shape, abrir issue (mencion
en este doc) y resync.

Orden de integracion sugerido:
1. Agente A (migration 051 + RPCs) primero porque define el contract de DB.
2. Agentes B y C en paralelo despues — leen este contract para sus shapes.
3. Integracion final: B y C se mergean juntos para que el flow end-to-end
   funcione.
