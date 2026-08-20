import type { RxCase } from "./domain.js";
import { AppError } from "./errors.js";

export interface SmartEhrLaunchRequest {
  iss: string;
  launch: string;
}

export interface SmartFhirContextItem {
  reference: string;
  role?: string;
}

export interface SmartTokenLaunchContext {
  patient?: string;
  encounter?: string;
  fhirContext: SmartFhirContextItem[];
  scope: string[];
  ehrTenant?: string;
  needPatientBanner?: boolean;
  intent?: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function cleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function fhirId(value: string, field: string): string {
  if (!/^[A-Za-z0-9\-.]{1,64}$/.test(value)) {
    throw new AppError(`invalid_smart_${field}`, 400, false, `SMART ${field} context is not a valid FHIR id.`);
  }
  return value;
}

/**
 * Parses the EHR-launch query parameters that the app receives before the OAuth
 * authorization redirect. This is validation only; it does not perform OAuth.
 */
export function parseSmartEhrLaunch(input: string | URL): SmartEhrLaunchRequest {
  const url = input instanceof URL ? input : new URL(input);
  const iss = cleanString(url.searchParams.get("iss"));
  const launch = cleanString(url.searchParams.get("launch"));
  if (!iss || !launch) {
    throw new AppError("invalid_smart_ehr_launch", 400, false, "SMART EHR launch requires both iss and launch parameters.");
  }
  let issuer: URL;
  try { issuer = new URL(iss); } catch {
    throw new AppError("invalid_smart_issuer", 400, false, "SMART iss must be an absolute FHIR base URL.");
  }
  if (issuer.protocol !== "https:" || issuer.username || issuer.password || issuer.hash) {
    throw new AppError("invalid_smart_issuer", 400, false, "SMART iss must use HTTPS and must not contain userinfo or a fragment.");
  }
  if (launch.length > 2048) {
    throw new AppError("smart_launch_too_large", 400, false, "SMART launch parameter is too large.");
  }
  return { iss: issuer.toString().replace(/\/$/, ""), launch };
}

/**
 * Extracts only launch context from a trusted SMART access-token response.
 * Access tokens and identity tokens are deliberately not retained by RxFlow.
 */
export function parseSmartTokenLaunchContext(input: unknown): SmartTokenLaunchContext {
  const value = record(input);
  if (!value) throw new AppError("invalid_smart_token_context", 400, false, "SMART token context must be a JSON object.");
  const patientRaw = cleanString(value.patient);
  const encounterRaw = cleanString(value.encounter);
  const scopeRaw = cleanString(value.scope) ?? "";
  const tenant = cleanString(value.tenant);
  const intent = cleanString(value.intent);
  if (value.need_patient_banner !== undefined && typeof value.need_patient_banner !== "boolean") {
    throw new AppError("invalid_smart_patient_banner", 400, false, "SMART need_patient_banner must be boolean when present.");
  }
  const fhirContextRaw = value.fhirContext;
  if (fhirContextRaw !== undefined && !Array.isArray(fhirContextRaw)) {
    throw new AppError("invalid_smart_fhir_context", 400, false, "SMART fhirContext must be an array when present.");
  }
  const fhirContext = (fhirContextRaw ?? []).map((item) => {
    const row = record(item);
    const reference = row ? cleanString(row.reference) : undefined;
    const role = row ? cleanString(row.role) : undefined;
    if (!reference || !/^[A-Za-z][A-Za-z0-9]+\/[A-Za-z0-9\-.]{1,64}$/.test(reference)) {
      throw new AppError("invalid_smart_fhir_context", 400, false, "SMART fhirContext entries require a relative FHIR resource reference.");
    }
    return { reference, ...(role ? { role } : {}) };
  });
  return {
    ...(patientRaw ? { patient: fhirId(patientRaw, "patient") } : {}),
    ...(encounterRaw ? { encounter: fhirId(encounterRaw, "encounter") } : {}),
    fhirContext,
    scope: scopeRaw.split(/\s+/).filter(Boolean),
    ...(tenant ? { ehrTenant: tenant } : {}),
    ...(typeof value.need_patient_banner === "boolean" ? { needPatientBanner: value.need_patient_banner } : {}),
    ...(intent ? { intent } : {})
  };
}

function patientIdFromReference(reference: string): string | undefined {
  const match = reference.match(/(?:^|\/)Patient\/([A-Za-z0-9\-.]{1,64})$/);
  return match?.[1];
}

/**
 * Patient-context guard used before showing a case in an EHR-launched review
 * surface. It does not authorize FHIR API access; it only checks that the
 * validated launch context and the RxFlow case refer to the same patient.
 */
export function assertSmartPatientMatchesCase(rxCase: RxCase, context: SmartTokenLaunchContext): void {
  if (!context.patient) {
    throw new AppError("smart_patient_context_required", 403, false, "A patient-bound SMART launch context is required for this review.");
  }
  const casePatient = patientIdFromReference(rxCase.patientReference);
  if (!casePatient || casePatient !== context.patient) {
    throw new AppError("smart_patient_context_mismatch", 404, false, "Case not found in the active SMART patient context.");
  }
}

export function smartContextMetadata(context: SmartTokenLaunchContext): Record<string, string | number | boolean> {
  return {
    patientContext: context.patient ? "present" : "absent",
    encounterContext: context.encounter ? "present" : "absent",
    fhirContextCount: context.fhirContext.length,
    scopeCount: context.scope.length,
    ehrTenantContext: context.ehrTenant ? "present" : "absent"
  };
}
