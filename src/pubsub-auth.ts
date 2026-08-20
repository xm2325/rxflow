import { createPublicKey, verify as verifySignature } from "node:crypto";

export interface PublicJwk {
  kid: string;
  kty: string;
  n?: string;
  e?: string;
  alg?: string;
  use?: string;
}

export interface JwksProvider {
  getKey(kid: string): Promise<PublicJwk | undefined>;
}

export interface GoogleOidcClaims {
  iss: string;
  aud: string;
  exp: number;
  iat: number;
  email: string;
  email_verified: boolean;
  sub?: string;
}

export class StaticJwksProvider implements JwksProvider {
  private readonly keys = new Map<string, PublicJwk>();

  constructor(keys: PublicJwk[]) {
    for (const key of keys) this.keys.set(key.kid, key);
  }

  async getKey(kid: string): Promise<PublicJwk | undefined> {
    return this.keys.get(kid);
  }
}

interface JwksDocument { keys?: PublicJwk[]; }

export class GoogleJwksProvider implements JwksProvider {
  private cached = new Map<string, PublicJwk>();
  private expiresAtMs = 0;

  constructor(
    private readonly fetchFn: typeof fetch = fetch,
    private readonly jwksUrl = "https://www.googleapis.com/oauth2/v3/certs",
    private readonly fallbackTtlMs = 300_000
  ) {}

  async getKey(kid: string): Promise<PublicJwk | undefined> {
    const now = Date.now();
    if (now >= this.expiresAtMs || !this.cached.has(kid)) await this.refresh(now);
    return this.cached.get(kid);
  }

  private async refresh(now: number): Promise<void> {
    const response = await this.fetchFn(this.jwksUrl, { method: "GET" });
    if (!response.ok) throw new Error(`google_jwks_http_${response.status}`);
    const body = await response.json() as JwksDocument;
    if (!Array.isArray(body.keys) || body.keys.length === 0) throw new Error("google_jwks_invalid_response");
    const next = new Map<string, PublicJwk>();
    for (const key of body.keys) {
      if (key && typeof key.kid === "string" && key.kid !== "" && key.kty === "RSA") next.set(key.kid, key);
    }
    if (next.size === 0) throw new Error("google_jwks_no_rsa_keys");
    this.cached = next;
    this.expiresAtMs = now + cacheMaxAgeMs(response.headers.get("cache-control"), this.fallbackTtlMs);
  }
}

export class GoogleOidcJwtVerifier {
  constructor(
    private readonly audience: string,
    private readonly expectedServiceAccount: string,
    private readonly keys: JwksProvider,
    private readonly clockSkewSeconds = 60
  ) {
    if (!audience.trim()) throw new Error("oidc_audience_required");
    if (!expectedServiceAccount.trim()) throw new Error("oidc_service_account_required");
  }

  async verifyAuthorizationHeader(authorizationHeader: string | undefined, now = new Date()): Promise<GoogleOidcClaims> {
    if (!authorizationHeader?.startsWith("Bearer ")) throw new Error("pubsub_auth_missing_bearer_token");
    const token = authorizationHeader.slice("Bearer ".length).trim();
    const [encodedHeader, encodedClaims, encodedSignature, extra] = token.split(".");
    if (!encodedHeader || !encodedClaims || !encodedSignature || extra !== undefined) throw new Error("pubsub_auth_invalid_jwt");

    const header = parseBase64UrlJson(encodedHeader, "header") as Record<string, unknown>;
    const claims = parseBase64UrlJson(encodedClaims, "claims") as Record<string, unknown>;
    if (header.alg !== "RS256") throw new Error("pubsub_auth_unsupported_alg");
    if (typeof header.kid !== "string" || header.kid.trim() === "") throw new Error("pubsub_auth_missing_kid");
    const jwk = await this.keys.getKey(header.kid);
    if (!jwk) throw new Error("pubsub_auth_unknown_kid");
    if (jwk.kty !== "RSA") throw new Error("pubsub_auth_invalid_key_type");

    const key = createPublicKey({ key: jwk, format: "jwk" });
    const signature = decodeBase64Url(encodedSignature, "signature");
    const signed = Buffer.from(`${encodedHeader}.${encodedClaims}`, "utf8");
    if (!verifySignature("RSA-SHA256", signed, key, signature)) throw new Error("pubsub_auth_invalid_signature");

    const parsed = parseClaims(claims);
    const nowSeconds = Math.floor(now.getTime() / 1000);
    const skew = this.clockSkewSeconds;
    if (parsed.iss !== "accounts.google.com" && parsed.iss !== "https://accounts.google.com") throw new Error("pubsub_auth_invalid_issuer");
    if (parsed.aud !== this.audience) throw new Error("pubsub_auth_invalid_audience");
    if (parsed.email !== this.expectedServiceAccount || parsed.email_verified !== true) throw new Error("pubsub_auth_invalid_service_account");
    if (parsed.exp < nowSeconds - skew) throw new Error("pubsub_auth_token_expired");
    if (parsed.iat > nowSeconds + skew) throw new Error("pubsub_auth_token_from_future");
    return parsed;
  }
}

function parseClaims(value: Record<string, unknown>): GoogleOidcClaims {
  if (typeof value.iss !== "string" || typeof value.aud !== "string" || typeof value.email !== "string") throw new Error("pubsub_auth_invalid_claims");
  if (!Number.isInteger(value.exp) || !Number.isInteger(value.iat)) throw new Error("pubsub_auth_invalid_claims");
  if (value.email_verified !== true) throw new Error("pubsub_auth_invalid_claims");
  if (value.sub !== undefined && typeof value.sub !== "string") throw new Error("pubsub_auth_invalid_claims");
  return {
    iss: value.iss,
    aud: value.aud,
    exp: value.exp as number,
    iat: value.iat as number,
    email: value.email,
    email_verified: true,
    ...(typeof value.sub === "string" ? { sub: value.sub } : {})
  };
}

function parseBase64UrlJson(value: string, part: string): unknown {
  try {
    return JSON.parse(decodeBase64Url(value, part).toString("utf8"));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("pubsub_auth_")) throw error;
    throw new Error(`pubsub_auth_invalid_${part}`);
  }
}

function decodeBase64Url(value: string, part: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`pubsub_auth_invalid_${part}`);
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const decoded = Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/") + padding, "base64");
  const canonical = decoded.toString("base64url");
  if (canonical !== value) throw new Error(`pubsub_auth_invalid_${part}`);
  return decoded;
}

function cacheMaxAgeMs(cacheControl: string | null, fallbackMs: number): number {
  const match = cacheControl?.match(/(?:^|,)\s*max-age=(\d+)/i);
  if (!match) return fallbackMs;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : fallbackMs;
}
