// scripts/stress-test.mjs
const DEFAULT_URL = "https://ctl-syllabus-builder.vercel.app";
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
  steps: { terms: [], courseSearch: [], sectionSearch: [], details: [] },
  statusCodes: {},
  silentEmptyBlocks: 0,
  networkErrors: 0,
  sampleErrors: [],
};

function recordStatus(code) {
  metrics.statusCodes[code] = (metrics.statusCodes[code] || 0) + 1;
}

function recordError(msg) {
  if (metrics.sampleErrors.length < 10 && !metrics.sampleErrors.includes(msg)) {
    metrics.sampleErrors.push(msg);
  }
}

async function timedFetch(url, options = {}) {
  const start = performance.now();
  try {
    const res = await fetch(url, { ...options, signal: AbortSignal.timeout(30000) });
    const text = await res.text();
    const duration = performance.now() - start;
    recordStatus(res.status);

    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      recordError(`Non-JSON (${res.status}) on ${url}: ${text.slice(0, 60)}`);
    }

    if (!res.ok) {
      recordError(`HTTP ${res.status} on ${url}: ${json?.error || text.slice(0, 60)}`);
    }
    return { ok: res.ok, status: res.status, json, duration };
  } catch (err) {
    const duration = performance.now() - start;
    metrics.networkErrors++;
    recordError(`Network/Timeout on ${url}: ${err.message}`);
    return { ok: false, status: "ERR", json: null, duration };
  }
}

async function simulateProfessor(userId) {
  await sleep(Math.random() * STAGGER_WINDOW_MS);
  const pick = SAMPLE_COURSES[userId % SAMPLE_COURSES.length];

  // 1. Terms lookup
  const termsRes = await timedFetch(`${BASE_URL}/api/banner?action=terms`);
  metrics.steps.terms.push(termsRes.duration);
  if (!termsRes.ok || !termsRes.json) return;

  const term = termsRes.json.current || termsRes.json.terms?.[0] || "Spring 2027";
  await sleep(300 + Math.random() * 600);

  // 2. Course search
  const courseUrl = `${BASE_URL}/api/banner?action=course-search&term=${encodeURIComponent(term)}&subject=${pick.subject}&q=${pick.number.slice(0, 2)}`;
  const courseRes = await timedFetch(courseUrl);
  metrics.steps.courseSearch.push(courseRes.duration);
  if (!courseRes.ok || !courseRes.json) return;

  if (Array.isArray(courseRes.json.courses) && courseRes.json.courses.length === 0) {
    metrics.silentEmptyBlocks++;
    return;
  }

  await sleep(400 + Math.random() * 600);

  // 3. Section search
  const sectionUrl = `${BASE_URL}/api/banner?action=section-search&term=${encodeURIComponent(term)}&subject=${pick.subject}&courseNumber=${pick.number}`;
  const sectionRes = await timedFetch(sectionUrl);
  metrics.steps.sectionSearch.push(sectionRes.duration);
  if (!sectionRes.ok || !sectionRes.json) return;

  const sections = sectionRes.json.sections || [];
  if (sections.length === 0) {
    metrics.silentEmptyBlocks++;
    return;
  }

  // 4. Full details POST
  const chosenSection = sections[0].section;
  const detailsRes = await timedFetch(`${BASE_URL}/api/banner?action=details`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      term,
      subject: pick.subject,
      courseNumber: pick.number,
      section: chosenSection,
    }),
  });
  metrics.steps.details.push(detailsRes.duration);
}

function summarizeLatencies(arr) {
  if (!arr.length) return "no samples";
  const sorted = [...arr].sort((a, b) => a - b);
  const avg = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  const p50 = sorted[Math.floor(sorted.length * 0.5)];
  const p95 = sorted[Math.floor(sorted.length * 0.95)];
  const max = sorted[sorted.length - 1];
  return `count=${sorted.length} | avg=${Math.round(avg)}ms | p50=${Math.round(p50)}ms | p95=${Math.round(p95)}ms | max=${Math.round(max)}ms`;
}

async function run() {
  console.log(`Starting stress test: ${CONCURRENT_USERS} simulated professors -> ${BASE_URL}`);
  console.log(`Arrival window: ${STAGGER_WINDOW_MS}ms\n`);

  const suiteStart = performance.now();
  await Promise.all(Array.from({ length: CONCURRENT_USERS }, (_, i) => simulateProfessor(i)));
  const totalSec = ((performance.now() - suiteStart) / 1000).toFixed(2);

  console.log("=== STRESS TEST RESULTS ===");
  console.log(`Total elapsed time:      ${totalSec}s`);
  console.log(`HTTP Status breakdown:   ${JSON.stringify(metrics.statusCodes)}`);
  console.log(`Network/Timeout errors:  ${metrics.networkErrors}`);
  console.log(`Silent Banner blocks:    ${metrics.silentEmptyBlocks} (200 OK with empty [])`);
  console.log("\nLatency by Step:");
  console.log(`  1. Terms lookup:       ${summarizeLatencies(metrics.steps.terms)}`);
  console.log(`  2. Course search:      ${summarizeLatencies(metrics.steps.courseSearch)}`);
  console.log(`  3. Section search:     ${summarizeLatencies(metrics.steps.sectionSearch)}`);
  console.log(`  4. Full details POST:  ${summarizeLatencies(metrics.steps.details)}`);

  if (metrics.sampleErrors.length) {
    console.log("\nSample Errors:");
    metrics.sampleErrors.forEach((e) => console.log(`  - ${e}`));
  }

  const serverErrors = Object.entries(metrics.statusCodes)
    .filter(([code]) => Number(code) >= 400)
    .reduce((sum, [, count]) => sum + count, 0);

  console.log("\nVerdict:");
  if (metrics.silentEmptyBlocks > 0 || metrics.networkErrors > 0 || serverErrors > 0) {
    console.log("  FAIL: Banner throttled or timed out under load.");
    process.exitCode = 1;
  } else {
    console.log("  PASS: All simulated users completed without throttling or timeouts.");
  }
}

run();