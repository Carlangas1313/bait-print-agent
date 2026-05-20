import { useMemo } from "react";
import { motion } from "framer-motion";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/ui/tabs";
import { Toaster } from "./components/ui/toaster";
import { TooltipProvider } from "./components/ui/tooltip";
import { AppHeader } from "./components/AppHeader";
import { AppFooter } from "./components/AppFooter";
import { StatusTab } from "./components/StatusTab";
import { RecentJobsTab } from "./components/RecentJobsTab";
import { ActionsTab } from "./components/ActionsTab";
import { useAgentStatus, useRecentJobs } from "./hooks/use-agent-status";
import {
  discoveredPrintersToView,
  jobsToView,
  statusToAgentState,
} from "./lib/mappers";
import type { AgentState, PrinterInfo, PrintJob } from "./lib/mock-data";

// Tauri window helpers (lazy-load: si corremos `vite` puro fuera de tauri, no rompen).
async function tauriHide() {
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().hide();
  } catch (e) {
    console.warn("[companion] tauri.hide no disponible (Vite puro):", e);
  }
}

async function tauriExit() {
  try {
    const { exit } = await import("@tauri-apps/plugin-process");
    await exit(0);
  } catch (e) {
    console.warn("[companion] tauri.exit no disponible — fallback close window");
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().close();
    } catch {
      /* ignore */
    }
  }
}

function App() {
  // Polling de status (5s) y jobs recientes (10s). Los hooks pausan
  // automaticamente cuando la ventana esta hidden y refrescan al volver.
  const statusQuery = useAgentStatus();
  const jobsQuery = useRecentJobs(20);

  // Si el primer fetch fallo (agente apagado, sin config), `data` queda
  // null y `error` se setea. La UI muestra "DESCONECTADO" en el header.
  const isDisconnected = statusQuery.error !== null && statusQuery.data === null;

  const agentState: AgentState | null = useMemo(() => {
    if (!statusQuery.data) return null;
    const mapped = statusToAgentState(statusQuery.data);
    // Si tenemos error pero data stale, marcamos como offline igual: el
    // user merece saber que perdimos contacto. Si en cambio el error
    // viene del primer fetch (data=null), seguimos siendo offline.
    if (statusQuery.error !== null) {
      return { ...mapped, status: "offline" };
    }
    return mapped;
  }, [statusQuery.data, statusQuery.error]);

  const printers: PrinterInfo[] = useMemo(() => {
    if (!statusQuery.data) return [];
    return discoveredPrintersToView(statusQuery.data.discovered_printers);
  }, [statusQuery.data]);

  const jobs: PrintJob[] = useMemo(() => {
    if (!jobsQuery.data) return [];
    return jobsToView(jobsQuery.data);
  }, [jobsQuery.data]);

  return (
    <TooltipProvider delayDuration={200}>
      {/* Outer wrapper — la window de Tauri es transparente, el chrome lo dibuja .glass-shell */}
      <motion.div
        initial={{ opacity: 0, scale: 0.98, y: 6 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
        className="glass-shell h-full w-full flex flex-col text-cream"
      >
        {/* Header con drag region */}
        <AppHeader
          state={agentState}
          onHide={tauriHide}
          onExit={tauriExit}
          isDisconnected={isDisconnected}
        />

        {/* Body: tabs */}
        <main className="flex-1 flex flex-col px-4 pt-3 min-h-0">
          <Tabs defaultValue="status" className="flex flex-col flex-1 min-h-0">
            <TabsList className="w-full grid grid-cols-3">
              <TabsTrigger value="status">Estado</TabsTrigger>
              <TabsTrigger value="jobs">Recientes</TabsTrigger>
              <TabsTrigger value="actions">Acciones</TabsTrigger>
            </TabsList>

            <TabsContent value="status" className="flex-1 min-h-0 mt-3">
              <StatusTab
                state={agentState}
                printers={printers}
                isLoading={statusQuery.isLoading}
                isDisconnected={isDisconnected}
                errorMessage={statusQuery.error?.message ?? null}
              />
            </TabsContent>

            <TabsContent value="jobs" className="flex-1 min-h-0 mt-3">
              <RecentJobsTab
                jobs={jobs}
                onReprintSuccess={() => void jobsQuery.refresh()}
                isDisconnected={isDisconnected}
              />
            </TabsContent>

            <TabsContent value="actions" className="flex-1 min-h-0 mt-3">
              <ActionsTab
                printers={printers}
                isDisconnected={isDisconnected}
                onQueueRefreshed={() => {
                  void statusQuery.refresh();
                  void jobsQuery.refresh();
                }}
              />
            </TabsContent>
          </Tabs>
        </main>

        <AppFooter agentVersion={agentState?.agent_version} />
      </motion.div>

      <Toaster />
    </TooltipProvider>
  );
}

export default App;
