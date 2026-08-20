export type PublicSurfaceFormat = "markdown" | "html";

function normaliseReference(raw: string): string {
  return raw.trim().replace(/^<|>$/g, "").split("#", 1)[0].split("?", 1)[0];
}

export function isLocalRepositoryReference(raw: string): boolean {
  const ref = normaliseReference(raw);
  if (!ref || ref.startsWith("#")) return false;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(ref)) return false;
  if (ref.startsWith("//")) return false;
  return true;
}

export function extractLocalRepositoryReferences(text: string, format: PublicSurfaceFormat): string[] {
  const refs: string[] = [];
  const pattern = format === "markdown"
    ? /\[[^\]]*\]\(([^)]+)\)/g
    : /(?:href|src)=["']([^"']+)["']/g;

  for (const match of text.matchAll(pattern)) {
    const raw = match[1] ?? "";
    if (!isLocalRepositoryReference(raw)) continue;
    const ref = normaliseReference(raw);
    if (ref) refs.push(ref);
  }
  return refs;
}
