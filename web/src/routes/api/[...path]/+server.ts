import { env } from "$env/dynamic/private";
import type { RequestHandler } from "./$types";

const allowed = [
  { method: "GET", pattern: /^v1\/work-queue$/ },
  { method: "GET", pattern: /^v1\/cases\/[A-Za-z0-9-]+\/review-context$/ },
  { method: "POST", pattern: /^v1\/cases\/[A-Za-z0-9-]+\/approve$/ }
] as const;

function isAllowed(method: string, path: string): boolean {
  return allowed.some((route) => route.method === method && route.pattern.test(path));
}

const proxy: RequestHandler = async ({ params, request, fetch }) => {
  const path = params.path ?? "";
  if (!isAllowed(request.method, path)) {
    return Response.json({ errors: [{ code: "review_proxy_route_not_allowed" }] }, { status: 404 });
  }

  const base = env.RXFLOW_API_BASE?.trim() || "http://127.0.0.1:8080";
  let origin: URL;
  try {
    origin = new URL(base);
  } catch {
    return Response.json({ errors: [{ code: "review_proxy_configuration_error" }] }, { status: 503 });
  }

  if (origin.protocol !== "http:" && origin.protocol !== "https:") {
    return Response.json({ errors: [{ code: "review_proxy_configuration_error" }] }, { status: 503 });
  }

  const target = new URL(`/${path}`, origin);
  const headers = new Headers();
  for (const name of ["authorization", "if-match", "content-type", "x-correlation-id"] as const) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }

  try {
    const upstream = await fetch(target, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.text(),
      redirect: "manual"
    });
    const responseHeaders = new Headers({
      "content-type": upstream.headers.get("content-type") ?? "application/json; charset=utf-8",
      "cache-control": "no-store"
    });
    for (const name of ["etag", "x-correlation-id"] as const) {
      const value = upstream.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }
    return new Response(await upstream.arrayBuffer(), {
      status: upstream.status,
      headers: responseHeaders
    });
  } catch {
    return Response.json(
      { errors: [{ code: "review_proxy_upstream_unavailable", detail: "The synthetic review API is unavailable." }] },
      { status: 502, headers: { "cache-control": "no-store" } }
    );
  }
};

export const GET = proxy;
export const POST = proxy;
