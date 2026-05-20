import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ChevronRight,
  AlertCircle,
  Loader2,
  RotateCcw,
} from "lucide-react";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { ScrollArea } from "./ui/scroll-area";
import { useToast } from "@/hooks/use-toast";
import { reprintJob, AgentOfflineError } from "@/lib/api";
import { cn, formatTime } from "@/lib/utils";
import {
  jobTypeLabels,
  type JobStatus,
  type PrintJob,
} from "@/lib/mock-data";

interface RecentJobsTabProps {
  jobs: PrintJob[];
  /** Llamado tras un reprint exitoso para refrescar la lista. */
  onReprintSuccess?: () => void;
  isDisconnected?: boolean;
}

const STATUS_VARIANT: Record<
  JobStatus,
  { variant: "success" | "warning" | "destructive" | "muted" | "default"; label: string }
> = {
  printed: { variant: "success", label: "impreso" },
  failed: { variant: "destructive", label: "falló" },
  waiting_printer: { variant: "warning", label: "esperando" },
  printing: { variant: "default", label: "imprimiendo" },
  pending: { variant: "muted", label: "pendiente" },
  cancelled: { variant: "muted", label: "cancelado" },
};

/**
 * Estados desde los cuales el agente permite reimprimir (CAS server-side).
 * Los demas (printing/pending/cancelled) NO ofrecen el boton.
 */
const REPRINTABLE_STATUSES: ReadonlySet<JobStatus> = new Set<JobStatus>([
  "printed",
  "failed",
  "waiting_printer",
]);

export function RecentJobsTab({
  jobs,
  onReprintSuccess,
  isDisconnected,
}: RecentJobsTabProps) {
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <ScrollArea className="h-[calc(540px-176px)] pr-1.5 -mr-1.5 scroll-dark">
      <motion.div
        initial={{ opacity: 0, x: 6 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ duration: 0.25 }}
        className="space-y-1.5 pb-2"
      >
        {jobs.length === 0 ? (
          <p className="text-center text-xs text-muted-foreground italic py-8">
            {isDisconnected
              ? "Sin contacto con el servicio."
              : "Sin jobs en el historial reciente."}
          </p>
        ) : (
          jobs.map((job) => (
            <JobRow
              key={job.id}
              job={job}
              isExpanded={expanded === job.id}
              onToggle={() =>
                setExpanded((prev) => (prev === job.id ? null : job.id))
              }
              onReprintSuccess={onReprintSuccess}
              isDisconnected={isDisconnected}
            />
          ))
        )}
      </motion.div>
    </ScrollArea>
  );
}

function JobRow({
  job,
  isExpanded,
  onToggle,
  onReprintSuccess,
  isDisconnected,
}: {
  job: PrintJob;
  isExpanded: boolean;
  onToggle: () => void;
  onReprintSuccess?: () => void;
  isDisconnected?: boolean;
}) {
  const { variant, label } = STATUS_VARIANT[job.status];
  const isLive = job.status === "printing";
  const canReprint = REPRINTABLE_STATUSES.has(job.status);
  const { toast } = useToast();
  const [reprinting, setReprinting] = useState(false);

  const handleReprint = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (reprinting) return;
    setReprinting(true);
    try {
      await reprintJob(job.id);
      toast({
        title: "Reimpresión solicitada",
        description: `Job ${shortId(job.id)} vuelto a la cola.`,
        variant: "success",
      });
      onReprintSuccess?.();
    } catch (err) {
      const message =
        err instanceof AgentOfflineError
          ? "El servicio no está corriendo."
          : err instanceof Error
            ? err.message
            : "No se pudo reimprimir.";
      toast({
        title: "No se pudo reimprimir",
        description: message,
        variant: "destructive",
      });
    } finally {
      setReprinting(false);
    }
  };

  return (
    <div className="job-item">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-2 px-3 py-2 text-left"
        aria-expanded={isExpanded}
      >
        <Badge variant={variant} className="!py-0.5 min-w-[64px] justify-center">
          {isLive && <Loader2 className="h-2.5 w-2.5 mr-1 animate-spin" />}
          {label}
        </Badge>

        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-1.5">
            <span className="text-[12px] font-semibold text-foreground/95 truncate">
              {job.table_label ?? jobTypeLabels[job.job_type]}
            </span>
            <span className="text-[10px] text-muted-foreground/80">
              · {jobTypeLabels[job.job_type]}
            </span>
          </div>
          <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <span className="font-mono">{formatTime(job.created_at)}</span>
            {job.printer_name && (
              <>
                <span className="opacity-50">·</span>
                <span className="truncate">{job.printer_name}</span>
              </>
            )}
            {job.attempt_count > 1 && (
              <>
                <span className="opacity-50">·</span>
                <span className="text-bait-orange-300">
                  {job.attempt_count} intentos
                </span>
              </>
            )}
          </div>
        </div>

        <motion.span
          animate={{ rotate: isExpanded ? 90 : 0 }}
          transition={{ duration: 0.18 }}
          className="text-muted-foreground/60"
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </motion.span>
      </button>

      <AnimatePresence initial={false}>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: "easeOut" }}
            className="overflow-hidden border-t border-white/[0.07]"
          >
            <div className="px-3 py-2.5 space-y-2 select-text">
              {/* Items */}
              <div>
                <p className="text-[9.5px] uppercase tracking-[0.12em] text-muted-foreground mb-1.5 font-medium">
                  Items
                </p>
                {job.items.length > 0 ? (
                  <ul className="space-y-0.5">
                    {job.items.map((item, idx) => (
                      <li
                        key={idx}
                        className="text-[11.5px] flex items-baseline gap-1.5 text-foreground/85"
                      >
                        <span className="font-mono text-bait-cyan-300 shrink-0">
                          {item.qty}×
                        </span>
                        <span className="flex-1">
                          {item.name}
                          {item.note && (
                            <span className="text-muted-foreground italic">
                              {" "}
                              — {item.note}
                            </span>
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-[11px] text-muted-foreground italic">
                    Sin detalle de items en el payload.
                  </p>
                )}
              </div>

              {/* Error si falló */}
              {job.last_error && (
                <div
                  className={cn(
                    "rounded-md border border-red-500/30 bg-red-500/10 px-2 py-1.5",
                    "flex items-start gap-1.5"
                  )}
                >
                  <AlertCircle className="h-3 w-3 text-red-300 shrink-0 mt-0.5" />
                  <p className="text-[10.5px] text-red-200 font-mono leading-relaxed">
                    {job.last_error}
                  </p>
                </div>
              )}

              {/* Meta + acciones */}
              <div className="grid grid-cols-2 gap-1.5 text-[10px] text-muted-foreground pt-1 border-t border-white/[0.05]">
                <MetaRow label="Job ID" value={job.id} mono />
                <MetaRow label="Área" value={job.area} />
              </div>

              {canReprint && (
                <div className="pt-1.5 flex justify-end">
                  <Button
                    onClick={handleReprint}
                    disabled={reprinting || isDisconnected}
                    variant="secondary"
                    size="sm"
                    className="text-[11px] h-7"
                  >
                    {reprinting ? (
                      <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                    ) : (
                      <RotateCcw className="h-3 w-3 mr-1" />
                    )}
                    Reimprimir
                  </Button>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function MetaRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div>
      <p className="text-[9px] uppercase tracking-[0.1em] opacity-70">
        {label}
      </p>
      <p
        className={cn(
          "text-foreground/80 truncate",
          mono && "font-mono text-[10.5px]"
        )}
      >
        {value}
      </p>
    </div>
  );
}

function shortId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}
