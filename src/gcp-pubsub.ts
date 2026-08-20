import { DeliveryError, type EventSink, type IntegrationEvent } from "./events.js";
import { httpDeliveryError, type HeaderLookup } from "./http-delivery.js";

interface FetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  headers?: HeaderLookup;
}

type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }
) => Promise<FetchResponse>;

export interface AccessTokenProvider {
  getAccessToken(): Promise<string>;
  invalidateAccessToken?(token: string): void | Promise<void>;
}

interface MetadataTokenResponse {
  access_token: string;
  expires_in: number;
  token_type?: string;
}

function parseMetadataToken(input: unknown): MetadataTokenResponse {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Error("invalid_gcp_metadata_token");
  const value = input as Record<string, unknown>;
  if (typeof value.access_token !== "string" || value.access_token.trim() === "") throw new Error("invalid_gcp_metadata_token");
  if (typeof value.expires_in !== "number" || !Number.isFinite(value.expires_in) || value.expires_in <= 0) throw new Error("invalid_gcp_metadata_token");
  return { access_token: value.access_token, expires_in: value.expires_in, ...(typeof value.token_type === "string" ? { token_type: value.token_type } : {}) };
}

export class GcpMetadataAccessTokenProvider implements AccessTokenProvider {
  private token?: { value: string; refreshAfterMs: number };

  constructor(
    private readonly fetcher: FetchLike = fetch,
    private readonly now: () => number = Date.now,
    private readonly timeoutMs = 2_000,
    private readonly metadataUrl = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token"
  ) {}

  async getAccessToken(): Promise<string> {
    const nowMs = this.now();
    if (this.token && nowMs < this.token.refreshAfterMs) return this.token.value;
    const response = await this.fetcher(this.metadataUrl, {
      method: "GET",
      headers: { "Metadata-Flavor": "Google" },
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    if (!response.ok) throw new Error(`gcp_metadata_http_${response.status}`);
    const token = parseMetadataToken(await response.json());
    const lifetimeMs = token.expires_in * 1_000;
    const refreshMarginMs = Math.min(60_000, Math.floor(lifetimeMs / 2));
    this.token = { value: token.access_token, refreshAfterMs: nowMs + lifetimeMs - refreshMarginMs };
    return token.access_token;
  }

  invalidateAccessToken(token: string): void {
    if (this.token?.value === token) this.token = undefined;
  }
}

function requireGcpIdentifier(value: string, field: string): string {
  const cleaned = value.trim();
  if (!cleaned || !/^[A-Za-z0-9._:-]+$/.test(cleaned)) throw new Error(`invalid_${field}`);
  return cleaned;
}

export class GcpPubSubEventSink implements EventSink {
  private readonly projectId: string;
  private readonly topic: string;

  constructor(
    projectId: string,
    topic: string,
    private readonly tokenProvider: AccessTokenProvider,
    private readonly timeoutMs = 5_000,
    private readonly fetcher: FetchLike = fetch,
    private readonly apiRoot = "https://pubsub.googleapis.com/v1"
  ) {
    this.projectId = requireGcpIdentifier(projectId, "pubsub_project");
    this.topic = requireGcpIdentifier(topic, "pubsub_topic");
  }

  async deliver(event: IntegrationEvent): Promise<void> {
    const data = Buffer.from(JSON.stringify(event), "utf8").toString("base64");
    const body = JSON.stringify({
      messages: [{
        data,
        attributes: {
          eventId: event.eventId,
          eventType: event.type,
          schemaVersion: String(event.schemaVersion),
          correlationId: event.correlationId
        }
      }]
    });
    const url = `${this.apiRoot}/projects/${encodeURIComponent(this.projectId)}/topics/${encodeURIComponent(this.topic)}:publish`;

    const publish = async (token: string): Promise<FetchResponse> => await this.fetcher(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json"
      },
      body,
      signal: AbortSignal.timeout(this.timeoutMs)
    });

    let token: string;
    try {
      token = await this.tokenProvider.getAccessToken();
    } catch {
      throw new DeliveryError("pubsub_token_unavailable", { retryable: true, failureScope: "global" });
    }
    let response: FetchResponse;
    try {
      response = await publish(token);
    } catch {
      throw new DeliveryError("pubsub_transport_error", { retryable: true, failureScope: "global" });
    }
    if (!response.ok && response.status === 401 && this.tokenProvider.invalidateAccessToken) {
      await this.tokenProvider.invalidateAccessToken(token);
      try {
        token = await this.tokenProvider.getAccessToken();
        response = await publish(token);
      } catch {
        throw new DeliveryError("pubsub_transport_error", { retryable: true, failureScope: "global" });
      }
      if (!response.ok && response.status === 401) await this.tokenProvider.invalidateAccessToken(token);
    }
    if (!response.ok) throw httpDeliveryError("pubsub", response.status, response.headers, Date.now(), "global");
  }
}
