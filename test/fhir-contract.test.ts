import assert from "node:assert/strict";
import test from "node:test";
import { AppError } from "../src/errors.js";
import { normalizePrescriptionInput } from "../src/fhir.js";

function rejectedCode(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    return error instanceof AppError ? error.code : "unexpected";
  }
  return "not_rejected";
}

test("direct MedicationRequest normalizes the synthetic workflow input", () => {
  const normalized = normalizePrescriptionInput({
    resourceType: "MedicationRequest",
    id: "rx-fhir-1",
    subject: { reference: "Patient/synthetic-fhir" },
    medicationCodeableConcept: { coding: [{ code: "med-1" }] },
    insurance: [{ display: "PLAN-A" }],
    note: [{ text: "Synthetic note" }]
  });
  assert.equal(normalized.resourceId, "rx-fhir-1");
  assert.equal(normalized.medicationCode, "med-1");
  assert.equal(normalized.sourceWorkflow, "DIRECT_MEDICATION_REQUEST");
});

test("Bundle Task focus selects the FHIR_TASK source workflow", () => {
  const normalized = normalizePrescriptionInput({
    resourceType: "Bundle",
    entry: [
      {
        fullUrl: "urn:uuid:rx-fhir-2",
        resource: {
          resourceType: "MedicationRequest",
          id: "rx-fhir-2",
          subject: { reference: "Patient/synthetic-fhir" },
          medicationCodeableConcept: { coding: [{ code: "med-2" }] },
          insurance: [{ display: "PLAN-B" }]
        }
      },
      {
        resource: {
          resourceType: "Task",
          id: "task-1",
          focus: { reference: "urn:uuid:rx-fhir-2" }
        }
      }
    ]
  });
  assert.equal(normalized.sourceWorkflow, "FHIR_TASK");
  assert.equal(normalized.sourceTaskId, "task-1");
});

test("non-prescription FHIR input is rejected with a stable error code", () => {
  assert.equal(
    rejectedCode(() => normalizePrescriptionInput({ resourceType: "Patient", id: "p1" })),
    "invalid_fhir"
  );
});

test("Bundle requires exactly one MedicationRequest", () => {
  assert.equal(
    rejectedCode(() => normalizePrescriptionInput({ resourceType: "Bundle", entry: [] })),
    "invalid_fhir_bundle"
  );
});
