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

function harness(products = [product()], getNvd = () => ({ vulnerabilities: [{ cve: fixture }], totalResults: 1 }), env = {}) {
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
      const value = await getNvd(request, requests.length);
      return { ok: true, json: async () => value };
    }
  });
  vm.runInContext(backend, context);
  const api = vm.runInContext("({matchCve, parseCpe23, compareVersions, startScan})", context);
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

test("backend: cache, single-flight, rotation, legacy fields, UUID join, status, and limits", async () => {
  const products = Array.from({ length: 5 }, (_, i) => product(["1.2.3", "2.0.0"], { name: `Widget${i}` }));
  const h = harness(products, () => ({ totalResults: 21, vulnerabilities: [{ cve: fixture }, { cve: fixture }, { cve: { id: "invalid" } }] }), { NVD_API_KEY: "test-key", SOFTTRACK_RELEASE_AT: "2026-11-10T12:00:00Z" });
  const first = await h.endpoint("/cves");
  assert.equal(first.scanning, true);
  const flight = h.api.startScan();
  assert.equal(flight, h.api.startScan());
  await flight;
  const body = await h.endpoint("/cves");
  for (const key of ["checkedAt", "candidates", "searched", "total", "truncated", "error", "checkedVersions", "totalProducts", "checkedProducts", "failedSearches", "batchStart", "scanning", "coverageNote", "note"]) assert.ok(key in body, key);
  assert.equal(body.searched, 4);
  assert.equal(body.checkedVersions, 8);
  assert.equal(body.total, 10);
  assert.equal(body.totalProducts, 5);
  assert.equal(body.candidates.length, 4, "dedup remains by CVE and productSearch");
  for (const key of ["id", "severity", "productSearch", "description", "url", "classification"]) assert.ok(key in body.candidates[0], key);
  assert.equal(body.nvdResultsTruncated, true);
  assert.equal(body.truncated, true);
  assert.deepEqual(h.delays, [1000, 1000, 1000]);
  assert.equal(h.timers[0].ms, 30 * 60 * 1000);
  assert.equal(h.requests[0].url.searchParams.get("resultsPerPage"), "20");
  assert.equal(h.requests[0].url.searchParams.get("keywordSearch"), "Acme Widget0");
  assert.ok(h.requests[0].url.searchParams.has("noRejected"));
  assert.equal(h.requests[0].options.headers.apiKey, "test-key");
  assert.equal(h.requests.length, 4, "reads during TTL do not start extra requests");
  const status = await h.endpoint("/status");
  assert.equal(status.checkedProducts, 4);
  assert.equal(status.totalVersions, 10);
  assert.equal(status.releaseUpdated, "2026-11-10T12:00:00.000Z");
  assert.equal(status.inventoryUpdated, "2026-11-11T12:00:00Z");
  h.advance(TTL + 1);
  await h.endpoint("/cves");
  await h.api.startScan();
  const second = await h.endpoint("/cves");
  assert.equal(second.batchStart, 4);
  assert.equal(second.searched, 1);
  h.advance(TTL + 1);
  await h.endpoint("/cves");
  await h.api.startScan();
  assert.equal((await h.endpoint("/cves")).batchStart, 0);
});
test("backend: failed product request does not stop other products", async () => {
  const h = harness([product(), product(), product()], (_request, number) => {
    if (number === 2) throw new Error("NVD HTTP 429");
    return { vulnerabilities: [{ cve: fixture }] };
  });
  await h.api.startScan();
  const body = await h.endpoint("/cves");
  assert.equal(body.failedSearches, 1);
  assert.equal(body.searched, 2);
  assert.equal(body.checkedVersions, 2);
  assert.equal(body.truncated, true);
  assert.match(body.error, /incomplete/);
  assert.deepEqual(h.delays, [6500, 6500]);
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
test("backend: empty inventory and NVD page limit are reported accurately", async () => {
  const empty = harness([]);
  await empty.api.startScan();
  const body = await empty.endpoint("/cves");
  assert.equal(body.total, 0);
  assert.equal(body.truncated, false);
  assert.equal(empty.requests.length, 0);
  const capped = harness([product()], () => ({ totalResults: 21, vulnerabilities: [{ cve: fixture }] }));
  await capped.api.startScan();
  const capBody = await capped.endpoint("/cves");
  assert.equal(capBody.checkedVersions, capBody.total);
  assert.equal(capBody.nvdResultsTruncated, true);
  assert.equal(capBody.truncated, true);
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
  const elements = new Map(["cveScanStatus", "cveResults", "cveSearch", "cveCritical", "cveHigh", "cveMedium", "cveLow", "inventoryUpdated", "securityUpdated", "releaseUpdated"].map(id => [id, new Element()]));
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
  assert.match(h.elements.get("cveScanStatus").textContent, /20-per-product/);
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
