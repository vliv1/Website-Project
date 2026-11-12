"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const backend = fs.readFileSync(path.join(__dirname, "../routes/security-watch.js"), "utf8");
const frontend = fs.readFileSync(path.join(__dirname, "../public/security-watch.js"), "utf8");
const TTL = 6 * 60 * 60 * 1000;
const plain = value => JSON.parse(JSON.stringify(value));
const product = (versions = ["1.2.3"], extra = {}) => ({
  id: "9d0c1a76-6ffa-4ddb-a4f4-272be773b623", name: "Widget", publisher: "Acme",
  versions, version_count: versions.length, ...extra
});
function criterion(extra = {}, parts = {}) {
  const fields = { part: "a", vendor: "acme", product: "widget", version: "*",
    update: "*", edition: "*", language: "*", sw_edition: "*", target_sw: "*", target_hw: "*", other: "*", ...parts };
  return { vulnerable: true, criteria: `cpe:2.3:${Object.values(fields).join(":")}`, ...extra };
}
const exact = (version = "1.2.3", extra = {}, parts = {}) => criterion(extra, { version, ...parts });
const orNode = matches => ({ operator: "OR", negate: false, cpeMatch: matches });
const cve = (...matches) => ({ id: "CVE-2026-12345", configurations: [{ nodes: [orNode(matches)] }] });
const fixture = cve(criterion({ versionStartIncluding: "1.0.0", versionEndExcluding: "2.0.0" }));

