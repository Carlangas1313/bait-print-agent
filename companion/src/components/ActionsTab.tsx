import { useState } from "react";
import { motion } from "framer-motion";
import {
  Printer,
  RotateCcw,
  KeyRound,
  ExternalLink,
  ChevronDown,
  ScrollText,
} from "lucide-react";
import { Button } from "./ui/button";
import { ScrollArea } from "./ui/scroll-area";
import { useToast } from "@/hooks/use-toast";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { PrinterInfo } from "@/lib/mock-data";

interface ActionsTabProps {
  printers: PrinterInfo[];
}

export function ActionsTab({ printers }: ActionsTabProps) {
  const { toast } = useToast();
  const [printerDropdownOpen, setPrinterDropdownOpen] = useState(false);
  const [selectedPrinter, setSelectedPrinter] = useState<PrinterInfo | null>(
    printers[0] ?? null
  );

  const pendingToast = (action: string) =>
    toast({
      title: "Funcionalidad pendiente",
      description: `Espera el wireup al HTTP server para ${action}.`,
      variant: "warning",
    });

  const handleTestPrint = async () => {
    if (!selectedPrinter) {
      toast({
        title: "Sin impresora",
        description: "Configurá al menos una impresora antes de probar.",
        variant: "destructive",
      });
      return;
    }
    const res = await api.testPrint(selectedPrinter.id);
    if (res.ok) {
      toast({
        title: "Test enviado",
        description: `→ ${selectedPrinter.name}`,
        variant: "success",
      });
    }
    pendingToast(`imprimir test real en ${selectedPrinter.name}`);
  };

  const handleRestartQueue = async () => {
    await api.restartQueue();
    pendingToast("reiniciar la cola");
  };

  const handleResetPairing = async () => {
    await api.resetPairing();
    pendingToast("regenerar código de pairing");
  };

  const handleOpenBaitApp = () => {
    // TODO: usar @tauri-apps/plugin-opener cuando esté wireup-eado al servicio
    console.log("[actions] abrir https://bait-app.cl");
    pendingToast("abrir bait-app.cl desde el host nativo");
  };

  const handleViewLogs = () => {
    console.log("[actions] ver logs");
    pendingToast("abrir la carpeta de logs");
  };

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
              className={cn(
                "w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-md",
                "border border-white/15 bg-white/[0.04] hover:bg-white/[0.07] transition-colors text-[11.5px]"
              )}
            >
              <span className="truncate text-foreground/90">
                {selectedPrinter ? selectedPrinter.name : "Elegir impresora"}
              </span>
              <ChevronDown
                className={cn(
                  "h-3 w-3 text-muted-foreground transition-transform shrink-0",
                  printerDropdownOpen && "rotate-180"
                )}
              />
            </button>
            {printerDropdownOpen && (
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

          <Button onClick={handleTestPrint} variant="default" className="w-full">
            <Printer className="h-3.5 w-3.5" />
            Imprimir test
          </Button>
        </div>

        {/* ---------- Cola ---------- */}
        <ActionCard
          icon={<RotateCcw className="h-4 w-4" />}
          title="Reiniciar cola"
          description="Limpia jobs colgados y vuelve a engancharse al realtime."
          onClick={handleRestartQueue}
          buttonLabel="Reiniciar"
          variant="secondary"
        />

        {/* ---------- Pairing ---------- */}
        <ActionCard
          icon={<KeyRound className="h-4 w-4" />}
          title="Reconfigurar pairing"
          description="Pide un código nuevo en bait-app.cl y vincula esta PC otra vez."
          onClick={handleResetPairing}
          buttonLabel="Regenerar"
          variant="secondary"
          tone="warning"
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
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  onClick: () => void;
  buttonLabel: string;
  variant?: "default" | "secondary";
  tone?: "warning";
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
