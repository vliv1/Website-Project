"use strict";
const express = require("express");
const pool = require("../db");
const router = express.Router();

const TTL = 6 * 60 * 60 * 1000;
const BATCH_SIZE = 4; // One bounded batch per scan; rotate to the next products next time.
const NVD_DELAY_MS = process.env.NVD_API_KEY ? 1000 : 6500;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let cache = {
  checkedAt: null, candidates: [], searched: 0, total: 0,
  truncated: false, error: null, checkedVersions: 0,
  totalProducts: 0, checkedProducts: 0, failedSearches: 0,
  batchStart: 0
};
let running = null;
let lastAttempt = 0;
let nextOffset = 0;

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
  // Count all versions, then select a bounded batch of distinct software products.
  // No database records are modified by this scan.
  const [versionCount, productCount] = await Promise.all([
    pool.query("SELECT COUNT(*)::int AS total FROM software_versions"),
    pool.query(`SELECT COUNT(*)::int AS total FROM software s
      WHERE EXISTS (SELECT 1 FROM software_versions v WHERE v.software_id = s.id)`)
  ]);
  const total = versionCount.rows[0].total;
  const totalProducts = productCount.rows[0].total;
  const offset = totalProducts ? nextOffset % totalProducts : 0;
  const data = await pool.query(`SELECT s.id, s.name, s.publisher, COUNT(v.id)::int AS version_count
    FROM software s JOIN software_versions v ON v.software_id = s.id
    GROUP BY s.id, s.name, s.publisher
    ORDER BY lower(s.name), lower(s.publisher), s.id
    LIMIT $1 OFFSET $2`, [BATCH_SIZE, offset]);

  const candidates = [];
  let searched = 0;
  let checkedVersions = 0;
  let failedSearches = 0;
  const errors = [];

  for (let i = 0; i < data.rows.length; i++) {
    if (i) await sleep(NVD_DELAY_MS);
    const product = data.rows[i];
    const term = `${product.publisher || ""} ${product.name || ""}`.trim();
    if (!term) { failedSearches++; errors.push("Missing product name"); continue; }
    try {
      const url = new URL("https://services.nvd.nist.gov/rest/json/cves/2.0");
      url.searchParams.set("keywordSearch", term);
      url.searchParams.set("resultsPerPage", "20");
      url.searchParams.set("noRejected", "");
      const headers = { "User-Agent": "SoftTrack-SecurityWatch/1.0" };
      if (process.env.NVD_API_KEY) headers.apiKey = process.env.NVD_API_KEY;
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`NVD HTTP ${response.status}`);
      const json = await response.json();
      if (!Array.isArray(json.vulnerabilities)) throw new Error("Invalid NVD response");
      searched++;
      checkedVersions += product.version_count;
      for (const item of json.vulnerabilities) {
        const cve = item?.cve;
        if (!/^CVE-\d{4}-\d{4,}$/.test(cve?.id || "")) continue;
        candidates.push({
          id: cve.id, severity: severityOf(cve), productSearch: term,
          description: (cve.descriptions || []).find(d => d.lang === "en")?.value?.slice(0, 360) || "",
          url: `https://nvd.nist.gov/vuln/detail/${cve.id}`,
          classification: "Potential — verify product and version"
        });
      }
    } catch (error) {
      failedSearches++;
      errors.push(`${term}: ${error.message}`);
      console.error("Security Watch NVD search failed:", term, error.message);
    }
  }

  const deduped = [...new Map(candidates.map(x => [x.id + "|" + x.productSearch, x])).values()];
  const truncated = checkedVersions < total || failedSearches > 0;
  const error = failedSearches ? `${failedSearches} NVD product search(es) failed; results are incomplete` : null;
  // Advance only after processing this batch. A failed search is retried when the rotation returns.
  nextOffset = totalProducts ? (offset + data.rows.length) % totalProducts : 0;
  cache = {
    checkedAt: new Date().toISOString(), candidates: deduped,
    searched, total, truncated, error, checkedVersions,
    totalProducts, checkedProducts: searched, failedSearches,
    batchStart: offset,
    // These are keyword candidates, NOT confirmed affected versions.
    coverageNote: `This scan searched ${searched} of ${totalProducts} software products and included ${checkedVersions} of ${total} inventory versions. Each scan covers one rotating batch.`,
  };
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
  const release = process.env.SOFTTRACK_RELEASE_AT;
  const releaseUpdated = release && !Number.isNaN(Date.parse(release)) ? new Date(release).toISOString() : null;
  res.json({
    inventoryUpdated, securityUpdated: cache.checkedAt, releaseUpdated,
    scanning: !!running, scanError: cache.error,
    checkedVersions: cache.checkedVersions, totalVersions: cache.total,
    checkedProducts: cache.checkedProducts, totalProducts: cache.totalProducts,
    failedSearches: cache.failedSearches,
    limitedCoverage: cache.truncated
  });
});

router.get("/cves", (_req, res) => {
  res.set("Cache-Control", "no-store");
  if (!running && Date.now() - lastAttempt > TTL) startScan();
  res.json({ ...cache, scanning: !!running,
    note: "Keyword search candidates only. No affected-version verification has been performed. Results are limited to the current rotating batch and may omit vulnerabilities." });
});

const timer = setInterval(() => {
  if (Date.now() - lastAttempt > TTL) startScan();
}, 30 * 60 * 1000);
timer.unref();
module.exports = router;
