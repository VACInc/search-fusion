#!/usr/bin/env node

import process from 'node:process';

function parseArgs(argv) {
  const args = {
    packageName: '@vacinc/search-fusion',
    ownerHandle: 'vacinc',
    sourceRepo: 'VACInc/openclaw-search-fusion',
    query: 'search-fusion',
    timeoutMs: 20000,
    strictIndex: false,
    json: false,
  };

  for (const arg of argv) {
    if (arg === '--strict-index') args.strictIndex = true;
    else if (arg === '--json') args.json = true;
    else if (arg.startsWith('--package=')) args.packageName = arg.slice('--package='.length);
    else if (arg.startsWith('--owner=')) args.ownerHandle = arg.slice('--owner='.length);
    else if (arg.startsWith('--source-repo=')) args.sourceRepo = arg.slice('--source-repo='.length);
    else if (arg.startsWith('--query=')) args.query = arg.slice('--query='.length);
    else if (arg.startsWith('--timeout-ms=')) args.timeoutMs = Number(arg.slice('--timeout-ms='.length));
    else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: node scripts/verify-clawhub-visibility.mjs [options]\n\nOptions:\n  --package=<name>       Package name (default: @vacinc/search-fusion)\n  --owner=<handle>       Expected owner handle (default: vacinc)\n  --source-repo=<repo>   Expected source repo (default: VACInc/openclaw-search-fusion)\n  --query=<text>         Search query for plugins listing (default: search-fusion)\n  --timeout-ms=<ms>      Request timeout in milliseconds (default: 20000)\n  --strict-index         Fail if query listing does not include the package\n  --json                 Print machine-readable JSON output\n  -h, --help             Show this help message`);
      process.exit(0);
    }
  }

  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs < 1000) {
    throw new Error('Invalid --timeout-ms value. Use a number >= 1000.');
  }

  return args;
}

async function fetchText(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'user-agent': 'openclaw-search-fusion-clawhub-visibility-check/1.0',
      },
    });
    const text = await response.text();
    const normalizedText = text.replaceAll('\u0000', '');
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      text,
      normalizedText,
      finalUrl: response.url,
    };
  } finally {
    clearTimeout(timer);
  }
}

function createCheck(id, required, pass, details) {
  return { id, required, pass, details };
}

function printHuman(summary) {
  console.log(`ClawHub visibility check for ${summary.packageName}`);
  console.log(`Checked at: ${summary.checkedAt}`);
  console.log(`Package URL: ${summary.urls.packageUrl}`);
  console.log(`Query URL:   ${summary.urls.queryUrl}`);
  console.log('');

  for (const check of summary.checks) {
    const icon = check.pass ? '✅' : check.required ? '❌' : '⚠️';
    const scope = check.required ? 'required' : 'optional';
    console.log(`${icon} [${scope}] ${check.id}: ${check.details}`);
  }

  console.log('');
  if (summary.ok) {
    if (summary.indexedInQuery) {
      console.log('PASS: package is publicly visible and appears in query results.');
    } else {
      console.log('PASS (with caveat): package page is publicly visible, query-page indexing signal not confirmed.');
    }
  } else {
    console.log('FAIL: one or more required visibility checks failed.');
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const encoded = encodeURIComponent(args.packageName);
  const packageUrl = `https://clawhub.ai/plugins/${encoded}`;
  const queryUrl = `https://clawhub.ai/plugins?query=${encodeURIComponent(args.query)}`;

  const checks = [];

  const packageResp = await fetchText(packageUrl, args.timeoutMs);
  checks.push(
    createCheck(
      'package-page-http-200',
      true,
      packageResp.status === 200,
      `HTTP ${packageResp.status} ${packageResp.statusText}`
    )
  );

  const packageText = packageResp.normalizedText;

  const hasPackageName = packageText.includes(`name:"${args.packageName}"`);
  checks.push(
    createCheck(
      'package-name-present',
      true,
      hasPackageName,
      hasPackageName ? 'Found package name in page payload' : 'Package name not found in page payload'
    )
  );

  const hasOwnerHandle = packageText.includes(`handle:"${args.ownerHandle}"`);
  checks.push(
    createCheck(
      'owner-handle-present',
      true,
      hasOwnerHandle,
      hasOwnerHandle ? `Found owner handle ${args.ownerHandle}` : `Owner handle ${args.ownerHandle} not found`
    )
  );

  const hasSourceRepo = packageText.includes(`sourceRepo:"${args.sourceRepo}"`);
  checks.push(
    createCheck(
      'source-repo-present',
      false,
      hasSourceRepo,
      hasSourceRepo ? `Found source repo ${args.sourceRepo}` : `Source repo ${args.sourceRepo} not found`
    )
  );

  const hasCleanScan = packageText.includes('scanStatus:"clean"');
  checks.push(
    createCheck(
      'scan-status-clean',
      false,
      hasCleanScan,
      hasCleanScan ? 'Found scanStatus:"clean" in page payload' : 'scanStatus:"clean" not found in page payload'
    )
  );

  const queryResp = await fetchText(queryUrl, args.timeoutMs);
  const queryText = queryResp.normalizedText;
  checks.push(
    createCheck(
      'query-page-http-200',
      false,
      queryResp.status === 200,
      `HTTP ${queryResp.status} ${queryResp.statusText}`
    )
  );

  const queryRouteFound = [
    `pluginsplugins{\\\"query\\\":\\\"${args.query}\\\"}`,
    `pluginsplugins{\"query\":\"${args.query}\"}`,
  ].some((needle) => queryText.includes(needle));
  checks.push(
    createCheck(
      'query-route-loaded',
      false,
      queryRouteFound,
      queryRouteFound ? 'Query route payload found in page' : 'Query route payload not found in page'
    )
  );

  const indexedInQuery = queryText.includes(`name:"${args.packageName}"`);
  checks.push(
    createCheck(
      'package-present-in-query-page',
      args.strictIndex,
      indexedInQuery,
      indexedInQuery
        ? 'Package appears in query-page payload'
        : 'Package not found in query-page payload (could be indexing lag or ranking/pagination)'
    )
  );

  const requiredFailures = checks.filter((c) => c.required && !c.pass);
  const ok = requiredFailures.length === 0;

  const summary = {
    checkedAt: new Date().toISOString(),
    packageName: args.packageName,
    ownerHandle: args.ownerHandle,
    sourceRepo: args.sourceRepo,
    strictIndex: args.strictIndex,
    indexedInQuery,
    ok,
    urls: { packageUrl, queryUrl, packageFinalUrl: packageResp.finalUrl, queryFinalUrl: queryResp.finalUrl },
    checks,
  };

  if (args.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    printHuman(summary);
  }

  process.exit(ok ? 0 : 1);
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exit(1);
});
