// Uptime monitor: after the request is sent, sends it again every INTERVAL
// seconds, logging each check, then sums up latency and failures.
//
// Paste it into a request's Post-response field in "Edit Scripts" and use
// "Send with Scripts". The report opens when the run ends. With RUNS = 0 it
// runs until you use the workspace action "Stop Scripts"; the report then has
// every check but no summary.
//
// Repeats the method, URL, enabled headers, and text body. Query parameters
// from the Params table and the Auth tab are not repeated.

const RUNS = 30; // how many checks after the first (0 = until stopped)
const INTERVAL = 10; // seconds between checks
const SLOW_MS = 1000; // a check slower than this counts as slow
const EXPECTED_STATUS = 200;

// A run takes RUNS * INTERVAL seconds, more than the default limit of 30 s
yk.timeout(0);

const options = {
  url: yk.request.url,
  method: yk.request.method,
  header: yk.request.headers.toObject(),
};
if (yk.request.body.raw !== undefined) {
  options.body = { mode: "raw", raw: yk.request.body.raw };
}

const times = [];
let failures = 0;

function record(check, code, ms) {
  times.push(ms);
  const ok = code === EXPECTED_STATUS;
  if (!ok) failures++;
  const flag = !ok ? "  FAILED" : ms > SLOW_MS ? "  SLOW" : "";
  console.log(`#${check} ${new Date().toISOString()} ${code} ${ms}ms${flag}`);
}

record(0, yk.response.code, yk.response.responseTime);

for (let check = 1; RUNS === 0 || check <= RUNS; check++) {
  await yk.sleep(INTERVAL * 1000);
  try {
    const res = await yk.sendRequest(options);
    record(check, res.code, res.responseTime);
  } catch (err) {
    failures++;
    console.warn(`#${check} ${new Date().toISOString()} ${err.message}  FAILED`);
  }
}

const sorted = [...times].sort((a, b) => a - b);
const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
const average = Math.round(sorted.reduce((sum, t) => sum + t, 0) / sorted.length);
console.log(
  `\n${RUNS + 1} checks · ${failures} failed · min ${sorted[0]}ms · avg ${average}ms · p95 ${p95}ms · max ${sorted[sorted.length - 1]}ms`,
);

yk.test(`every check returned ${EXPECTED_STATUS}`, () => {
  yk.expect(failures).to.equal(0);
});
yk.test(`p95 under ${SLOW_MS}ms`, () => {
  yk.expect(p95).to.be.below(SLOW_MS);
});
