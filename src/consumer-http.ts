import type { GoogleOidcClaims } from "./pubsub-auth.js";
import { PubSubPushAdapter } from "./pubsub.js";

export interface AuthorizationVerifier {
  verifyAuthorizationHeader(header: string | undefined, now?: Date): Promise<GoogleOidcClaims>;
}

export interface ConsumerHttpResult {
  status: number;
  body: Record<string, unknown>;
}

export class AuthenticatedPubSubConsumerHandler {
  constructor(
    private readonly auth: AuthorizationVerifier,
    private readonly adapter: PubSubPushAdapter,
    private readonly clock: () => Date = () => new Date()
  ) {}

  async handle(authorizationHeader: string | undefined, body: unknown): Promise<ConsumerHttpResult> {
    try {
      const claims = await this.auth.verifyAuthorizationHeader(authorizationHeader, this.clock());
      const result = this.adapter.consume(body);
      return {
        status: 204,
        body: {
          acknowledged: true,
          duplicate: result.duplicate,
          sideEffectApplied: result.sideEffectApplied,
          eventId: result.event.eventId,
          eventType: result.event.type,
          subscription: result.subscription,
          authenticatedServiceAccount: claims.email
        }
      };
    } catch (error) {
      const code = error instanceof Error ? error.message : "consumer_request_failed";
      if (code.startsWith("pubsub_auth_")) return { status: 401, body: { error: "unauthorized" } };
      if (code.startsWith("invalid_pubsub_push:") || code.startsWith("invalid_integration_event:")) {
        return { status: 400, body: { error: "invalid_pubsub_message" } };
      }
      throw error;
    }
  }
}
