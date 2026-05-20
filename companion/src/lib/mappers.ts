/**
 * Mappers entre la shape del HTTP server (en `lib/api.ts`) y los
 * view-models que la UI consume (en `lib/mock-data.ts`).
 *
 * Estos viven en un archivo separado porque:
 *  1. La UI no deberia saber nada del shape "crudo" de la API — todos
 *     los caminos a la UI pasan por estos mappers.
 *  2. Cuando agreguemos campos al HTTP server (printer area mapeada,
 *     contadores de "printed_today", etc), solo cambia este archivo.
 *  3. Hace facil testear (input crudo → output esperado).
 */

import type {
  AgentStatus as ApiAgentStatus,
  DiscoveredPrinter,
  PrintJob as ApiPrintJob,
} from "./api";
import type {
  AgentState,
  AgentStatus as ViewStatus,
  JobStatus,
  JobType,
  PrintJob,
  PrintJobItem,
  PrinterInfo,
  PrinterStatus,
} from "./mock-data";

// ----------------------------------------------------------------------
// Status del agente
// ----------------------------------------------------------------------

/**
 * Mapea la respuesta cruda de `/v1/status` al view-model que consume
 * AppHeader + StatusTab.
 *
 * Reglas de derivacion:
 *  - `status`:
 *      online   → supabase_connected && realtime SUBSCRIBED
 *      degraded → cualquiera de los dos falla pero el server respondio
 *      offline  → solo cuando la llamada al server falla (este mapper
 *                 nunca devuelve offline porque ya tenemos un AgentStatus)
 *  - `location_name` / `restaurant_name`: el endpoint solo devuelve IDs
 *    (location_id, restaurant_id). Hasta que un endpoint los expanda a
 *    nombres, mostramos el agent_name como ubicacion.
 *  - `printed_today` / `failed_today`: el server NO los expone hoy. Los
 *    dejamos undefined → la UI pinta "—".
 *  - `pending_jobs`: pending + waiting_printer agrupados, porque la UI
 *    tiene un solo metric card. Si quisieramos mostrarlos separados,
 *    extendemos AgentState con un segundo field.
 */
export function statusToAgentState(api: ApiAgentStatus): AgentState {
  const realtimeOk = api.realtime_status === "SUBSCRIBED";
  const supabaseOk = api.supabase_connected;

  let status: ViewStatus;
  if (supabaseOk && realtimeOk) {
    status = "online";
  } else {
    // El server respondio asi que NO estamos offline desde la perspectiva
    // del companion — pero alguna conexion downstream esta caida.
    status = "degraded";
  }

  return {
    agent_id: api.agent.id,
    agent_version: api.agent.version,
    // El server no devuelve nombre de location/restaurant — usamos el
    // nombre del agente como label. El user lo eligio en el pairing.
    location_name: api.agent.name,
    restaurant_name: api.agent.name,
    status,
    supabase_connected: supabaseOk,
    realtime_connected: realtimeOk,
    last_heartbeat_at: api.last_heartbeat_at ?? new Date(0).toISOString(),
    // null del server = query fallo, UI pinta "—". 0 del server = no hubo
    // jobs hoy, UI pinta "0". `?? undefined` convierte null en undefined
    // para que el `?? "—"` del MetricCard reaccione correcto.
    printed_today: api.printed_today_count ?? undefined,
    pending_jobs: api.jobs_pending_count + api.jobs_waiting_printer_count,
    failed_today: api.failed_today_count ?? undefined,
    uptime_seconds: undefined,
  };
}

// ----------------------------------------------------------------------
// Printers
// ----------------------------------------------------------------------

/**
 * Mapea las printers descubiertas (`Get-Printer` en Windows) al
 * view-model PrinterInfo que la UI muestra.
 *
 * Heuristicas:
 *  - `id`: usamos `device_id` (USB001, IP:puerto, COMn). Es estable
 *    dentro del lifetime del proceso; si el usuario reconecta una
 *    impresora USB el ID puede cambiar (USB001 → USB002), pero eso
 *    rompe igual el endpoint `/printers/:id/test` (que tampoco está
 *    implementado aun).
 *  - `area`: el endpoint NO devuelve la area de Supabase, solo el kind
 *    del port (USB/network/...). Usamos el kind como subtitulo asi el
 *    usuario al menos ve "Cocina Principal · USB" en vez de un blank.
 *  - `status`: como el endpoint devuelve `discovered_printers` solo si
 *    el OS las ve, las marcamos online por default. Si en el futuro
 *    agregamos health-check per-printer, este campo va a venir del
 *    backend.
 *  - `is_primary`: usamos `default` del OS. No es exactamente igual al
 *    `is_primary` del agente (que es por print_area) pero es lo unico
 *    que tenemos hoy.
 *  - `last_seen_at`: tampoco lo expone el server. null por ahora.
 */
export function discoveredPrintersToView(
  printers: DiscoveredPrinter[]
): PrinterInfo[] {
  return printers.map((p) => discoveredPrinterToView(p));
}

