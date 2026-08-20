import { readFileSync } from "node:fs";
import { DeterministicPaDraftGenerator } from "./ai.js";
import { InMemoryCaseStore } from "./store.js";
import { RxWorkflowService } from "./workflow.js";
import { assertSmartPatientMatchesCase, parseSmartEhrLaunch, parseSmartTokenLaunchContext, smartContextMetadata } from "./smart-launch.js";

const fixture = JSON.parse(readFileSync(new URL("../../fixtures/smart-launch-context.json", import.meta.url).pathname, "utf8"));
const medicationRequest = JSON.parse(readFileSync(new URL("../../fixtures/medication-request.json", import.meta.url).pathname, "utf8"));
const service = new RxWorkflowService(new InMemoryCaseStore(), new DeterministicPaDraftGenerator());
const result = await service.ingest(medicationRequest, "smart-demo", "smart-demo-correlation", undefined, "health-a");
const launch = parseSmartEhrLaunch(fixture.launchUrl);
const context = parseSmartTokenLaunchContext(fixture.tokenResponseContext);
assertSmartPatientMatchesCase(result.case, context);
let mismatchRejected = false;
try {
  assertSmartPatientMatchesCase(result.case, { ...context, patient: "different-patient" });
} catch {
  mismatchRejected = true;
}
console.log(JSON.stringify({
  smartLaunch: "ok",
  issuer: launch.iss,
  launchHandlePresent: launch.launch.length > 0,
  patientBoundReview: "matched",
  mismatchRejected,
  metadata: smartContextMetadata(context)
}, null, 2));
