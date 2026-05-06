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
function maybeDecode(value) {
    if (!value)
        return undefined;
    try {
        return decodeURIComponent(value);
    }
    catch {
        return value;
    }
}
export function asSingleLine(value) {
    return value.replace(/\s+/g, " ").trim();
}
export function truncate(value, max = 220) {
    const normalized = asSingleLine(value);
    if (normalized.length <= max)
        return normalized;
    return `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}
export function stripExternalWrapper(content) {
    let cleaned = content;
    cleaned = cleaned.replace(/SECURITY NOTICE:[\s\S]*?(?=<<<[A-Z0-9_:-]+ id="[^"]+">>>)/g, "");
    cleaned = cleaned.replace(/<<<[A-Z0-9_:-]+ id="[^"]+">>>/g, "");
    const markerIndex = cleaned.indexOf("\n---\n");
    if (/\bSource:\b/.test(cleaned) && markerIndex >= 0) {
        cleaned = cleaned.slice(markerIndex + 5);
    }
    return cleaned.trim();
}
export function cleanProviderText(value) {
    if (typeof value !== "string")
        return "";
    return asSingleLine(stripExternalWrapper(value));
}
function unwrapKnownRedirectUrl(rawUrl) {
    try {
        const parsed = new URL(rawUrl.trim());
        const host = parsed.hostname.toLowerCase();
        const path = parsed.pathname;
        if ((host === "duckduckgo.com" || host === "www.duckduckgo.com") && path.startsWith("/l/")) {
            const uddg = maybeDecode(parsed.searchParams.get("uddg"));
            if (uddg)
                return { url: uddg, unwrapped: true };
        }
        if (["www.google.com", "google.com", "l.google.com", "googleadservices.com", "www.googleadservices.com"].includes(host) &&
            (path === "/url" || path === "/pagead/aclk")) {
            const q = maybeDecode(parsed.searchParams.get("q")) ?? maybeDecode(parsed.searchParams.get("url")) ?? maybeDecode(parsed.searchParams.get("adurl"));
            if (q)
                return { url: q, unwrapped: true };
        }
        if ((host === "l.facebook.com" || host === "lm.facebook.com") && path === "/l.php") {
            const u = maybeDecode(parsed.searchParams.get("u"));
            if (u)
                return { url: u, unwrapped: true };
        }
    }
    catch {
        // ignore
    }
    return { url: rawUrl.trim(), unwrapped: false };
}
export function analyzeUrl(rawUrl) {
    const originalUrl = rawUrl.trim();
    const flags = new Set();
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
    }
    catch {
        return {
            url: unwrapped.url.trim(),
            originalUrl,
            flags: [...flags].sort(),
        };
    }
}
export function canonicalizeUrl(rawUrl) {
    return analyzeUrl(rawUrl).url;
}
export function resolveSiteName(rawUrl) {
    try {
        const parsed = new URL(rawUrl);
        return parsed.hostname.replace(/^www\./i, "");
    }
    catch {
        return undefined;
    }
}
