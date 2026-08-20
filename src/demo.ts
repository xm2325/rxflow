import { readFile } from "node:fs/promises";
import { DeterministicPaDraftGenerator } from "./ai.js";
import { InMemoryCaseStore } from "./store.js";
import { RxWorkflowService } from "./workflow.js";

const fixture = JSON.parse(await readFile(new URL("../../fixtures/medication-request.json", import.meta.url), "utf8"));
const store = new InMemoryCaseStore();
const workflow = new RxWorkflowService(store, new DeterministicPaDraftGenerator());
const first = await workflow.ingest(fixture, "demo-001");
const second = await workflow.ingest(fixture, "demo-001");

console.log(JSON.stringify({
  caseId: first.case.id,
  status: first.case.status,
  priorAuthRequired: first.case.priorAuthRequired,
  paConfidence: first.case.paDraft?.confidence ?? null,
  auditEvents: first.case.audit.map((x) => x.type),
  duplicateOnReplay: second.duplicate,
  caseCount: store.size()
}, null, 2));
