import type { CaseStore } from "./store.js";

export interface ReadinessReport {
  status: "ready" | "not_ready";
  storage: "ok" | "error" | "timeout";
  latencyMs: number;
  pendingOutbox: number | null;
  inFlightOutbox: number | null;
  deadLetterOutbox: number | null;
}

function deadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("readiness_timeout")), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}

export async function evaluateReadiness(store: CaseStore, timeoutMs = 2_000): Promise<ReadinessReport> {
  const startedAt = Date.now();
  try {
    const counts = await deadline((async () => {
      await store.healthCheck();
      return await store.getOutboxCounts();
    })(), timeoutMs);
    return {
      status: "ready",
      storage: "ok",
      latencyMs: Date.now() - startedAt,
      pendingOutbox: counts.pending,
      inFlightOutbox: counts.inFlight,
      deadLetterOutbox: counts.deadLetter
    };
  } catch (error) {
    return {
      status: "not_ready",
      storage: error instanceof Error && error.message === "readiness_timeout" ? "timeout" : "error",
      latencyMs: Date.now() - startedAt,
      pendingOutbox: null,
      inFlightOutbox: null,
      deadLetterOutbox: null
    };
  }
}
