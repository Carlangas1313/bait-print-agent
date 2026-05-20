import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronRight, AlertCircle, Loader2 } from "lucide-react";
import { Badge } from "./ui/badge";
import { ScrollArea } from "./ui/scroll-area";
import { cn, formatTime } from "@/lib/utils";
import {
  jobTypeLabels,
  type JobStatus,
  type PrintJob,
} from "@/lib/mock-data";

interface RecentJobsTabProps {
  jobs: PrintJob[];
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
};

export function RecentJobsTab({ jobs }: RecentJobsTabProps) {
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
            Sin jobs en el historial reciente.
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
}: {
  job: PrintJob;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const { variant, label } = STATUS_VARIANT[job.status];
  const isLive = job.status === "printing";

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

              {/* Meta */}
              <div className="grid grid-cols-2 gap-1.5 text-[10px] text-muted-foreground pt-1 border-t border-white/[0.05]">
                <MetaRow label="Job ID" value={job.id} mono />
                <MetaRow label="Área" value={job.area} />
              </div>
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
