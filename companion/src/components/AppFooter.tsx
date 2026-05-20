import { LifeBuoy } from "lucide-react";
import { motion } from "framer-motion";
import { COMPANION_VERSION } from "@/lib/updater";

interface AppFooterProps {
  agentVersion?: string;
  /** Override solo para tests/stories. En produccion siempre se usa la
   *  version del package.json del companion via COMPANION_VERSION. */
  companionVersion?: string;
}

export function AppFooter({
  agentVersion,
  companionVersion = COMPANION_VERSION,
}: AppFooterProps) {
  return (
    <motion.footer
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.4, delay: 0.2 }}
      className="flex items-center justify-between px-4 py-2 border-t border-white/[0.07] text-[10px] text-muted-foreground/70"
    >
      <div className="flex items-center gap-1.5">
        <span className="font-mono tracking-tight">
          companion v{companionVersion}
        </span>
        {agentVersion ? (
          <>
            <span className="opacity-40">·</span>
            <span className="font-mono tracking-tight">
              agente v{agentVersion}
            </span>
          </>
        ) : null}
      </div>
      <a
        href="#"
        onClick={(e) => {
          e.preventDefault();
          // TODO: abrir bait-app.cl/soporte vía plugin-opener
          console.log("[footer] abrir soporte");
        }}
        className="flex items-center gap-1 hover:text-bait-cyan-300 transition-colors"
      >
        <LifeBuoy className="h-3 w-3" />
        <span>soporte</span>
      </a>
    </motion.footer>
  );
}
