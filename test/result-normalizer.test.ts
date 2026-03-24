import test from "node:test";
import assert from "node:assert/strict";
import { normalizeProviderPayload } from "../src/result-normalizer.js";

test("normalizeProviderPayload maps structured results", () => {
  const normalized = normalizeProviderPayload({
    providerId: "brave",
    payload: {
      results: [
        {
          title: "OpenClaw Docs",
          url: "https://docs.openclaw.ai/tools/web?utm_source=test",
          description: "Web search docs",
        },
      ],
    },
  });

  assert.equal(normalized.error, undefined);
  assert.equal(normalized.results.length, 1);
  assert.equal(normalized.results[0]?.canonicalUrl, "https://docs.openclaw.ai/tools/web");
  assert.equal(normalized.results[0]?.title, "OpenClaw Docs");
  assert.equal(normalized.results[0]?.snippet, "Web search docs");
});

test("normalizeProviderPayload extracts answer-backed citations", () => {
  const normalized = normalizeProviderPayload({
    providerId: "gemini",
    payload: {
      content: "SECURITY NOTICE: ignored\n\n<<<EXTERNAL_CONTENT_START id=\"1\">>>\nSource: Web Search\n---\nA synthetic answer about OpenClaw.\n<<<EXTERNAL_CONTENT_END id=\"1\">>>",
      citations: ["https://docs.openclaw.ai/", { url: "https://github.com/openclaw/openclaw", title: "GitHub" }],
    },
  });

  assert.equal(normalized.answer?.providerId, "gemini");
  assert.match(normalized.answer?.summary ?? "", /synthetic answer/i);
  assert.equal(normalized.results.length, 2);
  assert.equal(normalized.results[0]?.sourceType, "citations");
  assert.equal(normalized.results[1]?.title, "GitHub");
});

test("normalizeProviderPayload surfaces provider error when nothing usable returned", () => {
  const normalized = normalizeProviderPayload({
    providerId: "grok",
    payload: {
      error: "missing_xai_api_key",
      message: "Set XAI_API_KEY",
    },
  });

  assert.equal(normalized.results.length, 0);
  assert.match(normalized.error ?? "", /missing_xai_api_key/);
});

test("normalizeProviderPayload handles Exa-style structured results", () => {
  const normalized = normalizeProviderPayload({
    providerId: "exa",
    payload: {
      results: [
        {
          title: "OpenClaw Web Search",
          url: "https://docs.openclaw.ai/tools/web?utm_campaign=exa",
          description: "Neural result summary",
          summary: "Longer summary that should be ignored in favor of description",
          highlightScores: [0.9, 0.7],
        },
      ],
    },
  });

  assert.equal(normalized.results.length, 1);
  assert.equal(normalized.results[0]?.canonicalUrl, "https://docs.openclaw.ai/tools/web");
  assert.equal(normalized.results[0]?.snippet, "Neural result summary");
});

test("normalizeProviderPayload handles answer-first providers like Kimi/Grok/Perplexity sonar", () => {
  const normalized = normalizeProviderPayload({
    providerId: "kimi",
    payload: {
      content: "Grounded synthesis about OpenClaw search.",
      citations: [
        { url: "https://docs.openclaw.ai/tools/web", title: "Docs" },
        "https://github.com/openclaw/openclaw",
      ],
    },
  });

  assert.equal(normalized.answer?.providerId, "kimi");
  assert.equal(normalized.results.length, 2);
  assert.ok(normalized.results.every((result) => result.sourceType === "citations"));
});

test("normalizeProviderPayload handles nested web.results payloads", () => {
  const normalized = normalizeProviderPayload({
    providerId: "perplexity",
    payload: {
      web: {
        results: [
          {
            title: "OpenClaw Docs",
            url: "https://docs.openclaw.ai/tools/web",
            snippet: "Nested web result",
          },
        ],
      },
    },
  });

  assert.equal(normalized.results.length, 1);
  assert.equal(normalized.results[0]?.sourceType, "results");
  assert.equal(normalized.results[0]?.snippet, "Nested web result");
});

test("normalizeProviderPayload handles sources arrays from research-style providers", () => {
  const normalized = normalizeProviderPayload({
    providerId: "firecrawl",
    payload: {
      sources: [
        {
          title: "Firecrawl blog",
          url: "https://www.firecrawl.dev/blog/openclaw-web-search",
          description: "Search pipeline article",
        },
      ],
    },
  });

  assert.equal(normalized.results.length, 1);
  assert.equal(normalized.results[0]?.sourceType, "sources");
  assert.equal(normalized.results[0]?.title, "Firecrawl blog");
});
