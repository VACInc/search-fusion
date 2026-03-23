const TRACKING_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utm_id",
  "gclid",
  "fbclid",
  "mc_cid",
  "mc_eid",
  "ref",
]);

export function asSingleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function truncate(value: string, max = 220): string {
  const normalized = asSingleLine(value);
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export function stripExternalWrapper(content: string): string {
  let cleaned = content;
  cleaned = cleaned.replace(/SECURITY NOTICE:[\s\S]*?(?=<<<[A-Z0-9_:-]+ id=\"[^\"]+\">>>)/g, "");
  cleaned = cleaned.replace(/<<<[A-Z0-9_:-]+ id=\"[^\"]+\">>>/g, "");
  const markerIndex = cleaned.indexOf("\n---\n");
  if (/\bSource:\b/.test(cleaned) && markerIndex >= 0) {
    cleaned = cleaned.slice(markerIndex + 5);
  }
  return cleaned.trim();
}

export function cleanProviderText(value: unknown): string {
  if (typeof value !== "string") return "";
  return asSingleLine(stripExternalWrapper(value));
}

export function canonicalizeUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    parsed.hash = "";
    for (const key of [...parsed.searchParams.keys()]) {
      if (TRACKING_PARAMS.has(key.toLowerCase())) {
        parsed.searchParams.delete(key);
      }
    }
    parsed.hostname = parsed.hostname.toLowerCase();
    if (parsed.pathname !== "/") {
      parsed.pathname = parsed.pathname.replace(/\/$/, "");
    }
    return parsed.toString();
  } catch {
    return rawUrl.trim();
  }
}

export function resolveSiteName(rawUrl: string): string | undefined {
  try {
    const parsed = new URL(rawUrl);
    return parsed.hostname.replace(/^www\./i, "");
  } catch {
    return undefined;
  }
}
