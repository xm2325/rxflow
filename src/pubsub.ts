import { parseIntegrationEvent, type IntegrationEvent } from "./events.js";

export interface PubSubPushMessage {
  data: string;
  messageId?: string;
  publishTime?: string;
  attributes?: Record<string, string>;
  orderingKey?: string;
}

export interface PubSubPushEnvelope {
  message: PubSubPushMessage;
  subscription: string;
  deliveryAttempt?: number;
}

export interface ParsedPubSubPush {
  event: IntegrationEvent;
  subscription: string;
  messageId?: string;
  deliveryAttempt?: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(reason: string): never {
  throw new Error(`invalid_pubsub_push:${reason}`);
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") invalid(field);
  return value;
}

function decodeStrictBase64(value: string): string {
  const compact = value.trim();
  if (compact === "" || compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
    invalid("message_data_base64");
  }
  const decoded = Buffer.from(compact, "base64");
  const canonical = decoded.toString("base64");
  if (canonical !== compact) invalid("message_data_base64");
  return decoded.toString("utf8");
}

export function parsePubSubPush(input: unknown): ParsedPubSubPush {
  if (!isObject(input)) invalid("body_not_object");
  if (!isObject(input.message)) invalid("message_not_object");
  const message = input.message;
  const data = requireNonEmptyString(message.data, "message_data");
  const subscription = requireNonEmptyString(input.subscription, "subscription");
  if (input.deliveryAttempt !== undefined && (!Number.isInteger(input.deliveryAttempt) || (input.deliveryAttempt as number) < 1)) {
    invalid("delivery_attempt");
  }
  if (message.messageId !== undefined && (typeof message.messageId !== "string" || message.messageId.trim() === "")) invalid("message_id");
  if (message.publishTime !== undefined && (typeof message.publishTime !== "string" || !Number.isFinite(Date.parse(message.publishTime)))) invalid("publish_time");

  let raw: unknown;
  try {
    raw = JSON.parse(decodeStrictBase64(data));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("invalid_pubsub_push:")) throw error;
    invalid("message_data_json");
  }
  const event = parseIntegrationEvent(raw);
  return {
    event,
    subscription,
    ...(typeof message.messageId === "string" ? { messageId: message.messageId } : {}),
    ...(typeof input.deliveryAttempt === "number" ? { deliveryAttempt: input.deliveryAttempt } : {})
  };
}

export interface IntegrationEventConsumer {
  consume(event: IntegrationEvent): { duplicate: boolean; sideEffectApplied: boolean };
}

export class PubSubPushAdapter {
  constructor(private readonly consumer: IntegrationEventConsumer) {}

  consume(input: unknown): ParsedPubSubPush & { duplicate: boolean; sideEffectApplied: boolean } {
    const parsed = parsePubSubPush(input);
    const result = this.consumer.consume(parsed.event);
    return { ...parsed, ...result };
  }
}
