import { isIP } from "node:net";

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

const MULTI_LABEL_PUBLIC_SUFFIXES = new Set([
  "co.uk",
  "org.uk",
  "gov.uk",
  "ac.uk",
  "com.au",
  "net.au",
  "org.au",
  "edu.au",
  "co.nz",
  "co.jp",
  "ne.jp",
  "or.jp",
  "com.br",
  "com.mx",
  "com.tr",
  "com.hk",
  "com.sg",
  "com.tw",
  "co.in",
  "co.kr",
]);

function maybeDecode(value: string | null): string | undefined {
  if (!value) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export type UrlAnalysis = {
  url: string;
  originalUrl: string;
  flags: string[];
};

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
  cleaned = cleaned.replace(/SECURITY NOTICE:[\s\S]*?(?=<<<[A-Z0-9_:-]+ id="[^"]+">>>)/g, "");
  cleaned = cleaned.replace(/<<<[A-Z0-9_:-]+ id="[^"]+">>>/g, "");
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

function unwrapKnownRedirectUrl(rawUrl: string): { url: string; unwrapped: boolean } {
  try {
    const parsed = new URL(rawUrl.trim());
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname;

    if ((host === "duckduckgo.com" || host === "www.duckduckgo.com") && path.startsWith("/l/")) {
      const uddg = maybeDecode(parsed.searchParams.get("uddg"));
      if (uddg) return { url: uddg, unwrapped: true };
    }

    if (
      ["www.google.com", "google.com", "l.google.com", "googleadservices.com", "www.googleadservices.com"].includes(host) &&
      (path === "/url" || path === "/pagead/aclk")
    ) {
      const q = maybeDecode(parsed.searchParams.get("q")) ?? maybeDecode(parsed.searchParams.get("url")) ?? maybeDecode(parsed.searchParams.get("adurl"));
      if (q) return { url: q, unwrapped: true };
    }

    if ((host === "l.facebook.com" || host === "lm.facebook.com") && path === "/l.php") {
      const u = maybeDecode(parsed.searchParams.get("u"));
      if (u) return { url: u, unwrapped: true };
    }
  } catch {
    // ignore
  }

  return { url: rawUrl.trim(), unwrapped: false };
}

export function analyzeUrl(rawUrl: string): UrlAnalysis {
  const originalUrl = rawUrl.trim();
  const flags = new Set<string>();
  const unwrapped = unwrapKnownRedirectUrl(originalUrl);
  if (unwrapped.unwrapped) {
    flags.add("redirect-wrapper");
  }

  try {
    const parsed = new URL(unwrapped.url);
    parsed.hash = "";
    let strippedTracking = false;
    for (const key of [...parsed.searchParams.keys()]) {
      if (TRACKING_PARAMS.has(key.toLowerCase())) {
        parsed.searchParams.delete(key);
        strippedTracking = true;
      }
    }
    if (strippedTracking) {
      flags.add("tracking-stripped");
    }
    parsed.hostname = parsed.hostname.toLowerCase();
    if (parsed.pathname !== "/") {
      parsed.pathname = parsed.pathname.replace(/\/$/, "");
    }

    return {
      url: parsed.toString(),
      originalUrl,
      flags: [...flags].sort(),
    };
  } catch {
    return {
      url: unwrapped.url.trim(),
      originalUrl,
      flags: [...flags].sort(),
    };
  }
}

export function canonicalizeUrl(rawUrl: string): string {
  return analyzeUrl(rawUrl).url;
}

function resolveDomainFamilyFromHostname(hostname: string): string {
  const normalized = hostname.trim().toLowerCase().replace(/^www\./, "");
  if (!normalized) return hostname;

  if (normalized === "localhost" || isIP(normalized) !== 0) {
    return normalized;
  }

  const labels = normalized.split(".").filter(Boolean);
  if (labels.length <= 2) {
    return normalized;
  }

  const suffix = labels.slice(-2).join(".");
  if (MULTI_LABEL_PUBLIC_SUFFIXES.has(suffix) && labels.length >= 3) {
    return labels.slice(-3).join(".");
  }

  return labels.slice(-2).join(".");
}

export function resolveDomainFamily(rawUrl: string): string | undefined {
  try {
    const parsed = new URL(rawUrl);
    return resolveDomainFamilyFromHostname(parsed.hostname);
  } catch {
    return undefined;
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
