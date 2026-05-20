/**
 * API client del companion contra el HTTP server local del agente
 * (escucha en 127.0.0.1:17891 según diseño).
 *
 * Este archivo expone la misma shape que va a tener el client real
 * (Promise<T>) pero por ahora devuelve los mocks de `mock-data.ts`.
 * Cuando el HTTP server esté wireup-eable, swap los bodies por fetch().
 *
 * TODO: wireup al endpoint real cuando el otro sub-agent termine. Endpoints
 * esperados (todos GET salvo donde se indique):
 *   GET  /v1/state              → AgentState
 *   GET  /v1/printers           → PrinterInfo[]
 *   GET  /v1/jobs/recent?limit=20 → PrintJob[]
 *   POST /v1/test-print         → { printer_id }  → { ok, job_id }
 *   POST /v1/queue/restart      → {}              → { ok }
 *   POST /v1/pairing/reset      → {}              → { ok }
 *   POST /v1/exit               → {}              → { ok } (apaga companion)
 */

import {
  mockAgentState,
  mockPrinters,
  mockRecentJobs,
  type AgentState,
  type PrinterInfo,
  type PrintJob,
} from "./mock-data";

const BASE_URL = "http://127.0.0.1:17891";
const USE_MOCKS = true; // TODO: flip a false cuando el HTTP server esté listo

// Pequeño helper para simular latencia de red en mocks
const wait = (ms = 120) => new Promise((r) => setTimeout(r, ms));

export const api = {
  async getState(): Promise<AgentState> {
    if (USE_MOCKS) {
      await wait();
      return {
        ...mockAgentState,
        // Heartbeat fresco cada vez que se pide
        last_heartbeat_at: new Date().toISOString(),
      };
    }
    const res = await fetch(`${BASE_URL}/v1/state`);
    if (!res.ok) throw new Error(`getState ${res.status}`);
    return res.json();
  },

  async getPrinters(): Promise<PrinterInfo[]> {
    if (USE_MOCKS) {
      await wait();
      return mockPrinters;
    }
    const res = await fetch(`${BASE_URL}/v1/printers`);
    if (!res.ok) throw new Error(`getPrinters ${res.status}`);
    return res.json();
  },

  async getRecentJobs(limit = 20): Promise<PrintJob[]> {
    if (USE_MOCKS) {
      await wait();
      return mockRecentJobs.slice(0, limit);
    }
    const res = await fetch(`${BASE_URL}/v1/jobs/recent?limit=${limit}`);
    if (!res.ok) throw new Error(`getRecentJobs ${res.status}`);
    return res.json();
  },

  async testPrint(printerId: string): Promise<{ ok: boolean; job_id?: string }> {
    if (USE_MOCKS) {
      await wait(250);
      console.log("[mock] testPrint →", printerId);
      return { ok: true, job_id: `mock-${Date.now()}` };
    }
    const res = await fetch(`${BASE_URL}/v1/test-print`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ printer_id: printerId }),
    });
    if (!res.ok) throw new Error(`testPrint ${res.status}`);
    return res.json();
  },

  async restartQueue(): Promise<{ ok: boolean }> {
    if (USE_MOCKS) {
      await wait(200);
      console.log("[mock] restartQueue");
      return { ok: true };
    }
    const res = await fetch(`${BASE_URL}/v1/queue/restart`, { method: "POST" });
    if (!res.ok) throw new Error(`restartQueue ${res.status}`);
    return res.json();
  },

  async resetPairing(): Promise<{ ok: boolean }> {
    if (USE_MOCKS) {
      await wait(200);
      console.log("[mock] resetPairing");
      return { ok: true };
    }
    const res = await fetch(`${BASE_URL}/v1/pairing/reset`, { method: "POST" });
    if (!res.ok) throw new Error(`resetPairing ${res.status}`);
    return res.json();
  },
};

export type Api = typeof api;
