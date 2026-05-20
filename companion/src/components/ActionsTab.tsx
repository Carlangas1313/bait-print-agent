import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import {
  Printer,
  RotateCcw,
  ExternalLink,
  ChevronDown,
  ScrollText,
  Loader2,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Button } from "./ui/button";
import { ScrollArea } from "./ui/scroll-area";
import { useToast } from "@/hooks/use-toast";
import {
  refreshQueue,
  testPrint,
  AgentOfflineError,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import type { PrinterInfo } from "@/lib/mock-data";

interface ActionsTabProps {
  printers: PrinterInfo[];
  /** Si no hay contacto con el servicio, deshabilitamos las acciones. */
  isDisconnected?: boolean;
  /**
   * Llamado cuando el refresh-queue del server termino exitoso. La parent
   * lo usa para forzar un re-fetch de status + jobs (asi el contador de
   * "pendientes" se actualiza al instante).
   */
  onQueueRefreshed?: () => void;
}

export function ActionsTab({
  printers,
  isDisconnected,
  onQueueRefreshed,
}: ActionsTabProps) {
  const { toast } = useToast();
  const [printerDropdownOpen, setPrinterDropdownOpen] = useState(false);
  const [selectedPrinter, setSelectedPrinter] = useState<PrinterInfo | null>(
    null
  );

  // Cuando llega la primera lista de printers, pre-seleccionamos la
  // primera (preferir default/primary). Si la lista cambia y la
  // seleccionada desaparecio, caemos a la primera disponible.
  useEffect(() => {
    if (!selectedPrinter && printers.length > 0) {
      const preferred = printers.find((p) => p.is_primary) ?? printers[0];
      setSelectedPrinter(preferred);
      return;
    }
    if (
      selectedPrinter &&
      !printers.some((p) => p.id === selectedPrinter.id)
    ) {
      setSelectedPrinter(printers[0] ?? null);
    }
  }, [printers, selectedPrinter]);

  // -------- Acciones --------

  const [testRunning, setTestRunning] = useState(false);
  const handleTestPrint = async () => {
    if (testRunning) return;
    if (!selectedPrinter) {
      toast({
        title: "Sin impresora",
        description: "No hay impresoras descubiertas en el sistema.",
        variant: "destructive",
      });
      return;
    }
    setTestRunning(true);
    try {
      const result = await testPrint(selectedPrinter.id);
      toast({
        title: "Test enviado",
        description: `→ ${result.printer_name} (${result.connection_type})`,
        variant: "success",
      });
    } catch (err) {
      if (err instanceof AgentOfflineError) {
        toast({
          title: "Servicio no disponible",
          description: "El agente no respondió. Verifica que esté corriendo.",
          variant: "destructive",
        });
      } else {
        // El renderer del agente puede tirar mensajes como "Printer no
        // responde", "Sin papel", "No se puede cargar driver", etc. Los
        // mostramos tal cual — son user-friendly desde el lado del agente.
        toast({
          title: "No se pudo imprimir el test",
          description:
            err instanceof Error ? err.message : "Error desconocido.",
          variant: "destructive",
        });
      }
    } finally {
      setTestRunning(false);
    }
  };

  const [restartRunning, setRestartRunning] = useState(false);
  const handleRestartQueue = async () => {
    if (restartRunning) return;
    setRestartRunning(true);
    try {
      const { processed } = await refreshQueue();
      toast({
        title: "Cola reiniciada",
        description:
          processed > 0
            ? `Se reprocesaron ${processed} job${processed === 1 ? "" : "s"}.`
            : "No había jobs pendientes para reprocesar.",
        variant: "success",
      });
      onQueueRefreshed?.();
    } catch (err) {
      const offline = err instanceof AgentOfflineError;
      toast({
        title: "No se pudo reiniciar la cola",
        description: offline
          ? "El servicio no está corriendo."
          : err instanceof Error
            ? err.message
            : "Error desconocido.",
        variant: "destructive",
      });
    } finally {
      setRestartRunning(false);
    }
  };

  const handleOpenBaitApp = async () => {
    try {
      await openUrl("https://bait-app.cl");
    } catch (e) {
      console.warn("[actions] opener no disponible:", e);
      // Fallback: en Vite puro abrimos en una nueva pestaña.
      window.open("https://bait-app.cl", "_blank");
    }
  };

  const handleViewLogs = async () => {
    // El comando Rust ya resuelve `BAIT_AGENT_HOME` con la misma logica
    // que el menu del tray — desde aca solo lo invocamos.
    try {
      await invoke("open_logs_folder");
    } catch (e) {
      console.warn("[actions] no pude abrir logs:", e);
      toast({
        title: "No se pudieron abrir los logs",
        description:
          "Abre manualmente la carpeta %USERPROFILE%\\.bait-print-agent\\logs",
        variant: "warning",
      });
    }
  };

  const actionsDisabled = !!isDisconnected;

  return (
    <ScrollArea className="h-[calc(540px-176px)] pr-1.5 -mr-1.5 scroll-dark">
      <motion.div
        initial={{ opacity: 0, x: 6 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ duration: 0.25 }}
        className="space-y-2.5 pb-2"
      >
        {/* ---------- Test de impresión ---------- */}
        <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3 space-y-2.5">
          <div className="flex items-start gap-2.5">
            <div className="flex items-center justify-center h-8 w-8 rounded-lg bg-bait-cyan-500/15 border border-bait-cyan-500/30 text-bait-cyan-300 shrink-0 mt-0.5">
              <Printer className="h-4 w-4" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[12.5px] font-semibold font-display">
                Test de impresión
              </p>
              <p className="text-[10.5px] text-muted-foreground">
                Manda un ticket de prueba a la impresora elegida.
              </p>
            </div>
          </div>

          {/* Dropdown de impresoras (vanilla, no Select de shadcn — más liviano) */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setPrinterDropdownOpen((v) => !v)}
              disabled={printers.length === 0}
              className={cn(
                "w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-md",
                "border border-white/15 bg-white/[0.04] hover:bg-white/[0.07] transition-colors text-[11.5px]",
                "disabled:opacity-50 disabled:cursor-not-allowed"
              )}
            >
              <span className="truncate text-foreground/90">
                {selectedPrinter
                  ? selectedPrinter.name
                  : printers.length === 0
                    ? "Sin impresoras descubiertas"
                    : "Elegir impresora"}
              </span>
              <ChevronDown
                className={cn(
                  "h-3 w-3 text-muted-foreground transition-transform shrink-0",
                  printerDropdownOpen && "rotate-180"
                )}
              />
            </button>
            {printerDropdownOpen && printers.length > 0 && (
              <motion.ul
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.15 }}
                className={cn(
                  "absolute z-20 top-[calc(100%+4px)] left-0 right-0",
                  "rounded-md border border-white/15 bg-bait-navy-700/95 backdrop-blur",
                  "shadow-xl overflow-hidden"
                )}
              >
                {printers.map((p) => (
                  <li key={p.id}>
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedPrinter(p);
                        setPrinterDropdownOpen(false);
                      }}
                      className={cn(
                        "w-full text-left px-2.5 py-1.5 text-[11.5px] flex items-center justify-between gap-2",
                        "hover:bg-bait-cyan-500/15 transition-colors",
                        selectedPrinter?.id === p.id && "bg-bait-cyan-500/10"
                      )}
                    >
                      <span className="truncate">{p.name}</span>
                      <span
                        className={cn(
                          "text-[9px] font-medium uppercase tracking-wide",
                          p.status === "online"
                            ? "text-emerald-300"
                            : "text-red-300"
                        )}
                      >
                        {p.status}
                      </span>
                    </button>
                  </li>
                ))}
              </motion.ul>
            )}
          </div>

          <Button
            onClick={handleTestPrint}
            variant="default"
            className="w-full"
            disabled={
              actionsDisabled || testRunning || !selectedPrinter
            }
          >
            {testRunning ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Printer className="h-3.5 w-3.5" />
            )}
            Imprimir test
          </Button>
        </div>

        {/* ---------- Cola ---------- */}
        <ActionCard
          icon={
            restartRunning ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RotateCcw className="h-4 w-4" />
            )
          }
          title="Reiniciar cola"
          description="Hace un backfill de jobs pendientes en Supabase."
          onClick={handleRestartQueue}
          buttonLabel={restartRunning ? "Reiniciando..." : "Reiniciar"}
          variant="secondary"
          disabled={actionsDisabled || restartRunning}
        />

        {/* ---------- Quick links ---------- */}
        <div className="grid grid-cols-2 gap-2">
          <QuickLink
            icon={<ExternalLink className="h-3.5 w-3.5" />}
            label="bait-app.cl"
            onClick={handleOpenBaitApp}
          />
          <QuickLink
            icon={<ScrollText className="h-3.5 w-3.5" />}
            label="Ver logs"
            onClick={handleViewLogs}
          />
        </div>
      </motion.div>
    </ScrollArea>
  );
}