function harness(products = [product()], getNvd = () => ({ vulnerabilities: [{ cve: fixture }], totalResults: 1, startIndex: 0 }), env = {}, getDictionary = request => ({ products: [{ cpe: { deprecated: false, cpeName: request.url.searchParams.get("cpeMatchString") + ":*:*:*:*:*:*:*:*" } }] })) {
  let now = TTL + 1;
  let queryError = null;
  const queries = [], requests = [], delays = [], timers = [], errors = [];
  const handlers = new Map();
  const pool = { async query(sql, params) {
    queries.push({ sql, params });
    assert.match(sql.trim(), /^SELECT\b/i, "all DB operations must remain read-only");
    if (queryError) throw queryError;
    if (sql.includes("softtrack_audit_events")) return { rows: [{ updated_at: "2026-11-11T12:00:00Z" }] };
    if (/COUNT\(\*\).*FROM software_versions/.test(sql)) return { rows: [{ total: products.reduce((n, p) => n + p.version_count, 0) }] };
    if (/COUNT\(\*\)/.test(sql)) return { rows: [{ total: products.length }] };
    assert.match(sql, /ARRAY_AGG\(v\.version/);
    assert.match(sql, /v\.software_id = s\.id/);
    return { rows: products.slice(params[1], params[1] + params[0]) };
  } };
  class ClockDate extends Date { static now() { return now; } }
  const context = vm.createContext({
    require(name) {
      if (name === "express") return { Router: () => ({ get: (route, handler) => handlers.set(route, handler) }) };
      if (name === "../db") return pool;
      throw new Error(`Unexpected dependency: ${name}`);
    },
    module: { exports: {} }, URL, Date: ClockDate, process: { env },
    AbortSignal: { timeout: () => undefined },
    console: { error: (...args) => errors.push(args) },
    setTimeout(fn, ms) { delays.push(ms); queueMicrotask(fn); },
    setInterval(fn, ms) { const timer = { fn, ms, unref() {} }; timers.push(timer); return timer; },
    async fetch(url, options) {
      const request = { url: new URL(url), options };
      requests.push(request);
      const value = await (request.url.pathname.includes("/cpes/") ? getDictionary : getNvd)(request, requests.length);
      if (value.httpResponse) return value.httpResponse;
      return { ok: true, json: async () => value };
    }
  });
  vm.runInContext(backend, context);
  const api = vm.runInContext("({matchCve, parseCpe23, compareVersions, startScan, resolveProduct})", context);
  async function endpoint(route) {
    let body;
    const headers = {};
    const res = { set(key, value) { headers[key] = value; }, json(value) { body = plain(value); } };
    await handlers.get(route)({}, res);
    assert.equal(headers["Cache-Control"], "no-store");
    return body;
  }
  return { api, endpoint, requests, queries, delays, timers, errors,
    advance: amount => { now += amount; }, failQueries: error => { queryError = error; } };
}

const unit = harness();
function match(record, inventory = product()) { return plain(unit.api.matchCve(record, inventory)); }

const cases = [
  ["literal exact version", cve(exact()), "affected"],
  ["literal numeric version outside", cve(exact("2.0.0")), "not_established"],
  ["inclusive start boundary", cve(criterion({ versionStartIncluding: "1.2.3" })), "affected"],
  ["exclusive start boundary", cve(criterion({ versionStartExcluding: "1.2.3" })), "not_established"],
  ["inclusive end boundary", cve(criterion({ versionEndIncluding: "1.2.3" })), "affected"],
  ["exclusive end boundary", cve(criterion({ versionEndExcluding: "1.2.3" })), "not_established"],
  ["inside bounded range", fixture, "affected"],
  ["below bounded range", cve(criterion({ versionStartIncluding: "1.2.4", versionEndIncluding: "2.0.0" })), "not_established"],
  ["above bounded range", cve(criterion({ versionEndIncluding: "1.2.2" })), "not_established"],
  ["exact version AND range", cve(exact("1.2.3", { versionEndExcluding: "1.2.3" })), "not_established"],
  ["ambiguous start bounds", cve(criterion({ versionStartIncluding: "1.0.0", versionStartExcluding: "1.0.1" })), "potential"],
  ["ambiguous end bounds", cve(criterion({ versionEndIncluding: "2.0.0", versionEndExcluding: "2.0.1" })), "potential"],
  ["inverted range", cve(criterion({ versionStartIncluding: "2.0.0", versionEndIncluding: "1.0.0" })), "potential"],
  ["empty range", cve(criterion({ versionStartExcluding: "1.2.3", versionEndIncluding: "1.2.3" })), "potential"],
  ["empty boundary", cve(criterion({ versionEndIncluding: "" })), "potential"],
  ["null boundary", cve(criterion({ versionEndIncluding: null })), "potential"],
  ["suffix range boundary", cve(criterion({ versionEndIncluding: "1.2.3-rc1" })), "potential"],
  ["component count mismatch", cve(criterion({ versionEndIncluding: "2.0" })), "potential"],
  ["exact component count mismatch", cve(exact("1.2.3.0")), "potential"],
  ["version wildcard alone", cve(criterion()), "potential"],
  ["version pattern", cve(exact("1.2.*")), "potential"],
  ["NA version", cve(exact("-")), "potential"],
  ["wildcard vendor", cve(exact("1.2.3", {}, { vendor: "*" })), "potential"],
  ["other vendor", cve(exact("1.2.3", {}, { vendor: "other" })), "potential"],
  ["other product", cve(exact("1.2.3", {}, { product: "widget_pro" })), "potential"],
  ["environment-only flag", cve(exact("1.2.3", { vulnerable: false })), "potential"],
  ["missing vulnerable flag", cve({ criteria: exact().criteria }), "potential"],
  ["string vulnerable flag", cve(exact("1.2.3", { vulnerable: "true" })), "potential"],
  ["OS CPE", cve(exact("1.2.3", {}, { part: "o" })), "potential"],
  ["malformed CPE", cve({ vulnerable: true, criteria: "cpe:2.3:a:acme:widget" }), "potential"],
  ["legacy CPE", cve({ vulnerable: true, criteria: "cpe:/a:acme:widget:1.2.3" }), "potential"],
  ["malformed escape", cve(exact("1.2.3", {}, { vendor: "\\acme" })), "potential"],
  ["null CPE entry", cve(null), "potential"],
  ["missing configurations", { id: "CVE-2026-12345", descriptions: [{ lang: "en", value: "Acme Widget 1.2.3" }] }, "potential"],
  ["empty configurations", { configurations: [] }, "potential"],
  ["rejected CVE", { ...cve(exact()), vulnStatus: "Rejected" }, "potential"],
  ["AND node", { configurations: [{ nodes: [{ operator: "AND", cpeMatch: [exact(), exact()] }] }] }, "potential"],
  ["AND wrapper", { configurations: [{ operator: "AND", nodes: [orNode([exact()]), orNode([exact()])] }] }, "potential"],
  ["unspecified multi-node wrapper", { configurations: [{ nodes: [orNode([exact()]), orNode([exact()])] }] }, "potential"],
  ["negated node", { configurations: [{ nodes: [{ ...orNode([exact()]), negate: true }] }] }, "potential"],
  ["negated wrapper", { configurations: [{ negate: true, nodes: [orNode([exact()])] }] }, "potential"],
  ["malformed negate", { configurations: [{ nodes: [{ ...orNode([exact()]), negate: "false" }] }] }, "potential"],
  ["unknown operator", { configurations: [{ nodes: [{ operator: "XOR", cpeMatch: [exact()] }] }] }, "potential"],
  ["mixed tree shape", { configurations: [{ operator: "OR", nodes: [orNode([exact()])], cpeMatch: [exact()] }] }, "potential"],
  ["missing node operator", { configurations: [{ nodes: [{ cpeMatch: [exact()] }] }] }, "potential"],
  ["legacy children require review", { configurations: [{ nodes: [{ operator: "OR", children: [orNode([exact()])] }] }] }, "potential"],
  ["independent OR match despite unknown sibling", cve(criterion(), exact()), "affected"],
  ["unrelated OR criterion does not cancel version exclusion", cve(exact("2.0.0"), exact("1.2.3", {}, { vendor: "other" })), "not_established"],
  ["unknown relevant OR criterion prevents negative", cve(exact("2.0.0"), criterion()), "potential"],
  ["recursive OR tree", { configurations: [{ nodes: [{ operator: "OR", nodes: [orNode([exact()])] }] }] }, "affected"]
];
for (const [name, record, expected] of cases) {
  test(`matching: ${name}`, () => assert.equal(match(record).matchStatus, expected));
}
for (const qualifier of ["update", "edition", "language", "sw_edition", "target_sw", "target_hw", "other"]) {
  test(`matching: ${qualifier} requirement stays potential`, () => {
    assert.equal(match(cve(exact("1.2.3", {}, { [qualifier]: "restricted" }))).matchStatus, "potential");
  });
}
for (const version of [null, "", "unknown", "*", "-", "latest", "N/A", "1.2.3-rc1", "01.2.3", "v1.2.3", "1.2.3+build7"]) {
  test(`matching: uncertain inventory range version ${String(version)}`, () => {
    assert.equal(match(fixture, product([version])).matchStatus, "potential");
  });
}
test("matching: exact prerelease string needs no guessed ordering", () => {
  assert.equal(match(cve(exact("1.2.3-rc1")), product(["1.2.3-rc1"])).matchStatus, "affected");
});
test("matching: preserve large numeric precision", () => {
  assert.equal(match(cve(criterion({ versionEndExcluding: "9007199254740993.0.0" })), product(["9007199254740992.0.0"])).matchStatus, "affected");
});
test("matching: case, CPE separators, and publisher-prefixed display name", () => {
  assert.equal(match(cve(exact()), product(["1.2.3"], { name: "ACME Widget", publisher: "ACME" })).matchStatus, "affected");
  assert.equal(match(cve(exact("1.2.3", {}, { product: "widget_pro" })), product(["1.2.3"], { name: "Widget Pro" })).matchStatus, "affected");
});
test("matching: escaped CPE colon remains part of vendor", () => {
  assert.equal(match(cve(exact("1.2.3", {}, { vendor: "acme\\:lab" })), product(["1.2.3"], { publisher: "Acme:Lab" })).matchStatus, "affected");
});
test("matching: no substring or punctuation erasure", () => {
  assert.equal(match(cve(exact()), product(["1.2.3"], { name: "Widget Professional" })).matchStatus, "potential");
  assert.equal(match(cve(exact("1.2.3", {}, { product: "c" })), product(["1.2.3"], { name: "C++" })).matchStatus, "potential");
});
test("matching: no inferred publisher aliases", () => {
  assert.equal(match(cve(exact()), product(["1.2.3"], { publisher: "Acme Inc." })).matchStatus, "potential");
  assert.equal(match(cve(exact()), product(["1.2.3"], { publisher: null })).matchStatus, "potential");
});
test("matching: mixed versions retain separate outcomes and duplicate row counts", () => {
  const result = match(fixture, product(["1.2.3", "1.2.3", "2.0.0", null]));
  assert.equal(result.matchStatus, "affected");
  assert.deepEqual(result.matchedVersions, ["1.2.3"]);
  assert.deepEqual(result.versionResults.map(x => [x.version, x.status, x.inventoryCount]), [
    ["1.2.3", "affected", 2], ["2.0.0", "not_established", 1], [null, "potential", 1]
  ]);
  assert.equal(result.versionResults[0].evidence.versionEndExcluding, "2.0.0");
});
test("matching: out-of-range plus unknown remains potential", () => {
  assert.equal(match(fixture, product(["2.0.0", null])).matchStatus, "potential");
  assert.equal(match(fixture, product(["2.0.0", "3.0.0"])).matchStatus, "not_established");
});

test("backend: dictionary identity, complete paging, single-flight, caching and rotation", async () => {
  const products = Array.from({ length: 5 }, (_, i) => product(["1.2.3", "2.0.0"], { id: `id-${i}`, name: `Widget${i}` }));
  const h = harness(products, undefined, { NVD_API_KEY: "test-key", SOFTTRACK_RELEASE_AT: "2026-11-10T12:00:00Z" });
  const first = await h.endpoint("/cves");
  assert.equal(first.scanning, true);
  const flight = h.api.startScan();
  assert.equal(flight, h.api.startScan());
  await flight;
  const body = await h.endpoint("/cves");
  assert.equal(body.searched, 4);
  assert.equal(body.checkedVersions, 8);
  assert.equal(body.total, 10);
  assert.equal(body.completeProducts, 4);
  assert.equal(body.candidates.length, 4);
  assert.equal(body.nvdResultsTruncated, false);
  assert.equal(body.truncated, true, "one product is still outside this batch");
  assert.deepEqual(h.delays, Array(7).fill(1000));
  assert.equal(h.timers[0].ms, 30 * 60 * 1000);
  assert.equal(h.requests[0].url.searchParams.get("cpeMatchString"), "cpe:2.3:a:acme:widget0");
  assert.equal(h.requests[1].url.searchParams.get("virtualMatchString"), "cpe:2.3:a:acme:widget0");
  assert.equal(h.requests[1].url.searchParams.get("resultsPerPage"), "2000");
  assert.ok(h.requests[1].url.searchParams.has("noRejected"));
  assert.ok(h.requests.every(r => !r.url.searchParams.has("keywordSearch")));
  assert.equal(h.requests[0].options.headers.apiKey, "test-key");
  assert.equal(h.requests.length, 8);
  const status = await h.endpoint("/status");
  assert.equal(status.checkedProducts, 4);
  assert.equal(status.releaseUpdated, "2026-11-10T12:00:00.000Z");
  h.advance(TTL + 1);
  await h.endpoint("/cves");
  await h.api.startScan();
  assert.equal((await h.endpoint("/cves")).batchStart, 4);
  h.advance(TTL + 1);
  await h.api.startScan();
  assert.equal((await h.endpoint("/cves")).batchStart, 0);
});

function records(count, start = 0) {
  return Array.from({ length: count }, (_, i) => ({ cve: { ...fixture, id: `CVE-2026-${10000 + start + i}`, published: i === count - 1 ? "2026-11-01T12:00:00Z" : "2026-01-01T12:00:00Z" } }));
}

test("backend: retrieves additional pages and sorts recent CVEs first", async () => {
  const h = harness([product()], request => {
    const start = Number(request.url.searchParams.get("startIndex"));
    return { totalResults: 31, startIndex: start, vulnerabilities: start === 0 ? records(25) : records(6, 25) };
  });
  await h.api.startScan();
  const body = await h.endpoint("/cves");
  assert.equal(body.candidates.length, 31);
  assert.equal(body.productResults[0].pages, 2);
  assert.equal(body.productResults[0].status, "complete");
  assert.equal(body.truncated, false);
  assert.deepEqual(h.requests.slice(1).map(r => r.url.searchParams.get("startIndex")), ["0", "25"]);
  assert.equal(body.candidates[0].published, "2026-11-01T12:00:00Z");
  assert.deepEqual(h.delays, [6500, 6500]);
});

test("backend: ambiguous names, deprecated entries and unrelated dictionary records never become CVE queries", async () => {
  for (const [inventory, dictionary] of [
    [product([], { name: "Google", publisher: "Google" }), undefined],
    [product(), () => ({ products: [] })],
    [product(), () => ({ products: [{ cpe: { deprecated: true, cpeName: exact().criteria } }] })],
    [product(), () => ({ products: [{ cpe: { deprecated: false, cpeName: exact("1", {}, { product: "other" }).criteria } }] })]
  ]) {
    const h = harness([inventory], undefined, {}, dictionary);
    await h.api.startScan();
    const body = await h.endpoint("/cves");
    assert.equal(body.unresolvedProducts, 1);
    assert.equal(body.candidates.length, 0);
    assert.equal(body.truncated, true);
    assert.ok(h.requests.every(r => r.url.pathname.includes("/cpes/")));
  }
});

test("backend: publisher prefix is removed but punctuation remains in dictionary lookup", async () => {
  const h = harness([product(["1.0"], { publisher: "Acme", name: "Acme C++" })]);
  await h.api.startScan();
  assert.equal(h.requests[0].url.searchParams.get("cpeMatchString"), String.raw`cpe:2.3:a:acme:c\+\+`);
});

test("backend: partial page failures preserve results and do not stop other products", async () => {
  let calls = 0;
  const h = harness([product(), product()], () => {
    calls++;
    if (calls === 2) throw new Error("Network unavailable");
    return { totalResults: calls === 1 ? 3 : 1, startIndex: 0, vulnerabilities: records(1) };
  });
  await h.api.startScan();
  const body = await h.endpoint("/cves");
  assert.equal(body.failedSearches, 1);
  assert.equal(body.searched, 2);
  assert.equal(body.candidates.length, 2);
  assert.equal(body.productResults[0].status, "failed");
  assert.equal(body.productResults[1].status, "complete");
  assert.equal(body.truncated, true);
});

test("backend: retries rate limits with Retry-After and bounded attempts", async () => {
  let calls = 0;
  const h = harness([product()], () => ++calls === 1
    ? { httpResponse: { ok: false, status: 429, headers: { get: () => "20" } } }
    : { totalResults: 1, startIndex: 0, vulnerabilities: records(1) });
  await h.api.startScan();
  assert.equal((await h.endpoint("/cves")).failedSearches, 0);
  assert.deepEqual(h.delays, [6500, 20000]);
  let failedCalls = 0;
  const failure = harness([product()], () => { failedCalls++; return { httpResponse: { ok: false, status: 503 } }; });
  await failure.api.startScan();
  assert.equal(failedCalls, 3);
  assert.equal((await failure.endpoint("/cves")).failedSearches, 1);
});

test("backend: page limits, invalid metadata and repeated pages never claim full coverage", async () => {
  const capped = harness([product()], r => {
    const start = Number(r.url.searchParams.get("startIndex"));
    return { totalResults: 11, startIndex: start, vulnerabilities: records(1, start) };
  });
  await capped.api.startScan();
  const body = await capped.endpoint("/cves");
  assert.equal(body.productResults[0].pages, 10);
  assert.equal(body.productResults[0].status, "limited");
  assert.equal(body.nvdResultsTruncated, true);
  for (const response of [
    () => ({ vulnerabilities: records(1), totalResults: null, startIndex: 0 }),
    () => ({ vulnerabilities: records(1), totalResults: 5, startIndex: 100 }),
    r => ({ vulnerabilities: records(1), totalResults: 5, startIndex: Number(r.url.searchParams.get("startIndex")) })
  ]) {
    const h = harness([product()], response);
    await h.api.startScan();
    const result = await h.endpoint("/cves");
    assert.equal(result.failedSearches, 1);
    assert.equal(result.truncated, true);
    assert.ok(h.requests.length <= 3);
  }
});

test("backend: empty inventory and zero CVEs are distinct from unresolved identity", async () => {
  const empty = harness([]);
  await empty.api.startScan();
  assert.equal((await empty.endpoint("/cves")).truncated, false);
  assert.equal(empty.requests.length, 0);
  const noCves = harness([product()], () => ({ totalResults: 0, startIndex: 0, vulnerabilities: [] }));
  await noCves.api.startScan();
  assert.equal((await noCves.endpoint("/cves")).productResults[0].status, "complete");
});

test("backend: fatal DB failure preserves cached data and timestamps", async () => {
  const h = harness();
  await h.api.startScan();
  const before = await h.endpoint("/cves");
  h.failQueries(new Error("DB timeout"));
  h.advance(TTL + 1);
  await h.api.startScan();
  const after = await h.endpoint("/cves");
  assert.deepEqual(after.candidates, before.candidates);
  assert.equal(after.checkedAt, before.checkedAt);
  assert.match(after.error, /stale or incomplete/);
  assert.equal(after.scanning, false);
});

class Element {
  constructor(tag = "div") { this.tag = tag; this.children = []; this.style = {}; this.listeners = {}; this.value = ""; this._text = ""; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(""); }
  set innerHTML(_value) { throw new Error("Unsafe innerHTML rendering"); }
  appendChild(child) { this.children.push(child); return child; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this._text = ""; this.children = children; }
  addEventListener(name, listener) { this.listeners[name] = listener; }
}
async function browser(data, error = false) {
  const elements = new Map(["cveScanStatus", "cveResults", "cveSearch", "cveCritical", "cveHigh", "cveMedium", "cveLow", "inventoryUpdated", "securityUpdated", "releaseUpdated", "cveMatchFilter", "cveAffected", "cveReview", "cveNotEstablished", "cveProductCoverage", "cvePrevious", "cveNext", "cvePageLabel"].map(id => [id, new Element()]));
  const timers = [], requests = [], created = [];
  vm.runInNewContext(frontend, {
    document: {
      getElementById: id => elements.get(id),
      createElement: tag => { const element = new Element(tag); created.push(element); return element; }
    },
    Date, console: { error() {} }, setTimeout: (fn, ms) => timers.push({ fn, ms }),
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (error) throw new Error("network down");
      return { ok: true, json: async () => url.endsWith("/cves") ? data : {
        inventoryUpdated: "2026-11-11T12:00:00Z", securityUpdated: "2026-11-11T12:00:00Z", releaseUpdated: null
      } };
    }
  });
  await new Promise(setImmediate);
  return { elements, timers, requests, created };
}
test("frontend: mixed labels, version details, counters, search, and timestamp updates", async () => {
  const candidates = [
    { id: "CVE-2026-12345", severity: "CRITICAL", productSearch: "Acme Widget", description: "Example", ...match(fixture, product(["1.2.3", "2.0.0"])) },
    { id: "CVE-2026-12346", severity: "HIGH", productSearch: "Other", ...match({}, product(["unknown"])) },
    { id: "CVE-2026-12347", severity: "MEDIUM", ...match(fixture, product(["2.0.0"])) },
    { id: "CVE-2026-12348", severity: "LOW" }
  ];
  const h = await browser({ candidates, searched: 4, checkedAt: "2026-11-11T12:00:00Z", coverageNote: "Batch coverage", truncated: true, nvdResultsTruncated: true });
  for (const id of ["cveCritical", "cveHigh", "cveMedium", "cveLow"]) assert.equal(h.elements.get(id).textContent, "1");
  const results = h.elements.get("cveResults");
  assert.match(results.textContent, /Affected version match/);
  assert.match(results.textContent, /Potential match/);
  assert.match(results.textContent, /Not established as affected/);
  assert.match(results.textContent, /Version 2.0.0/);
  assert.match(results.textContent, /NVD CPE:/);
  assert.match(results.textContent, /not confirmed vulnerabilities/);
  assert.match(h.elements.get("cveScanStatus").textContent, /could not be fully retrieved/);
  assert.match(h.elements.get("cveScanStatus").textContent, /Batch coverage/);
  assert.notEqual(h.elements.get("inventoryUpdated").textContent, "Unavailable");
  assert.equal(h.elements.get("releaseUpdated").textContent, "Unavailable");
  const search = h.elements.get("cveSearch");
  search.value = "1.2.3";
  search.listeners.input();
  assert.equal(results.children.filter(child => child.tag === "article").length, 1);
  search.value = "12346";
  search.listeners.input();
  assert.equal(results.children.filter(child => child.tag === "article").length, 1);
  assert.match(results.textContent, /Potential match/);
  assert.equal(h.elements.get("cveCritical").textContent, "1", "search does not change counters");
  assert.ok(h.requests.every(request => request.options.cache === "no-store"));
});
test("frontend: safe text rendering and legacy API fallback", async () => {
  const malicious = "<img src=x onerror=alert(1)>";
  const h = await browser({ candidates: [{ id: "javascript:alert(1)", severity: "HIGH", productSearch: malicious, description: malicious,
    versionResults: [{ version: malicious, reason: malicious, evidence: { criteria: malicious } }] }] });
  assert.match(h.elements.get("cveResults").textContent, /Potential match/);
  assert.ok(h.elements.get("cveResults").textContent.includes(malicious));
  assert.equal(h.created.find(element => element.tag === "a").href, "https://nvd.nist.gov/");
  assert.ok(!h.created.some(element => ["img", "script"].includes(element.tag)));
});
test("frontend: scan polling, warnings, and network failure remain visible", async () => {
  const scanning = await browser({ scanning: true, candidates: [] });
  assert.equal(scanning.timers[0].ms, 10000);
  assert.match(scanning.elements.get("cveScanStatus").textContent, /scan running/);
  const warning = await browser({ candidates: [], error: "incomplete scan" });
  assert.match(warning.elements.get("cveScanStatus").textContent, /Warning: incomplete scan/);
  const failure = await browser({}, true);
  assert.match(failure.elements.get("cveScanStatus").textContent, /Unable to load/);
});

