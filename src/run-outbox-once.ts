import { loadRuntimeConfig } from "./config.js";
import { createRuntimeEventSink } from "./runtime-event-sink.js";
import { closeRuntimeStore, createRuntimeStore } from "./storage-factory.js";
import { drainOutboxUntilIdle } from "./outbox-runner.js";
import { VERSION } from "./version.js";

const config = loadRuntimeConfig(process.env);
const store = await createRuntimeStore(config);
try {
  const report = await drainOutboxUntilIdle(store, createRuntimeEventSink(config));
  console.log(JSON.stringify({ event: "outbox_drain_completed", version: VERSION, storageMode: config.storageMode, ...report }));
  if (report.failed > 0 || report.deadLettered > 0 || report.staleClaims > 0) process.exitCode = 2;
} finally {
  await closeRuntimeStore(store);
}