function discoveredPrinterToView(p: DiscoveredPrinter): PrinterInfo {
  const kindLabel: Record<DiscoveredPrinter["kind"], string> = {
    usb: "USB",
    network: "Red",
    bluetooth: "Bluetooth",
    unknown: "Desconocido",
  };
  // Status: el endpoint solo nos devuelve printers visibles al OS — las
  // tratamos como online. Si quisieramos un health-check real
  // necesitamos un endpoint nuevo en el server.
  const status: PrinterStatus = "online";
  return {
    id: p.device_id,
    name: p.name,
    area: kindLabel[p.kind] ?? "Desconocido",
    driver: p.device_id,
    status,
    is_primary: p.default,
    last_seen_at: null,
  };
}

// ----------------------------------------------------------------------
// Print jobs
// ----------------------------------------------------------------------

/**
 * Mapea un job crudo de `/v1/jobs/recent` al view-model que muestra
 * RecentJobsTab.
 *
 * El campo `payload` es JSONB y su shape depende de `job_type`. Hacemos
 * un best-effort:
 *  - kitchen_order / bar_order / kitchen_cancel → items[]
 *  - bill_proforma → items + total (mostramos la lista, sin total por ahora)
 *  - cash_close → una unica fila resumen ("Cierre de caja — turno X")
 *  - sii_receipt → fallback ("Boleta SII")
 *
 * Si el payload viene mal (null o sin items), devolvemos lista vacia y
 * la UI lo muestra como "Sin items".
 */
export function jobsToView(jobs: ApiPrintJob[]): PrintJob[] {
  return jobs.map(jobToView);
}

function jobToView(j: ApiPrintJob): PrintJob {
  // Sanitizamos el status: si por algun motivo nos llega algo fuera del
  // enum, lo dejamos en "pending" para no romper el render. El server
  // valida con zod asi que esto no deberia pasar — defensive code.
  const status: JobStatus = isKnownJobStatus(j.status) ? j.status : "pending";

  const { items, table_label } = extractFromPayload(j.payload, j.job_type);

  return {
    id: j.id,
    job_type: j.job_type as JobType,
    status,
    area: areaFromJobType(j.job_type),
    table_label,
    printer_name: null, // server no lo expone — ver comentario en mock-data.ts
    created_at: j.created_at,
    printed_at: j.printed_at,
    attempt_count: j.attempts,
    last_error: j.last_error,
    items,
  };
}

const KNOWN_STATUSES: ReadonlySet<JobStatus> = new Set<JobStatus>([
  "pending",
  "waiting_printer",
  "printing",
  "printed",
  "failed",
  "cancelled",
]);

function isKnownJobStatus(s: string): s is JobStatus {
  return KNOWN_STATUSES.has(s as JobStatus);
}

/**
 * Etiqueta de area derivada del job_type. Hasta que el server exponga
 * el nombre de la print_area, mostramos un texto generico.
 */
function areaFromJobType(jobType: string): string {
  switch (jobType) {
    case "kitchen_order":
    case "kitchen_cancel":
      return "Cocina";
    case "bar_order":
      return "Barra";
    case "bill_proforma":
    case "cash_close":
    case "sii_receipt":
      return "Caja";
    default:
      return "—";
  }
}

interface PayloadExtraction {
  items: PrintJobItem[];
  table_label: string | null;
}

function extractFromPayload(
  payload: Record<string, unknown> | null,
  jobType: string
): PayloadExtraction {
  if (!payload || typeof payload !== "object") {
    return { items: [], table_label: null };
  }

  // table_label: priorizamos display name > table_number > null
  const tableDisplay = getString(payload, "table_display_name");
  const tableNumber = getString(payload, "table_number");
  const table_label =
    tableDisplay ?? (tableNumber ? `Mesa ${tableNumber}` : null);

  // Items: kitchen/bar order y bill_proforma usan shape `items: [...]`.
  // cash_close NO tiene items — fabricamos uno sintetico para que la UI
  // tenga algo que mostrar al expandir el job.
  if (jobType === "cash_close") {
    const total = getNumber(payload, "total_sales");
    const closedAt = getString(payload, "closed_at");
    return {
      items: [
        {
          name: "Cierre de caja",
          qty: 1,
          note: total !== null ? `Total: $${total.toLocaleString("es-CL")}` : closedAt ?? undefined,
        },
      ],
      table_label,
    };
  }

  if (jobType === "sii_receipt") {
    return {
      items: [{ name: "Boleta SII", qty: 1 }],
      table_label,
    };
  }

  const rawItems = (payload as { items?: unknown }).items;
  if (!Array.isArray(rawItems)) {
    return { items: [], table_label };
  }

  const items: PrintJobItem[] = [];
  for (const raw of rawItems) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const name = getString(r, "name");
    if (!name) continue;
    // Kitchen usa `quantity`; bill_proforma tambien. Algunos legacy usan `qty`.
    const qty =
      getNumber(r, "quantity") ?? getNumber(r, "qty") ?? 1;
    const note = getString(r, "note") ?? undefined;
    items.push({ name, qty, note });
  }

  return { items, table_label };
}

function getString(
  obj: Record<string, unknown>,
  key: string
): string | null {
  const v = obj[key];
  if (typeof v === "string" && v.trim().length > 0) return v;
  return null;
}

function getNumber(
  obj: Record<string, unknown>,
  key: string
): number | null {
  const v = obj[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim().length > 0) {
    const n = Number.parseFloat(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}
