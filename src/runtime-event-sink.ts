import type { RuntimeConfig } from "./config.js";
import type { EventSink } from "./events.js";
import { MetadataLogEventSink } from "./events.js";
import { GcpMetadataAccessTokenProvider, GcpPubSubEventSink } from "./gcp-pubsub.js";
import { SignedWebhookEventSink } from "./webhook.js";

export function createRuntimeEventSink(config: RuntimeConfig): EventSink {
  if (config.webhookUrl) return new SignedWebhookEventSink(config.webhookUrl, config.webhookSecret!);
  if (config.pubsubProject && config.pubsubTopic) {
    return new GcpPubSubEventSink(config.pubsubProject, config.pubsubTopic, new GcpMetadataAccessTokenProvider());
  }
  return new MetadataLogEventSink();
}
