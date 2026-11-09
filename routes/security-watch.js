"use strict";
const express = require("express");
const pool = require("../db");
const router = express.Router();
const TTL = 6 * 60 * 60 * 1000;
let cache = { checkedAt: null, candidates: [], searched: 0, total: 0, truncated: false, error: null };
let running = null;
let lastAttempt = 0;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function inventoryTimestamp() {
  const result = await pool.query("SELECT MAX(created_at) AS updated_at FROM softtrack_audit_events");
  return result.rows[0]?.updated_at || null;
}

function severityOf(cve) {
  for (const key of ["cvssMetricV40", "cvssMetricV31", "cvssMetricV30", "cvssMetricV2"]) {
    const metric = cve.metrics?.[key]?.[0];
    if (metric) return metric.cvssData?.baseSeverity || metric.baseSeverity || "UNKNOWN";
  }
  return "UNKNOWN";
}

async function scan() {
  const data = await pool.query(`SELECT s.name, s.publisher, v.version
    FROM software s JOIN software_versions v ON v.software_id=s.id
    ORDER BY lower(s.name), lower(s.publisher), v.version LIMIT 6`);
  const count = await pool.query("SELECT COUNT(*)::int AS total FROM software_versions");
  const candidates = [];
  const unique = [...new Set(data.rows.map(x => `${x.publisher} ${x.name}`.trim()))].slice(0, 4);
  for (let i = 0; i < unique.length; i++) {
    if (i) await sleep(process.env.NVD_API_KEY ? 1000 : 6500);
    const term = unique[i];
    const url = new URL("https://services.nvd.nist.gov/rest/json/cves/2.0");
    url.searchParams.set("keywordSearch", term);
    url.searchParams.set("resultsPerPage", "20");
    url.searchParams.set("noRejected", "");
    const headers = { "User-Agent": "SoftTrack-SecurityWatch/1.0" };
    if (process.env.NVD_API_KEY) headers.apiKey = process.env.NVD_API_KEY;
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`NVD HTTP ${response.status}`);
    const json = await response.json();
    for (const item of json.vulnerabilities || []) {
      const cve = item.cve;
      if (!/^CVE-\d{4}-\d{4,}$/.test(cve?.id || "")) continue;
      candidates.push({ id: cve.id, severity: severityOf(cve), productSearch: term,
        description: (cve.descriptions || []).find(d => d.lang === "en")?.value?.slice(0, 360) || "",
        url: `https://nvd.nist.gov/vuln/detail/${cve.id}`, classification: "Potential — verify product and version" });
    }
  }
  const deduped = [...new Map(candidates.map(x => [x.id + x.productSearch, x])).values()];
  cache = { checkedAt: new Date().toISOString(), candidates: deduped, searched: unique.length,
    total: count.rows[0].total, truncated: count.rows[0].total > data.rows.length,
    error: null };
}

function startScan() {
  if (running) return running;
  lastAttempt = Date.now();
  running = scan().catch(error => {
    console.error("Security Watch scan failed:", error.message);
    cache.error = "NVD scan failed; results may be stale or incomplete";
  }).finally(() => { running = null; });
  return running;
}

router.get("/status", async (_req, res) => {
  res.set("Cache-Control", "no-store");
  let inventoryUpdated = null;
  try { inventoryUpdated = await inventoryTimestamp(); }
  catch (error) { console.error("Inventory timestamp unavailable:", error.message); }
  // A Render deploy timestamp is only supplied if an independently managed value exists.
  const release = process.env.SOFTTRACK_RELEASE_AT;
  const releaseUpdated = release && !Number.isNaN(Date.parse(release)) ? new Date(release).toISOString() : null;
  res.json({ inventoryUpdated, securityUpdated: cache.checkedAt, releaseUpdated,
    scanning: !!running, scanError: cache.error, checkedVersions: cache.searched,
    totalVersions: cache.total, limitedCoverage: cache.truncated || cache.total > cache.searched });
});

router.get("/cves", (_req, res) => {
  res.set("Cache-Control", "no-store");
  if (!running && Date.now() - lastAttempt > TTL) startScan();
  res.json({ ...cache, scanning: !!running,
    note: "Keyword search candidates only. No affected-version verification has been performed. Results are limited and may omit vulnerabilities." });
});

// Refresh on an interval, but never run concurrent scans. Render restarts reset in-memory history.
const timer = setInterval(() => { if (Date.now() - lastAttempt > TTL) startScan(); }, 30 * 60 * 1000);
timer.unref();
module.exports = router;
