/**
 * broker-cache.ts
 *
 * A simple, plugin-local, in-memory TTL cache for Search Fusion broker results.
 *
 * Design principles
 * -----------------
 * - Zero persistence: lives only for the lifetime of the OpenClaw process. All
 *   entries are lost on restart, so stale data is never a concern.
 * - Identical-request deduplication: the cache key is a deterministic,
 *   sorted JSON fingerprint of the full request (query + every filter param +
 *   the resolved provider list). Two requests that differ in any argument get
 *   distinct cache entries.
 * - Short TTL by default (30 s). Callers can raise it in plugin config but it
 *   is deliberately short so repeated agent tool calls within a conversation
 *   hit the cache while the data is still fresh, and fresh searches always
 *   work after the window expires.
 * - Bounded size: at most MAX_ENTRIES (default 128) entries. When the cap is
 *   reached the oldest entry (by insertion time) is evicted first.
 * - No background timers: stale entries are evicted lazily on get/set. This
 *   keeps the module free of side-effects at import time.
 * - Pure TypeScript, no external dependencies.
 */

import type { FusionSearchPayload, ProviderSelectionRequest } from "./types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type BrokerCacheConfig = {
  /** Whether the cache is enabled (default: true). */
  enabled?: boolean;
  /**
   * Time-to-live in seconds for a cached result.
   * Must be in [1, 600]. Default: 30.
   */
  ttlSeconds?: number;
  /**
   * Maximum number of entries kept in memory.
   * Must be in [1, 1024]. Default: 128.
   */
  maxEntries?: number;
};

export type CacheStats = {
  hits: number;
  misses: number;
  evictions: number;
  size: number;
};

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

type CacheEntry = {
  payload: FusionSearchPayload;
  expiresAt: number; // ms since epoch
  insertedAt: number; // ms since epoch, used for LRU eviction ordering
};

// ---------------------------------------------------------------------------
// Key building
// ---------------------------------------------------------------------------

/** Normalise a string: lower-case and trim whitespace. */
function norm(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

/** Normalise a sorted, de-duped provider list so order never matters. */
function normProviders(providers: string[] | undefined): string[] {
  if (!providers || providers.length === 0) return [];
  return [...new Set(providers.map(norm).filter(Boolean))].sort();
}

/**
 * Build a deterministic cache key from a request + resolved provider list.
 *
 * The resolved provider list is the final list that the broker actually
 * queries (after mode/default expansion). Including it in the key means two
 * requests with the same query but different mode/provider selections never
 * alias each other, while semantically identical requests that resolved to the
 * same provider set *do* share a cache entry.
 */
export function buildCacheKey(
  request: ProviderSelectionRequest,
  resolvedProviderIds: string[],
): string {
  const keyObj = {
    q: norm(request.query),
    providers: normProviders(resolvedProviderIds),
    count: request.count ?? null,
    maxMergedResults: request.maxMergedResults ?? null,
    country: norm(request.country),
    language: norm(request.language),
    freshness: norm(request.freshness),
    date_after: norm(request.date_after),
    date_before: norm(request.date_before),
    search_lang: norm(request.search_lang),
    ui_lang: norm(request.ui_lang),
  };
  return JSON.stringify(keyObj);
}

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

const DEFAULT_TTL_SECONDS = 30;
const DEFAULT_MAX_ENTRIES = 128;
const MIN_TTL_SECONDS = 1;
const MAX_TTL_SECONDS = 600;
const MIN_MAX_ENTRIES = 1;
const MAX_MAX_ENTRIES = 1024;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export type ResolvedCacheConfig = {
  enabled: boolean;
  ttlMs: number;
  maxEntries: number;
};

export function resolveCacheConfig(config: BrokerCacheConfig | undefined): ResolvedCacheConfig {
  return {
    enabled: config?.enabled !== false,
    ttlMs:
      clamp(
        (config?.ttlSeconds ?? DEFAULT_TTL_SECONDS),
        MIN_TTL_SECONDS,
        MAX_TTL_SECONDS,
      ) * 1000,
    maxEntries: clamp(
      config?.maxEntries ?? DEFAULT_MAX_ENTRIES,
      MIN_MAX_ENTRIES,
      MAX_MAX_ENTRIES,
    ),
  };
}

// ---------------------------------------------------------------------------
// BrokerCache class
// ---------------------------------------------------------------------------

export class BrokerCache {
  private readonly entries = new Map<string, CacheEntry>();
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  /**
   * Look up a cached result. Returns `undefined` on a miss or expired entry.
   * Expired entries are removed on lookup (lazy eviction).
   */
  get(key: string): FusionSearchPayload | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      this.misses += 1;
      return undefined;
    }
    if (Date.now() > entry.expiresAt) {
      this.entries.delete(key);
      this.evictions += 1;
      this.misses += 1;
      return undefined;
    }
    this.hits += 1;
    return entry.payload;
  }

  /**
   * Store a result. Evicts the oldest entry when the cap is reached, then
   * purges any additional expired entries found during that sweep.
   */
  set(key: string, payload: FusionSearchPayload, config: ResolvedCacheConfig): void {
    const now = Date.now();

    // Replace in-place without eviction logic if key already exists.
    if (this.entries.has(key)) {
      this.entries.set(key, { payload, expiresAt: now + config.ttlMs, insertedAt: now });
      return;
    }

    if (this.entries.size >= config.maxEntries) {
      this.evictOldest(now, config.maxEntries);
    }

    this.entries.set(key, { payload, expiresAt: now + config.ttlMs, insertedAt: now });
  }

  /**
   * Remove all entries whose TTL has expired. Useful for explicit sweeps in
   * tests; normal operation relies on lazy eviction in `get`.
   */
  purgeExpired(): number {
    const now = Date.now();
    let count = 0;
    for (const [key, entry] of this.entries) {
      if (now > entry.expiresAt) {
        this.entries.delete(key);
        this.evictions += 1;
        count += 1;
      }
    }
    return count;
  }

  /** Remove all entries unconditionally. */
  clear(): void {
    this.entries.clear();
  }

  /** Current number of entries (including not-yet-expired ones). */
  get size(): number {
    return this.entries.size;
  }

  /** Lifetime statistics for observability. */
  stats(): CacheStats {
    return {
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      size: this.entries.size,
    };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private evictOldest(now: number, maxEntries: number): void {
    let oldestKey: string | undefined;
    let oldestInsertedAt = Number.MAX_SAFE_INTEGER;

    for (const [key, entry] of this.entries) {
      // Eagerly evict any expired entries found during this sweep.
      if (now > entry.expiresAt) {
        this.entries.delete(key);
        this.evictions += 1;
        continue;
      }
      if (entry.insertedAt < oldestInsertedAt) {
        oldestInsertedAt = entry.insertedAt;
        oldestKey = key;
      }
    }

    // If the expired-entry sweep already brought size below the cap, we're done.
    if (this.entries.size < maxEntries) return;

    // Otherwise evict the oldest live entry to make room.
    if (oldestKey !== undefined) {
      this.entries.delete(oldestKey);
      this.evictions += 1;
    }
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton
// ---------------------------------------------------------------------------

/**
 * Module-level cache instance shared for the lifetime of the process.
 * Plugin code imports this directly; no global state leaks outside the module.
 */
export const brokerCache = new BrokerCache();
