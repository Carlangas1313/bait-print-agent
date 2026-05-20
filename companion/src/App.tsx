import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/ui/tabs";
import { Toaster } from "./components/ui/toaster";
import { TooltipProvider } from "./components/ui/tooltip";
import { AppHeader } from "./components/AppHeader";
import { AppFooter } from "./components/AppFooter";
import { StatusTab } from "./components/StatusTab";
import { RecentJobsTab } from "./components/RecentJobsTab";
import { ActionsTab } from "./components/ActionsTab";
import { api } from "./lib/api";
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
  const [state, setState] = useState<AgentState | null>(null);
  const [printers, setPrinters] = useState<PrinterInfo[]>([]);
  const [jobs, setJobs] = useState<PrintJob[]>([]);

  // Fetch inicial + polling cada 4s mientras la ventana esté visible
  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      try {
        const [s, p, j] = await Promise.all([
          api.getState(),
          api.getPrinters(),
          api.getRecentJobs(20),
        ]);
        if (!alive) return;
        setState(s);
        setPrinters(p);
        setJobs(j);
      } catch (e) {
        console.error("[companion] refresh failed", e);
      }
    };
    refresh();
    const interval = setInterval(refresh, 4000);
    return () => {
      alive = false;
      clearInterval(interval);
    };
  }, []);

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
          state={state}
          onHide={tauriHide}
          onExit={tauriExit}
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
              <StatusTab state={state} printers={printers} />
            </TabsContent>

            <TabsContent value="jobs" className="flex-1 min-h-0 mt-3">
              <RecentJobsTab jobs={jobs} />
            </TabsContent>

            <TabsContent value="actions" className="flex-1 min-h-0 mt-3">
              <ActionsTab printers={printers} />
            </TabsContent>
          </Tabs>
        </main>

        <AppFooter agentVersion={state?.agent_version} />
      </motion.div>

      <Toaster />
    </TooltipProvider>
  );
}

export default App;
