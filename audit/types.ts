/**
 * Audit kit types for reproducible Search Fusion reruns.
 *
 * An AuditRecord wraps a FusionSearchPayload with the exact request params
 * and enough metadata to replay the same query and compare results later.
 */

import type { FusionSearchPayload, ProviderSelectionRequest, SearchFusionConfig } from "../src/types.js";

/** Identifies the version of the audit schema for forward-compat checks. */
export const AUDIT_SCHEMA_VERSION = 1;

/**
 * Severity level for a source caveat surfaced during audit review.
 * - info: informational note, no action needed
 * - warn: degraded quality, worth noting before relying on results
 * - error: something went wrong (provider failure, auth error, timeout)
 */
export type CaveatSeverity = "info" | "warn" | "error";

/** A single caveat or quality note about a source or result set. */
export type AuditCaveat = {
  severity: CaveatSeverity;
  code: string;
  message: string;
  /** Provider id, result url, or other relevant target. */
  target?: string;
};

/**
 * Source quality summary for a single provider run captured in the audit.
 */
export type AuditProviderSummary = {
  provider: string;
  configured: boolean;
  ok: boolean;
  rawCount: number;
  tookMs: number;
  attempts: number;
  error?: string;
  /** Fraction of results that carried at least one quality flag (sponsored/community/video/redirect-wrapper). */
  flaggedResultFraction: number;
  /** Flags seen at least once in the provider's results. */
  observedFlags: string[];
  caveats: AuditCaveat[];
};

/**
 * A complete, self-contained audit record for a Search Fusion query run.
 * Can be serialized to JSON for storage, then loaded later to rerun or review.
 */
export type AuditRecord = {
  /** Schema version for forward-compat. */
  schemaVersion: typeof AUDIT_SCHEMA_VERSION;

  /** ISO-8601 timestamp of when the query was captured. */
  capturedAt: string;

  /** Optional human label to identify this audit record. */
  label?: string;

  /**
   * The exact request parameters used in this run.
   * Replay with these params to get a comparable result.
   */
  request: ProviderSelectionRequest;

  /**
   * The plugin config that was active at capture time.
   * Replay with this config to reproduce provider selection and retry behavior.
   */
  pluginConfig: SearchFusionConfig;

  /** Top-level outcome summary. */
  summary: {
    tookMs: number;
    mergedResultCount: number;
    providersQueried: string[];
    providersSucceeded: string[];
    providersFailed: Array<{ provider: string; error: string }>;
    answerProviders: string[];
  };

  /** Per-provider quality summaries and caveats. */
  providerSummaries: AuditProviderSummary[];

  /** Top-level caveats across the whole run. */
  caveats: AuditCaveat[];

  /** The full payload from the original run. Store and diff against reruns. */
  payload: FusionSearchPayload;
};

/**
 * Input for createAuditRecord.
 */
export type CreateAuditRecordParams = {
  payload: FusionSearchPayload;
  request: ProviderSelectionRequest;
  pluginConfig?: SearchFusionConfig;
  label?: string;
  /** Override timestamp (ISO-8601). Defaults to now. */
  capturedAt?: string;
};
