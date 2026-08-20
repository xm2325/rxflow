export const JSON_SECURITY_HEADERS: Record<string, string> = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cross-origin-resource-policy": "same-origin"
};

export const HTML_SECURITY_HEADERS: Record<string, string> = {
  ...JSON_SECURITY_HEADERS,
  "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; object-src 'none'",
  "x-frame-options": "DENY"
};

export function responseHeaders(
  contentType: string,
  correlationId?: string,
  extra: Record<string, string> = {},
  html = false
): Record<string, string> {
  return {
    ...(html ? HTML_SECURITY_HEADERS : JSON_SECURITY_HEADERS),
    "content-type": contentType,
    ...(correlationId ? { "x-correlation-id": correlationId } : {}),
    ...extra
  };
}