test("frontend: completed polling refreshes the sidebar security timestamp", async () => {
  const data = { scanning: true, candidates: [], checkedAt: null };
  const h = await browser(data);
  const before = h.elements.get("securityUpdated").textContent;
  data.scanning = false;
  data.checkedAt = "2026-11-12T01:00:00Z";
  await h.timers[0].fn();
  const after = h.elements.get("securityUpdated").textContent;
  assert.notEqual(after, before);
  assert.equal(after, new Date(data.checkedAt).toLocaleString());
  assert.match(h.elements.get("cveScanStatus").textContent, /Last completed scan:/);
});

test("frontend: classification counts, filters and pagination remain separate from severity counts", async () => {
  const candidates = records(61).map((item, i) => ({ ...item.cve, severity: "HIGH", productSearch: "Acme Widget", matchStatus: i < 30 ? "affected" : i < 60 ? "potential" : "not_established" }));
  const h = await browser({ candidates });
  const el = id => h.elements.get(id);
  const articles = () => el("cveResults").children.filter(child => child.tag === "article");
  assert.equal(articles().length, 25);
  assert.equal(el("cveAffected").textContent, "30");
  assert.equal(el("cveReview").textContent, "30");
  assert.equal(el("cveNotEstablished").textContent, "1");
  assert.equal(el("cvePageLabel").textContent, "Page 1 of 3");
  el("cveNext").listeners.click();
  assert.equal(el("cvePageLabel").textContent, "Page 2 of 3");
  el("cveMatchFilter").value = "affected";
  el("cveMatchFilter").listeners.change();
  assert.equal(el("cvePageLabel").textContent, "Page 1 of 2");
  el("cveNext").listeners.click();
  assert.equal(articles().length, 5);
  assert.equal(el("cveNext").disabled, true);
  el("cveSearch").value = "10001";
  el("cveSearch").listeners.input();
  assert.equal(articles().length, 1);
  assert.equal(el("cvePageLabel").textContent, "Page 1 of 1");
  assert.equal(el("cveHigh").textContent, "61", "severity counts cover the entire batch");
  el("cveSearch").value = "missing";
  el("cveSearch").listeners.input();
  assert.equal(articles().length, 0);
  assert.equal(el("cvePrevious").disabled, true);
  assert.equal(el("cveNext").disabled, true);
});

test("frontend: product identification failures and partial coverage are visible as safe text", async () => {
  const h = await browser({ candidates: [], productResults: [
    { name: "Google", publisher: "Google", status: "unresolved", message: "Check the product name." },
    { name: "<script>literal</script>", publisher: "Vendor", status: "failed", criteria: "cpe:2.3:a:acme:widget", totalCves: 31, fetchedCves: 25, pages: 1, message: "Page failed; partial results retained." }
  ] });
  const coverage = h.elements.get("cveProductCoverage").textContent;
  assert.match(coverage, /Needs product identification/);
  assert.match(coverage, /25 of 31 CVEs retrieved/);
  assert.match(coverage, /<script>literal<\/script>/);
  assert.ok(!h.created.some(element => element.tag === "script"));
});
