/**
 * Mock data — refleja la shape esperada del HTTP server local del agente
 * (`http://127.0.0.1:17891`). Cuando el server real esté listo, lib/api.ts
 * reemplaza estos mocks por fetch().
 */

export type AgentStatus = "online" | "degraded" | "offline";

export type JobStatus =
  | "pending"
  | "waiting_printer"
  | "printing"
  | "printed"
  | "failed";

export type PrinterStatus = "online" | "offline" | "unknown";

export interface PrinterInfo {
  id: string;
  name: string;
  area: string; // "Cocina Principal" | "Barra" | ...
  driver: string; // "HP_OfficeJet" | "EPSON_TM-T20III" | ...
  status: PrinterStatus;
  is_primary: boolean;
  last_seen_at: string | null;
}

export interface PrintJobItem {
  name: string;
  qty: number;
  note?: string;
}

export interface PrintJob {
  id: string;
  job_type:
    | "kitchen_order"
    | "bar_order"
    | "kitchen_cancel"
    | "bill_proforma"
    | "cash_close";
  status: JobStatus;
  area: string;
  table_label: string | null;
  printer_name: string | null;
  created_at: string;
  printed_at: string | null;
  attempt_count: number;
  last_error: string | null;
  items: PrintJobItem[];
}

export interface AgentState {
  agent_id: string;
  agent_version: string;
  location_name: string;
  restaurant_name: string;
  status: AgentStatus;
  supabase_connected: boolean;
  realtime_connected: boolean;
  last_heartbeat_at: string;
  printed_today: number;
  pending_jobs: number;
  failed_today: number;
  uptime_seconds: number;
}

// ---------- Estado del agente ----------

export const mockAgentState: AgentState = {
  agent_id: "00000000-0000-0000-0000-00000000aaaa",
  agent_version: "0.4.2",
  location_name: "La Cocina · Plaza Perú",
  restaurant_name: "La Cocina",
  status: "online",
  supabase_connected: true,
  realtime_connected: true,
  last_heartbeat_at: new Date(Date.now() - 8 * 1000).toISOString(),
  printed_today: 142,
  pending_jobs: 2,
  failed_today: 1,
  uptime_seconds: 3 * 3600 + 24 * 60 + 11,
};

// ---------- Impresoras ----------

export const mockPrinters: PrinterInfo[] = [
  {
    id: "prn-cocina-01",
    name: "Cocina Principal",
    area: "Cocina caliente",
    driver: "HP_OfficeJet",
    status: "online",
    is_primary: true,
    last_seen_at: new Date(Date.now() - 12 * 1000).toISOString(),
  },
  {
    id: "prn-barra-01",
    name: "Barra",
    area: "Barra",
    driver: "EPSON_TM-T20III",
    status: "offline",
    is_primary: false,
    last_seen_at: new Date(Date.now() - 9 * 60 * 1000).toISOString(),
  },
];

// ---------- Jobs recientes (~10 con mix de estados) ----------

const minutesAgo = (n: number) =>
  new Date(Date.now() - n * 60 * 1000).toISOString();

