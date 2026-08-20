import { timingSafeEqual } from "node:crypto";
import { AppError } from "./errors.js";

export type ApiRole = "ingest" | "operations" | "review" | "platform";

export interface ApiPrincipal {
  id: string;
  authentication: "static_bearer";
  tenantId?: string;
  role?: ApiRole;
}

export interface StaticCredential {
  token: string;
  principal: string;
  tenantId: string;
  roles: ApiRole[];
}

/**
 * Small application-level auth boundary for the synthetic portfolio service.
 * A real deployment can place Cloud Run IAM/IAP or another identity provider in
 * front of the service; this helper exists so sensitive routes are not forced to
 * trust caller-supplied identity when application auth is enabled.
 */
export function authorizeStaticBearer(
  authorizationHeader: string | undefined,
  expectedToken: string,
  principalId: string,
  tenantId?: string,
  role?: ApiRole
): ApiPrincipal {
  const supplied = extractBearerToken(authorizationHeader);
  if (!supplied || !safeSecretEqual(supplied, expectedToken)) {
    throw new AppError("unauthorized", 401, false, "Valid bearer authentication is required.");
  }
  return { id: principalId, authentication: "static_bearer", ...(tenantId ? { tenantId } : {}), ...(role ? { role } : {}) };
}

export function authorizeStaticCredentialSet(
  authorizationHeader: string | undefined,
  credentials: StaticCredential[],
  requiredRole: ApiRole
): ApiPrincipal {
  const supplied = extractBearerToken(authorizationHeader);
  if (!supplied) throw new AppError("unauthorized", 401, false, "Valid bearer authentication is required.");
  let matched: StaticCredential | undefined;
  for (const credential of credentials) {
    const equal = safeSecretEqual(supplied, credential.token);
    if (equal) matched = credential;
  }
  if (!matched || !matched.roles.includes(requiredRole)) {
    throw new AppError("unauthorized", 401, false, "Valid bearer authentication is required.");
  }
  return {
    id: matched.principal,
    authentication: "static_bearer",
    tenantId: matched.tenantId,
    role: requiredRole
  };
}

export function extractBearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = header.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim();
  return token || undefined;
}

export function safeSecretEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  if (a.length !== b.length) {
    // Run one same-length comparison even for a length mismatch so the normal
    // comparison path is not reduced to a plain string equality operation.
    const padded = Buffer.from(new Uint8Array(a.length));
    timingSafeEqual(a, padded);
    return false;
  }
  return timingSafeEqual(a, b);
}

export function reviewerIdentity(
  bodyReviewer: unknown,
  authenticatedPrincipal?: ApiPrincipal,
  allowCallerSuppliedIdentity = true
): string {
  if (authenticatedPrincipal) return authenticatedPrincipal.id;
  if (!allowCallerSuppliedIdentity) {
    throw new AppError("authenticated_reviewer_identity_required", 401, false, "An authenticated reviewer identity is required for this deployment.");
  }
  if (typeof bodyReviewer !== "string" || bodyReviewer.trim() === "") {
    throw new AppError("reviewer_required", 400, false, "A reviewer identifier is required when application authentication is disabled.");
  }
  return bodyReviewer.trim();
}
