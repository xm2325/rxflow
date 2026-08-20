import { AppError } from "./errors.js";

export interface FhirCoding {
  system?: string;
  code?: string;
  display?: string;
}

export interface MedicationRequest {
  resourceType: "MedicationRequest";
  id: string;
  subject: { reference: string };
  medicationCodeableConcept?: { coding?: FhirCoding[]; text?: string };
  medicationReference?: { reference?: string; display?: string };
  insurance?: Array<{ reference?: string; display?: string }>;
  note?: Array<{ text?: string }>;
}

export interface Medication {
  resourceType: "Medication";
  id: string;
  code?: { coding?: FhirCoding[]; text?: string };
}

export interface Task {
  resourceType: "Task";
  id: string;
  focus?: { reference?: string };
  status?: string;
  intent?: string;
}

export interface Coverage {
  resourceType: "Coverage";
  id: string;
  payor?: Array<{ reference?: string; display?: string }>;
  class?: Array<{ type?: { coding?: FhirCoding[] }; value?: string; name?: string }>;
}

export interface FhirBundle {
  resourceType: "Bundle";
  type?: string;
  entry?: Array<{ fullUrl?: string; resource?: unknown }>;
}

export type PrescriptionWorkflowSource = "DIRECT_MEDICATION_REQUEST" | "FHIR_TASK";

export interface NormalizedPrescription {
  resourceId: string;
  patientReference: string;
  medicationCode: string;
  payerPlan: string;
  clinicalNote: string;
  sourceWorkflow?: PrescriptionWorkflowSource;
  sourceTaskId?: string;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new AppError("invalid_fhir", 400, false, `Invalid FHIR MedicationRequest: missing ${field}`);
  }
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function coverageDisplay(coverage: Coverage): string | undefined {
  const payor = coverage.payor?.[0];
  if (payor?.display?.trim()) return payor.display.trim();
  if (payor?.reference?.trim()) return payor.reference.trim();
  const planClass = coverage.class?.find((entry) => entry.name?.trim() || entry.value?.trim());
  return planClass?.name?.trim() || planClass?.value?.trim();
}

function coverageByReference(bundle: FhirBundle): Map<string, Coverage> {
  const result = new Map<string, Coverage>();
  for (const entry of bundle.entry ?? []) {
    if (!isObject(entry.resource) || entry.resource.resourceType !== "Coverage") continue;
    const coverage = entry.resource as unknown as Coverage;
    if (typeof coverage.id !== "string" || coverage.id.trim() === "") continue;
    result.set(`Coverage/${coverage.id}`, coverage);
    if (typeof entry.fullUrl === "string" && entry.fullUrl.trim() !== "") result.set(entry.fullUrl, coverage);
  }
  return result;
}


function medicationByReference(bundle: FhirBundle): Map<string, Medication> {
  const result = new Map<string, Medication>();
  for (const entry of bundle.entry ?? []) {
    if (!isObject(entry.resource) || entry.resource.resourceType !== "Medication") continue;
    const medication = entry.resource as unknown as Medication;
    if (typeof medication.id !== "string" || medication.id.trim() === "") continue;
    result.set(`Medication/${medication.id}`, medication);
    if (typeof entry.fullUrl === "string" && entry.fullUrl.trim() !== "") result.set(entry.fullUrl, medication);
  }
  return result;
}

function medicationCode(resource: Partial<MedicationRequest>, medicationIndex?: Map<string, Medication>): string | undefined {
  const concept = resource.medicationCodeableConcept;
  const reference = resource.medicationReference?.reference?.trim();
  if (concept && reference) {
    throw new AppError("invalid_fhir", 400, false, "Invalid FHIR MedicationRequest: medication[x] must contain only one choice.");
  }
  if (concept) return concept.coding?.[0]?.code ?? concept.text;
  if (!reference) return undefined;
  const resolved = medicationIndex?.get(reference);
  if (!resolved) {
    throw new AppError("invalid_fhir", 400, false, "Invalid FHIR MedicationRequest: medicationReference could not be resolved.");
  }
  return resolved.code?.coding?.[0]?.code ?? resolved.code?.text;
}