function ActionCard({
  icon,
  title,
  description,
  onClick,
  buttonLabel,
  variant = "secondary",
  tone,
  disabled,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  onClick: () => void;
  buttonLabel: string;
  variant?: "default" | "secondary";
  tone?: "warning";
  disabled?: boolean;
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3 flex items-start gap-2.5">
      <div
        className={cn(
          "flex items-center justify-center h-8 w-8 rounded-lg border shrink-0",
          tone === "warning"
            ? "bg-bait-orange-500/15 border-bait-orange-500/30 text-bait-orange-300"
            : "bg-white/[0.06] border-white/10 text-foreground/80"
        )}
      >
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-[12.5px] font-semibold font-display">{title}</p>
        <p className="text-[10.5px] text-muted-foreground leading-relaxed mb-1.5">
          {description}
        </p>
        <Button
          onClick={onClick}
          variant={variant}
          size="sm"
          className="text-[11px] h-7"
          disabled={disabled}
        >
          {buttonLabel}
        </Button>
      </div>
    </div>
  );
}

function QuickLink({
  icon,
  label,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-lg border border-white/10 bg-white/[0.03]",
        "px-3 py-2.5 flex items-center gap-2 text-[11.5px] font-medium text-foreground/85",
        "hover:bg-white/[0.06] hover:border-white/20 transition-colors"
      )}
    >
      <span className="text-bait-cyan-300">{icon}</span>
      <span>{label}</span>
    </button>
  );
}
