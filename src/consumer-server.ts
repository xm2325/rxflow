import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { SqlitePharmacyProjectionStore } from "./downstream.js";
import { AuthenticatedPubSubConsumerHandler } from "./consumer-http.js";
import { GoogleJwksProvider, GoogleOidcJwtVerifier } from "./pubsub-auth.js";
import { PubSubPushAdapter } from "./pubsub.js";
import { VERSION } from "./version.js";
import { rejectOversizeContentLength, requireJsonContentType } from "./http-request-contract.js";
import { consumerOperationalError } from "./operational-errors.js";

const port = parsePort(process.env.RXFLOW_CONSUMER_PORT ?? "8081");
const dbFile = requireEnv("RXFLOW_PROJECTION_SQLITE_FILE");
const audience = requireEnv("RXFLOW_PUBSUB_PUSH_AUDIENCE");
const serviceAccount = requireEnv("RXFLOW_PUBSUB_PUSH_SERVICE_ACCOUNT");
const store = new SqlitePharmacyProjectionStore(dbFile);
const auth = new GoogleOidcJwtVerifier(audience, serviceAccount, new GoogleJwksProvider());
const handler = new AuthenticatedPubSubConsumerHandler(auth, new PubSubPushAdapter(store));
const MAX_BODY_BYTES = 1024 * 1024;

function send(res: ServerResponse, status: number, body?: Record<string, unknown>): void {
  if (status === 204) {
    res.writeHead(204);
    res.end();
    return;
  }
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body ?? {}));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  requireJsonContentType(typeof req.headers["content-type"] === "string" ? req.headers["content-type"] : undefined, false);
  rejectOversizeContentLength(typeof req.headers["content-length"] === "string" ? req.headers["content-length"] : undefined, MAX_BODY_BYTES);
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) throw new Error("consumer_request_too_large");
    chunks.push(Buffer.from(chunk));
  }
  if (chunks.length === 0) throw new Error("consumer_empty_body");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("consumer_invalid_json");
  }
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health/live") return send(res, 200, { status: "ok", service: "rxflow-pharmacy-consumer", version: VERSION });
    if (req.method === "POST" && req.url === "/v1/pubsub/events") {
      const body = await readJson(req);
      const authorization = typeof req.headers.authorization === "string" ? req.headers.authorization : undefined;
      const result = await handler.handle(authorization, body);
      return send(res, result.status, result.body);
    }
    return send(res, 404, { error: "not_found" });
  } catch (error) {
    const mapped = consumerOperationalError(error);
    console.error(JSON.stringify({ event: "consumer_request_error", code: mapped.code, status: mapped.status }));
    return send(res, mapped.status, { error: mapped.status >= 500 ? "internal_error" : "invalid_request" });
  }
});



let stopping = false;
function shutdown(signal: string): void {
  if (stopping) return;
  stopping = true;
  server.close(() => {
    store.close();
    console.log(JSON.stringify({ event: "consumer_stopped", signal }));
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
server.listen(port, () => console.log(JSON.stringify({ event: "consumer_started", port, version: VERSION })));

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing_${name.toLowerCase()}`);
  return value;
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid_consumer_port");
  return port;
}
