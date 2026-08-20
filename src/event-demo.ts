import { readFile } from "node:fs/promises";
import { DeterministicPaDraftGenerator } from "./ai.js";
import { CollectingEventSink, OutboxDispatcher } from "./events.js";
import { InMemoryCaseStore } from "./store.js";
import { RxWorkflowService } from "./workflow.js";

const fixture = JSON.parse(await readFile(new URL("../../fixtures/medication-request.json", import.meta.url), "utf8"));
const store = new InMemoryCaseStore();
const workflow = new RxWorkflowService(store, new DeterministicPaDraftGenerator());
await workflow.ingest(fixture, "event-demo", "corr-event-demo");

const sink = new CollectingEventSink();
const before = store.listOutbox("PENDING").length;
const report = await new OutboxDispatcher(store, sink).drain();

console.log(JSON.stringify({
  before,
  report,
  publishedTypes: sink.events.map((event) => event.type),
  correlationIds: [...new Set(sink.events.map((event) => event.correlationId))]
}, null, 2));