export function normalizeMedicationRequest(
  input: unknown,
  coverageIndex?: Map<string, Coverage>,
  medicationIndex?: Map<string, Medication>,
  sourceWorkflow: PrescriptionWorkflowSource = "DIRECT_MEDICATION_REQUEST",
  sourceTaskId?: string
): NormalizedPrescription {
  if (!isObject(input)) {
    throw new AppError("invalid_fhir", 400, false, "Invalid FHIR MedicationRequest: body must be an object");
  }
  const resource = input as unknown as Partial<MedicationRequest>;
  if (resource.resourceType !== "MedicationRequest") {
    throw new AppError("invalid_fhir", 400, false, "Invalid FHIR MedicationRequest: resourceType must be MedicationRequest");
  }

  const resourceId = requireString(resource.id, "id");
  const patientReference = requireString(resource.subject?.reference, "subject.reference");
  const resolvedMedicationCode = medicationCode(resource, medicationIndex);
  const insurance = resource.insurance?.[0];
  let payerPlan = insurance?.display ?? insurance?.reference ?? "UNKNOWN";
  if (!insurance?.display && insurance?.reference && coverageIndex) {
    const resolved = coverageIndex.get(insurance.reference);
    payerPlan = (resolved && coverageDisplay(resolved)) ?? insurance.reference;
  }
  const clinicalNote = resource.note?.map((n) => n.text ?? "").filter(Boolean).join(" ") ?? "";

  return {
    resourceId,
    patientReference,
    medicationCode: requireString(resolvedMedicationCode, "medication[x]"),
    payerPlan,
    clinicalNote,
    sourceWorkflow,
    ...(sourceTaskId ? { sourceTaskId } : {})
  };
}

export function normalizePrescriptionInput(input: unknown): NormalizedPrescription {
  if (!isObject(input)) {
    throw new AppError("invalid_fhir", 400, false, "Invalid FHIR input: body must be an object");
  }
  if (input.resourceType === "MedicationRequest") return normalizeMedicationRequest(input);
  if (input.resourceType !== "Bundle") {
    throw new AppError("invalid_fhir", 400, false, "Invalid FHIR input: expected MedicationRequest or Bundle");
  }

  const bundle = input as unknown as FhirBundle;
  if (!Array.isArray(bundle.entry)) {
    throw new AppError("invalid_fhir_bundle", 400, false, "Invalid FHIR Bundle: entry must be an array.");
  }
  const medicationEntries = bundle.entry
    .filter((entry) => isObject(entry.resource) && entry.resource.resourceType === "MedicationRequest")
    .map((entry) => ({ fullUrl: entry.fullUrl, resource: entry.resource as unknown as MedicationRequest }));
  if (medicationEntries.length !== 1) {
    throw new AppError(
      "invalid_fhir_bundle",
      400,
      false,
      `Invalid FHIR Bundle: expected exactly one MedicationRequest, found ${medicationEntries.length}.`
    );
  }

  const medicationEntry = medicationEntries[0];
  const tasks = bundle.entry
    .map((entry) => entry.resource)
    .filter((resource): resource is Task => isObject(resource) && resource.resourceType === "Task");
  if (tasks.length > 1) {
    throw new AppError("invalid_fhir_bundle", 400, false, "Invalid FHIR Bundle: at most one workflow Task is supported.");
  }

  let sourceWorkflow: PrescriptionWorkflowSource = "DIRECT_MEDICATION_REQUEST";
  let sourceTaskId: string | undefined;
  if (tasks.length === 1) {
    const task = tasks[0];
    const taskId = requireString(task.id, "Task.id");
    const focus = requireString(task.focus?.reference, "Task.focus.reference");
    const acceptedReferences = new Set([`MedicationRequest/${medicationEntry.resource.id}`]);
    if (typeof medicationEntry.fullUrl === "string" && medicationEntry.fullUrl.trim() !== "") acceptedReferences.add(medicationEntry.fullUrl);
    if (!acceptedReferences.has(focus)) {
      throw new AppError("invalid_fhir_bundle", 400, false, "Invalid FHIR Bundle: Task.focus must reference the bundled MedicationRequest.");
    }
    sourceWorkflow = "FHIR_TASK";
    sourceTaskId = taskId;
  }

  return normalizeMedicationRequest(
    medicationEntry.resource,
    coverageByReference(bundle),
    medicationByReference(bundle),
    sourceWorkflow,
    sourceTaskId
  );
}
