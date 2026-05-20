import { motion } from "framer-motion";
import {
  CheckCircle2,
  Database,
  Radio,
  Printer as PrinterIcon,
  Clock,
  AlertTriangle,
} from "lucide-react";
import { StatusDot } from "./StatusDot";
import { Badge } from "./ui/badge";
import { ScrollArea } from "./ui/scroll-area";
import { cn, formatRelative } from "@/lib/utils";
import type { AgentState, PrinterInfo } from "@/lib/mock-data";

interface StatusTabProps {
  state: AgentState | null;
  printers: PrinterInfo[];
  /** Primera carga aun no termino — la UI muestra "—" en counters. */
  isLoading?: boolean;
  /** El primer fetch fallo (agente apagado o config rota). */
  isDisconnected?: boolean;
  /** Mensaje user-friendly del ultimo error. Lo mostramos en un banner. */
  errorMessage?: string | null;
}

export function StatusTab({
  state,
  printers,
  isDisconnected,
  errorMessage,
}: StatusTabProps) {
  const printedToday = state?.printed_today;
  const failedToday = state?.failed_today;
  const pendingJobs = state?.pending_jobs ?? 0;
  return (
    <ScrollArea className="h-[calc(540px-176px)] pr-1.5 -mr-1.5 scroll-dark">
      <motion.div
        initial={{ opacity: 0, x: 6 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ duration: 0.25 }}
        className="space-y-2.5 pb-2"
      >
        {/* ---------- Banner desconectado ---------- */}
        {isDisconnected && (
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-2.5 py-2 flex items-start gap-1.5">
            <AlertTriangle className="h-3.5 w-3.5 text-red-300 shrink-0 mt-px" />
            <div className="min-w-0 flex-1">
              <p className="text-[11.5px] font-semibold text-red-200">
                No hay contacto con el servicio
              </p>
              <p className="text-[10.5px] text-red-300/80 leading-relaxed truncate">
                {errorMessage ?? "El agente no respondió. Reintentando..."}
              </p>
            </div>
          </div>
        )}

        {/* ---------- Metrics row ---------- */}
        <div className="grid grid-cols-3 gap-2">
          <MetricCard
            label="Impresos hoy"
            value={printedToday ?? "—"}
            tone="cyan"
          />
          <MetricCard
            label="Pendientes"
            value={state ? pendingJobs : "—"}
            tone={state && pendingJobs > 0 ? "warn" : "neutral"}
          />
          <MetricCard
            label="Fallidos"
            value={failedToday ?? "—"}
            tone={
              state && failedToday !== undefined && failedToday > 0
                ? "danger"
                : "neutral"
            }
          />
        </div>

        {/* ---------- Conexiones ---------- */}
        <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3 space-y-2">
          <p className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground font-medium">
            Conexiones
          </p>
          <ConnRow
            icon={<Database className="h-3.5 w-3.5" />}
            label="Supabase"
            ok={state?.supabase_connected}
          />
          <ConnRow
            icon={<Radio className="h-3.5 w-3.5" />}
            label="Realtime"
            ok={state?.realtime_connected}
          />
          <ConnRow
            icon={<Clock className="h-3.5 w-3.5" />}
            label="Último heartbeat"
            text={
              state
                ? formatRelative(state.last_heartbeat_at)
                : "—"
            }
          />
        </div>

        {/* ---------- Impresoras ---------- */}
        <div className="space-y-1.5">
          <p className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground font-medium px-1">
            Impresoras ({printers.length})
          </p>
          {printers.map((p) => (
            <PrinterRow key={p.id} printer={p} />
          ))}
          {printers.length === 0 && (
            <p className="text-xs text-muted-foreground italic px-1 py-2">
              No hay impresoras configuradas.
            </p>
          )}
        </div>
      </motion.div>
    </ScrollArea>
  );
}

function MetricCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  tone: "cyan" | "warn" | "danger" | "neutral";
}) {
  const toneClasses = {
    cyan: "text-bait-cyan-300",
    warn: "text-bait-orange-300",
    danger: "text-red-300",
    neutral: "text-foreground",
  };
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] px-2.5 py-2.5 text-center">
      <p
        className={cn(
          "font-display text-xl font-bold leading-tight",
          toneClasses[tone]
        )}
      >
        {value}
      </p>
      <p className="text-[9px] uppercase tracking-[0.1em] text-muted-foreground mt-0.5">
        {label}
      </p>
    </div>
  );
}

function ConnRow({
  icon,
  label,
  ok,
  text,
}: {
  icon: React.ReactNode;
  label: string;
  ok?: boolean;
  text?: string;
}) {
  const showOk = ok !== undefined;
  return (
    <div className="flex items-center justify-between text-[11.5px]">
      <div className="flex items-center gap-2 text-foreground/80">
        <span className="text-muted-foreground">{icon}</span>
        <span>{label}</span>
      </div>
      {showOk ? (
        <div className="flex items-center gap-1.5">
          {ok ? (
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
          ) : (
            <AlertTriangle className="h-3.5 w-3.5 text-red-400" />
          )}
          <span
            className={cn(
              "text-[10.5px] font-medium",
              ok ? "text-emerald-300" : "text-red-300"
            )}
          >
            {ok ? "conectado" : "caído"}
          </span>
        </div>
      ) : (
        <span className="text-[10.5px] text-muted-foreground font-mono">
          {text}
        </span>
      )}
    </div>
  );
}

function PrinterRow({ printer }: { printer: PrinterInfo }) {
  return (
    <div className="printer-card">
      <div className="flex items-start gap-2.5">
        <div
          className={cn(
            "shrink-0 mt-0.5 flex items-center justify-center h-7 w-7 rounded-md border",
            printer.status === "online"
              ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-300"
              : "border-red-500/30 bg-red-500/10 text-red-300"
          )}
        >
          <PrinterIcon className="h-3.5 w-3.5" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <p className="text-[12.5px] font-semibold text-foreground/95 truncate">
              {printer.name}
            </p>
            {printer.is_primary && (
              <Badge variant="muted" className="!py-0 !text-[8.5px]">
                Principal
              </Badge>
            )}
          </div>
          <p className="text-[10.5px] text-muted-foreground font-mono truncate">
            {printer.driver} · {printer.area}
          </p>
        </div>
        <StatusDot
          status={printer.status === "online" ? "active" : "offline"}
          size="sm"
        />
      </div>
    </div>
  );
}
