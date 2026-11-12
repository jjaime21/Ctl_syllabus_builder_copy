// scripts/stress-test-json.mjs
// Simulates concurrent faculty loading the app and running static JSON catalog autofill.

const DEFAULT_URL = "https://ctl-syllabus-builder-copy-git-issue188-josejaime422-6954.vercel.app";
const BASE_URL = (process.argv[2] || DEFAULT_URL).replace(/\/$/, "");
const CONCURRENT_USERS = Number(process.argv[3] || 15);
const STAGGER_WINDOW_MS = Number(process.argv[4] || 15000);

const SAMPLE_COURSES = [
  { subject: "CSCI", number: "101" },
  { subject: "ENGL", number: "111" },
  { subject: "MATH", number: "140" },
  { subject: "BIOL", number: "110" },
  { subject: "HIST", number: "201" },
  { subject: "PSYC", number: "101" },
  { subject: "POSC", number: "322" },
  { subject: "CHEM", number: "121" },
  { subject: "ACCT", number: "201" },
  { subject: "MATH", number: "251" },
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const metrics = {
  steps: {
    pageLoad: [],
    catalogFetch: [],
    localAutofill: [],
  },
  statusCodes: {},
  emptyCatalogErrors: 0,
  networkErrors: 0,
  sampleErrors: [],
  catalogBytes: 0,
};

function recordStatus(code) {
  metrics.statusCodes[code] = (metrics.statusCodes[code] || 0) + 1;
}

function recordError(msg) {
  if (metrics.sampleErrors.length < 10 && !metrics.sampleErrors.includes(msg)) {
    metrics.sampleErrors.push(msg);
  }
}

async function timedFetch(url) {
  const start = performance.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
    const text = await res.text();
    const duration = performance.now() - start;
    recordStatus(res.status);

    if (!res.ok) {
      recordError(`HTTP ${res.status} on ${url}: ${text.slice(0, 60)}`);
    }
    return { ok: res.ok, status: res.status, text, duration };
  } catch (err) {
    const duration = performance.now() - start;
    metrics.networkErrors++;
    recordError(`Network/Timeout on ${url}: ${err.message}`);
    return { ok: false, status: "ERR", text: "", duration };
  }
}

async function simulateProfessor(userId) {
  await sleep(Math.random() * STAGGER_WINDOW_MS);
  const pick = SAMPLE_COURSES[userId % SAMPLE_COURSES.length];

  // Step 1: Load initial HTML page
  const pageRes = await timedFetch(`${BASE_URL}/`);
  metrics.steps.pageLoad.push(pageRes.duration);
  if (!pageRes.ok) return;

  await sleep(200 + Math.random() * 400);

  // Step 2: Fetch static course catalog JSON
  const catalogUrl = `${BASE_URL}/utm_course_catalog_26_27.json`;
  const catRes = await timedFetch(catalogUrl);
  metrics.steps.catalogFetch.push(catRes.duration);
  if (!catRes.ok) return;

  metrics.catalogBytes = Math.max(metrics.catalogBytes, Buffer.byteLength(catRes.text, "utf8"));

  let catalog;
  try {
    catalog = JSON.parse(catRes.text);
  } catch {
    metrics.emptyCatalogErrors++;
    recordError(`Invalid JSON returned from ${catalogUrl}`);
    return;
  }

  // Step 3: Measure local in-memory course + section lookup
  const lookupStart = performance.now();
  const entries = Array.isArray(catalog) ? catalog : Object.values(catalog || {});
  if (entries.length === 0) {
    metrics.emptyCatalogErrors++;
    return;
  }

  const targetCode = `${pick.subject} ${pick.number}`;
  const matches = entries.filter((item) => {
    const code = String(item?.courseCode || item?.code || "").toUpperCase();
    return code.startsWith(pick.subject) || code === targetCode;
  });
  const lookupDuration = performance.now() - lookupStart;
  metrics.steps.localAutofill.push(lookupDuration);
}

function summarizeLatencies(arr) {
  if (!arr.length) return "no samples";
  const sorted = [...arr].sort((a, b) => a - b);
  const avg = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  const p50 = sorted[Math.floor(sorted.length * 0.5)];
  const p95 = sorted[Math.floor(sorted.length * 0.95)];
  const max = sorted[sorted.length - 1];
  return `count=${sorted.length} | avg=${avg.toFixed(1)}ms | p50=${p50.toFixed(1)}ms | p95=${p95.toFixed(1)}ms | max=${max.toFixed(1)}ms`;
}

async function run() {
  console.log(`Starting JSON stress test: ${CONCURRENT_USERS} simulated professors -> ${BASE_URL}`);
  console.log(`Arrival window: ${STAGGER_WINDOW_MS}ms\n`);

  const suiteStart = performance.now();
  await Promise.all(Array.from({ length: CONCURRENT_USERS }, (_, i) => simulateProfessor(i)));
  const totalSec = ((performance.now() - suiteStart) / 1000).toFixed(2);

  console.log("=== JSON STRESS TEST RESULTS ===");
  console.log(`Total elapsed time:      ${totalSec}s`);
  console.log(`Catalog payload size:    ${(metrics.catalogBytes / 1024).toFixed(1)} KB`);
  console.log(`HTTP Status breakdown:   ${JSON.stringify(metrics.statusCodes)}`);
  console.log(`Network/Timeout errors:  ${metrics.networkErrors}`);
  console.log(`Empty/Invalid catalog:   ${metrics.emptyCatalogErrors}`);
  console.log("\nLatency by Step:");
  console.log(`  1. HTML page load:     ${summarizeLatencies(metrics.steps.pageLoad)}`);
  console.log(`  2. JSON catalog fetch: ${summarizeLatencies(metrics.steps.catalogFetch)}`);
  console.log(`  3. Local autofill:     ${summarizeLatencies(metrics.steps.localAutofill)}`);

  if (metrics.sampleErrors.length) {
    console.log("\nSample Errors:");
    metrics.sampleErrors.forEach((e) => console.log(`  - ${e}`));
  }

  const serverErrors = Object.entries(metrics.statusCodes)
    .filter(([code]) => Number(code) >= 400)
    .reduce((sum, [, count]) => sum + count, 0);

  console.log("\nVerdict:");
  if (metrics.emptyCatalogErrors > 0 || metrics.networkErrors > 0 || serverErrors > 0) {
    console.log("  FAIL: Static JSON load test encountered errors.");
    process.exitCode = 1;
  } else {
    console.log("  PASS: All simulated users loaded and filtered the static JSON catalog cleanly.");
  }
}

run();