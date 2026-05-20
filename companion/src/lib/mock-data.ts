/**
 * View-models de la UI del companion.
 *
 * Originalmente este archivo tenia mocks. Ahora los datos reales vienen
 * del HTTP server local del agente via `lib/api.ts`. Mantenemos este
 * archivo (en vez de borrarlo) por dos razones:
 *
 *  1. Los componentes (StatusTab, RecentJobsTab, ActionsTab, etc) ya
 *     importan los types desde aca. Cambiar todos los imports a
 *     `./api` haria el diff mas ruidoso; mejor mantenemos la frontera
 *     "tipos que la UI consume" en un archivo separado.
 *  2. La shape que la UI muestra NO es identica a la shape del HTTP
 *     server. Aca exponemos un "view model" mas amigable (por ejemplo
 *     `area: string` derivado del payload, `items: PrintJobItem[]`
 *     extraidos del JSONB del job). Los mappers viven en
 *     `lib/mappers.ts`.
 *
 * Si alguien grep-ea por "mock" va a llegar aca y va a poder seguir el
 * trail al wireup real. No hay datos hardcodeados aca: solo types.
 */

// ----------------------------------------------------------------------
// Status del agente (lo que ve la UI en StatusTab / AppHeader)
// ----------------------------------------------------------------------

/**
 * Estado de salud que la UI pinta en el header:
 *  - online: agente respondiendo + Supabase + Realtime OK
 *  - degraded: agente responde pero supabase o realtime caidos
 *  - offline: agente no respondio (companion en estado "desconectado")
 */
export type AgentStatus = "online" | "degraded" | "offline";

/**
 * Status de una impresora. El HTTP server expone `discovered_printers`
 * (lo que Get-Printer ve en el OS); no expone heartbeats per-printer,
 * asi que clasificamos heuristicamente: si esta en la lista la marcamos
 * `online`, si no hay datos (loading) `unknown`. `offline` queda
 * reservado para cuando agreguemos health-check per-printer en futuro.
 */
export type PrinterStatus = "online" | "offline" | "unknown";

/**
 * Status de un job. Espejo del enum del backend — incluimos `cancelled`
 * porque puede aparecer en `/v1/jobs/recent`. La UI lo mapea a un badge
 * `muted` con texto "cancelado".
 */
export type JobStatus =
  | "pending"
  | "waiting_printer"
  | "printing"
  | "printed"
  | "failed"
  | "cancelled";

/**
 * Tipos de job — los recibimos del backend en el field `job_type`. La UI
 * los renderiza con labels humanos via `jobTypeLabels` (abajo).
 */
export type JobType =
  | "kitchen_order"
  | "bar_order"
  | "kitchen_cancel"
  | "bill_proforma"
  | "sii_receipt"
  | "cash_close";

// ----------------------------------------------------------------------
// View models
// ----------------------------------------------------------------------

/**
 * Impresora tal cual la muestra la UI. Derivado de `DiscoveredPrinter`
 * del HTTP server (mapper en `lib/mappers.ts`).
 */
export interface PrinterInfo {
  /** Para React keys + para el endpoint /printers/:id/test. Usamos `device_id`. */
  id: string;
  /** Nombre tal cual aparece en Windows. */
  name: string;
  /**
   * Texto de area que pintamos como subtitulo. El HTTP server no expone
   * "area" porque las areas viven en Supabase (tabla `print_areas`). Por
   * ahora ponemos el kind (USB/Network/...) ahi para no dejar el campo
   * vacio. Cuando el endpoint exponga area mapeada, lo cambiamos.
   */
  area: string;
  /** Driver/kind crudo (USB/NETWORK/...). Usado como meta visual. */
  driver: string;
  status: PrinterStatus;
  /**
   * Si Windows tiene esta impresora marcada como default. La UI le pone
   * un badge "Principal" — semantica no es 100% la misma que primary del
   * agente pero hasta que tengamos ese dato propio, es lo mas cercano.
   */
  is_primary: boolean;
  last_seen_at: string | null;
}

/**
 * Items renderizados de un job. Para `kitchen_order` y `bar_order` vienen
 * del payload `KitchenJobPayload`; para `bill_proforma` los mapeamos al
 * mismo shape; para `cash_close` mostramos una sola fila resumen.
 */
export interface PrintJobItem {
  name: string;
  qty: number;
  note?: string;
}

/**
 * Job tal cual la UI lo muestra. La shape NO es identica a la del HTTP
 * server (que devuelve `payload: jsonb`) — el mapper se encarga de
 * extraer table_label/area/items del payload.
 */
export interface PrintJob {
  id: string;
  job_type: JobType;
  status: JobStatus;
  /** Derivado del payload o del print_area_id (mapper). */
  area: string;
  /** Derivado del payload (table_number/table_display_name). null si no aplica. */
  table_label: string | null;
  /**
   * Nombre de la impresora a la que se mandó. Por ahora el HTTP server
   * NO expone el nombre de la printer en el payload de recent (solo el
   * print_area_id). Lo dejamos null hasta que el server lo exponga.
   */
  printer_name: string | null;
  created_at: string;
  printed_at: string | null;
  /** Es `attempts` en la shape del server, lo renombramos para mantener compat. */
  attempt_count: number;
  last_error: string | null;
  items: PrintJobItem[];
}

/**
 * Estado del agente que la UI muestra en el StatusTab y AppHeader.
 *
 * Derivado de `AgentStatus` del HTTP server (mapper). Los counters
 * `printed_today` y `failed_today` NO los expone el server hoy — los
 * dejamos como undefined (la UI muestra "—"). Si quisieramos los counts,
 * habria que agregar un endpoint nuevo o calcularlos client-side a
 * partir de `/v1/jobs/recent` (con la limitacion del limit=100).
 */
export interface AgentState {
  agent_id: string;
  agent_version: string;
  location_name: string;
  restaurant_name: string;
  status: AgentStatus;
  supabase_connected: boolean;
  realtime_connected: boolean;
  last_heartbeat_at: string;
  printed_today: number | undefined;
  pending_jobs: number;
  failed_today: number | undefined;
  uptime_seconds: number | undefined;
}

// ----------------------------------------------------------------------
// Labels usados en la UI
// ----------------------------------------------------------------------

export const jobTypeLabels: Record<JobType, string> = {
  kitchen_order: "Cocina",
  bar_order: "Barra",
  kitchen_cancel: "Anulación",
  bill_proforma: "Pre-cuenta",
  sii_receipt: "Boleta SII",
  cash_close: "Cierre",
};
