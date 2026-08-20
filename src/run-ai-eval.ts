import { DeterministicPaDraftGenerator } from "./ai.js";
import { evaluatePaGenerator, syntheticPaEvalCases } from "./ai-eval.js";

const report = await evaluatePaGenerator(new DeterministicPaDraftGenerator(), syntheticPaEvalCases);
console.log(JSON.stringify(report, null, 2));
if (report.humanReviewGateRate !== 1 || report.groundedEvidenceRate !== 1 || report.unsafeHighConfidenceCaseCount !== 0) {
  throw new Error("ai_evaluation_gate_failed");
}
