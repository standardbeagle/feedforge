/**
 * Subscriber-side conditional GET. feedforge already speaks If-None-Match to the
 * origin; this is the other half — letting a reader skip the body when its copy is
 * current, which is where nearly all of a feed's bandwidth goes.
 */

export async function sha256hex(data: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Representations of the same feed differ byte-for-byte, so the format is part of
 * the tag — otherwise a reader's RSS validator would suppress an Atom body.
 */
export function etagFor(contentHash: string, format: string): string {
  return `"${contentHash.slice(0, 32)}-${format}"`;
}

/** RFC 9110: `*` matches anything, otherwise any tag in the list, ignoring weak prefixes. */
function ifNoneMatchSatisfied(header: string, etag: string): boolean {
  const trimmed = header.trim();
  if (trimmed === "*") return true;
  const normalize = (t: string) => t.trim().replace(/^W\//, "");
  return trimmed.split(",").some((t) => normalize(t) === normalize(etag));
}

/**
 * True when the reader's cached copy is still good. If-None-Match wins outright when
 * present; If-Modified-Since is only consulted in its absence, per RFC 9110.
 */
export function isNotModified(request: Request, etag: string, lastModified: string | null): boolean {
  const inm = request.headers.get("if-none-match");
  if (inm !== null) return ifNoneMatchSatisfied(inm, etag);

  const ims = request.headers.get("if-modified-since");
  if (ims === null || lastModified === null) return false;
  const since = Date.parse(ims);
  const built = Date.parse(lastModified);
  if (Number.isNaN(since) || Number.isNaN(built)) return false;
  // HTTP dates have second resolution; the stored timestamp does not.
  return Math.floor(built / 1000) <= Math.floor(since / 1000);
}