export const mockRecentJobs: PrintJob[] = [
  {
    id: "job-1001",
    job_type: "kitchen_order",
    status: "printed",
    area: "Cocina caliente",
    table_label: "Mesa 4",
    printer_name: "Cocina Principal",
    created_at: minutesAgo(2),
    printed_at: minutesAgo(2),
    attempt_count: 1,
    last_error: null,
    items: [
      { name: "Lomo a lo pobre", qty: 2, note: "Sin huevo" },
      { name: "Ensalada chilena", qty: 1 },
    ],
  },
  {
    id: "job-1002",
    job_type: "bar_order",
    status: "failed",
    area: "Barra",
    table_label: "Mesa 7",
    printer_name: "Barra",
    created_at: minutesAgo(4),
    printed_at: null,
    attempt_count: 3,
    last_error: "Printer no responde (timeout TCP 9100 — 5s)",
    items: [
      { name: "Pisco sour", qty: 3 },
      { name: "Cerveza Kunstmann", qty: 2 },
    ],
  },
  {
    id: "job-1003",
    job_type: "kitchen_order",
    status: "printing",
    area: "Cocina caliente",
    table_label: "Mesa 12",
    printer_name: "Cocina Principal",
    created_at: minutesAgo(0.2),
    printed_at: null,
    attempt_count: 1,
    last_error: null,
    items: [
      { name: "Hamburguesa La Cocina", qty: 1, note: "Sin cebolla" },
      { name: "Papas fritas grandes", qty: 1 },
    ],
  },
  {
    id: "job-1004",
    job_type: "kitchen_cancel",
    status: "printed",
    area: "Cocina caliente",
    table_label: "Mesa 4",
    printer_name: "Cocina Principal",
    created_at: minutesAgo(6),
    printed_at: minutesAgo(6),
    attempt_count: 1,
    last_error: null,
    items: [{ name: "Ensalada chilena", qty: 1, note: "ANULADO" }],
  },
  {
    id: "job-1005",
    job_type: "bill_proforma",
    status: "printed",
    area: "Caja",
    table_label: "Mesa 3",
    printer_name: "Cocina Principal",
    created_at: minutesAgo(8),
    printed_at: minutesAgo(8),
    attempt_count: 1,
    last_error: null,
    items: [
      { name: "Pre-cuenta", qty: 1, note: "$ 38.500" },
    ],
  },
  {
    id: "job-1006",
    job_type: "kitchen_order",
    status: "waiting_printer",
    area: "Cocina caliente",
    table_label: "Mesa 9",
    printer_name: "Cocina Principal",
    created_at: minutesAgo(0.5),
    printed_at: null,
    attempt_count: 0,
    last_error: null,
    items: [
      { name: "Pastel de jaiba", qty: 1 },
      { name: "Empanada de pino", qty: 4 },
    ],
  },
  {
    id: "job-1007",
    job_type: "bar_order",
    status: "pending",
    area: "Barra",
    table_label: "Mesa 11",
    printer_name: "Barra",
    created_at: minutesAgo(0.1),
    printed_at: null,
    attempt_count: 0,
    last_error: null,
    items: [
      { name: "Mojito", qty: 2 },
      { name: "Agua mineral", qty: 1 },
    ],
  },
  {
    id: "job-1008",
    job_type: "kitchen_order",
    status: "printed",
    area: "Cocina caliente",
    table_label: "Mesa 2",
    printer_name: "Cocina Principal",
    created_at: minutesAgo(15),
    printed_at: minutesAgo(15),
    attempt_count: 1,
    last_error: null,
    items: [
      { name: "Caldillo de congrio", qty: 1 },
      { name: "Marraqueta", qty: 2 },
    ],
  },
  {
    id: "job-1009",
    job_type: "cash_close",
    status: "printed",
    area: "Caja",
    table_label: null,
    printer_name: "Cocina Principal",
    created_at: minutesAgo(45),
    printed_at: minutesAgo(45),
    attempt_count: 1,
    last_error: null,
    items: [{ name: "Cierre de caja — turno tarde", qty: 1 }],
  },
  {
    id: "job-1010",
    job_type: "kitchen_order",
    status: "printed",
    area: "Cocina caliente",
    table_label: "Mesa 6",
    printer_name: "Cocina Principal",
    created_at: minutesAgo(70),
    printed_at: minutesAgo(70),
    attempt_count: 2,
    last_error: null,
    items: [
      { name: "Asado de tira", qty: 1, note: "Término medio" },
      { name: "Pure de papas", qty: 1 },
      { name: "Coca-Cola 350ml", qty: 1 },
    ],
  },
];

export const jobTypeLabels: Record<PrintJob["job_type"], string> = {
  kitchen_order: "Cocina",
  bar_order: "Barra",
  kitchen_cancel: "Anulación",
  bill_proforma: "Pre-cuenta",
  cash_close: "Cierre",
};
