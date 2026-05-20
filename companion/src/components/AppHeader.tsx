import { motion } from "framer-motion";
import { Minus, X } from "lucide-react";
import { StatusDot } from "./StatusDot";
import { Button } from "./ui/button";
import { cn } from "@/lib/utils";
import type { AgentState } from "@/lib/mock-data";

interface AppHeaderProps {
  state: AgentState | null;
  onHide: () => void;
  onExit: () => void;
  /**
   * Si el companion no logro contactar al agente. Forza el dot rojo y el
   * label "DESCONECTADO" en mayuscula chica — vale mas que el status
   * derivado del state (que puede ser stale).
   */
  isDisconnected?: boolean;
}

export function AppHeader({ state, onHide, onExit, isDisconnected }: AppHeaderProps) {
  // Cuando estamos en disconnected, forzamos offline aunque tengamos
  // data stale: el user merece saber que perdimos contacto.
  const status = isDisconnected ? "offline" : state?.status ?? "offline";
  const STATUS_LABEL: Record<typeof status, string> = {
    online: "operativo",
    degraded: "con avisos",
    offline: isDisconnected ? "desconectado" : "sin conexión",
  };

  return (
    <header
      data-tauri-drag-region
      className="relative flex items-start justify-between gap-3 px-4 pt-3.5 pb-3 border-b border-white/[0.07]"
    >
      {/* Logo + nombre del local */}
      <motion.div
        initial={{ opacity: 0, y: -4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, delay: 0.05 }}
        data-tauri-drag-region
        className="flex items-center gap-2.5 min-w-0"
      >
        {/* Logo bAIt — wordmark con "AI" en cyan */}
        <div
          data-tauri-drag-region
          className="flex items-center justify-center h-9 w-9 rounded-lg bg-gradient-to-br from-bait-cyan-500/25 to-bait-cyan-700/10 border border-bait-cyan-500/30 backdrop-blur-sm shrink-0"
        >
          <span className="font-display font-bold text-base leading-none tracking-tighter">
            <span className="text-cream">b</span>
            <span className="text-bait-cyan-400">AI</span>
            <span className="text-cream">t</span>
          </span>
        </div>

        <div className="min-w-0" data-tauri-drag-region>
          <div className="flex items-center gap-2" data-tauri-drag-region>
            <StatusDot status={status} size="sm" />
            <span
              data-tauri-drag-region
              className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground font-medium"
            >
              {STATUS_LABEL[status]}
            </span>
          </div>
          <p
            data-tauri-drag-region
            className={cn(
              "text-[13px] font-semibold font-display truncate max-w-[200px] text-foreground/95 -mt-px"
            )}
            title={state?.location_name ?? "—"}
          >
            {isDisconnected
              ? "Servicio caído"
              : state?.location_name ?? "Conectando..."}
          </p>
        </div>
      </motion.div>

      {/* Window controls */}
      <div className="flex items-center gap-0.5 shrink-0">
        <Button
          variant="ghost"
          size="icon"
          onClick={onHide}
          className="h-7 w-7 rounded-md text-foreground/60 hover:text-foreground hover:bg-white/[0.06]"
          aria-label="Ocultar"
        >
          <Minus className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={onExit}
          className="h-7 w-7 rounded-md text-foreground/60 hover:text-red-300 hover:bg-red-500/15"
          aria-label="Cerrar companion"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
    </header>
  );
}
