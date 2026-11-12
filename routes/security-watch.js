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

// This is a deliberately limited evaluator, not a full CPE applicability engine.
// A positive result needs an independent OR path, a literal vendor/product
// identity, no unverified platform/edition qualifiers, and version evidence.
const MATCH_LABELS = {
  affected: "Affected version match — NVD criteria",
  potential: "Potential match — manual review required",
  not_established: "Not established as affected — not proof of safety"
};
const RANGE_KEYS = [
  "versionStartIncluding", "versionStartExcluding",
  "versionEndIncluding", "versionEndExcluding"
];
const owns = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const outcome = (status, reason, evidence = null) => ({ status, reason, evidence });

function parseCpe23(value) {
  if (typeof value !== "string" || value.length > 4096) return null;
  const fields = [];
  let field = "";
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (char === "\\") {
      if (++i >= value.length) return null;
      field += "\\" + value[i]; // Keep escapes until after splitting on colons.
    } else if (char === ":") {
      fields.push(field);
      field = "";
    } else {
      field += char;
    }
  }
  fields.push(field);
  if (fields.length !== 13 || fields[0] !== "cpe" || fields[1] !== "2.3" ||
      fields.some(value => value === "")) return null;
  return fields.slice(2);
}

function literalCpe(value) {
  // Wildcards, NA, and patterns need more information than this inventory has.
  if (typeof value !== "string" || value === "-" || /[*?\s]/.test(value)) return null;
  // CPE quoting escapes punctuation. Do not reinterpret malformed letter escapes.
  if (/\\[a-z0-9]/i.test(value)) return null;
  return value.replace(/\\([^a-z0-9])/gi, "$1").toLowerCase();
}

function identityKey(value) {
  // Only harmless CPE word separators are folded. Keep punctuation such as + and .
  // so C++, C#, .NET, and C cannot accidentally collapse to the same identity.
  return typeof value === "string"
    ? value.trim().toLowerCase().replace(/[ _-]+/g, " ") : "";
}

function identityMatches(product, fields) {
  const vendor = literalCpe(fields[1]);
  const name = literalCpe(fields[2]);
  const publisher = identityKey(product.publisher);
  const inventoryName = identityKey(product.name);
  if (!vendor || !name || !publisher || !inventoryName) return null;
  if (publisher !== identityKey(vendor)) return false;
  const cpeName = identityKey(name);
  // Allow a display name prefixed by its already-matched publisher (Google Chrome).
  // Never use substring, fuzzy, description, or keyword-search matches as identity.
  return inventoryName === cpeName || inventoryName === `${publisher} ${cpeName}`;
}

function numericVersion(value) {
  // No padding, prerelease ordering, leading-zero rewriting, or numeric rounding.
  if (typeof value !== "string" || value.length > 256 ||
      !/^(0|[1-9]\d*)(\.(0|[1-9]\d*))*$/.test(value)) return null;
  return value.split(".").map(part => BigInt(part));
}

function compareVersions(left, right) {
  const a = numericVersion(left);
  const b = numericVersion(right);
  // Different component counts may represent different vendor version schemes.
  if (!a || !b || a.length !== b.length) return null;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

function evaluateVersion(version, fields, match) {
  const installed = typeof version === "string" ? version.trim() : "";
  if (!installed || /^(?:[?*\-]|unknown|n\/?a|latest|unspecified|not specified)$/i.test(installed)) {
    return outcome("potential", "The inventory version is missing or unspecified.");
  }
  if (fields.slice(4).some(value => value !== "*")) {
    return outcome("potential", "NVD requires update, edition, language, or platform details that are not recorded here.");
  }
  const bounds = RANGE_KEYS.filter(key => owns(match, key));
  if ((owns(match, "versionStartIncluding") && owns(match, "versionStartExcluding")) ||
      (owns(match, "versionEndIncluding") && owns(match, "versionEndExcluding"))) {
    return outcome("potential", "NVD supplies ambiguous version range boundaries.");
  }
  if (bounds.some(key => !numericVersion(match[key]))) {
    return outcome("potential", "The NVD range uses an unsupported or missing version boundary.");
  }
  const start = bounds.find(key => key.startsWith("versionStart"));
  const end = bounds.find(key => key.startsWith("versionEnd"));
  if (start && end) {
    const order = compareVersions(match[start], match[end]);
    if (order === null || order > 0 || (order === 0 &&
        (start.endsWith("Excluding") || end.endsWith("Excluding")))) {
      return outcome("potential", "The NVD range is inconsistent or cannot be compared conservatively.");
    }
  }
  const comparisons = bounds.map(key => ({ key, order: compareVersions(installed, match[key]) }));
  if (comparisons.some(value => value.order === null)) {
    return outcome("potential", "Version ranges require plain numeric versions with the same number of components.");
  }
  let outside = comparisons.some(({ key, order }) =>
    key === "versionStartIncluding" ? order < 0 :
    key === "versionStartExcluding" ? order <= 0 :
    key === "versionEndIncluding" ? order > 0 : order >= 0);

  if (fields[3] !== "*") {
    const exact = literalCpe(fields[3]);
    if (!exact) return outcome("potential", "The CPE version is a pattern or an unsupported value.");
    if (installed.toLowerCase() !== exact) {
      const order = compareVersions(installed, exact);
      if (order === null) return outcome("potential", "The inventory version cannot be reliably compared with the exact CPE version.");
      outside = outside || order !== 0;
    }
  } else if (!bounds.length) {
    return outcome("potential", "NVD lists a wildcard version without version-specific criteria.");
  }
  const evidence = { criteria: match.criteria };
  if (typeof match.matchCriteriaId === "string") evidence.matchCriteriaId = match.matchCriteriaId;
  for (const key of bounds) evidence[key] = match[key];
  return outside
    ? outcome("not_established", "This inventory version is outside the evaluated NVD version criteria; this is not proof of safety.", evidence)
    : outcome("affected", "Vendor and product identity and the recorded version match supported NVD criteria.", evidence);
}

function evaluateCpeMatch(match, product, version) {
  if (!match || typeof match !== "object" || Array.isArray(match)) {
    return outcome("potential", "NVD contains an invalid CPE match entry.");
  }
  const fields = parseCpe23(match.criteria);
  if (!fields) return outcome("potential", "NVD CPE criteria are missing or unsupported.");
  const identity = identityMatches(product, fields);
  if (identity === false) return outcome("unrelated", "The CPE vendor or product does not exactly match this inventory record.");
  if (identity === null) return outcome("potential", "An exact CPE vendor and product identity could not be established.");
  if (match.vulnerable !== true) {
    return outcome("potential", "This CPE is an environmental requirement or lacks a vulnerable flag.");
  }
  if (fields[0] !== "a") return outcome("potential", "Only application CPEs are evaluated automatically.");
  return evaluateVersion(version, fields, match);
}

function combineAlternatives(values) {
  // An independently satisfied OR alternative is sufficient. Unknown alternatives
  // never establish an affected version or turn an uncertain result into a negative.
  const affected = values.find(value => value.status === "affected");
  if (affected) return affected;
  const unknown = values.find(value => value.status === "potential");
  if (unknown) return unknown;
  return values.find(value => value.status === "not_established") ||
    outcome("potential", "No exact vulnerable vendor/product CPE identity was established; keyword relevance alone is insufficient.");
}

function evaluateConfiguration(node, product, version, wrapper = false, depth = 0) {
  if (!node || typeof node !== "object" || Array.isArray(node) || depth > 20) {
    return outcome("potential", "NVD configuration structure is missing, unsupported, or too deeply nested.");
  }
  if (owns(node, "negate") && node.negate !== false) {
    return outcome("potential", "Negated NVD configurations require manual review.");
  }
  const hasNodes = owns(node, "nodes");
  const hasMatches = owns(node, "cpeMatch");
  if (hasNodes === hasMatches || owns(node, "children")) {
    return outcome("potential", "NVD configuration structure requires manual review.");
  }
  const entries = hasNodes ? node.nodes : node.cpeMatch;
  if (!Array.isArray(entries) || !entries.length) {
    return outcome("potential", "NVD configuration has no usable criteria.");
  }
  // NVD permits a configuration wrapper without an operator. Only unwrap a
  // single node; do not guess the relationship between multiple nodes.
  if (node.operator !== "OR" && !(wrapper && !owns(node, "operator") && hasNodes && entries.length === 1)) {
    return outcome("potential", "AND or unspecified multi-node NVD conditions require manual review.");
  }
  return combineAlternatives(entries.map(entry => hasNodes
    ? evaluateConfiguration(entry, product, version, false, depth + 1)
    : evaluateCpeMatch(entry, product, version)));
}

function matchCve(cve, product) {
  const versions = new Map();
  for (const value of Array.isArray(product.versions) && product.versions.length ? product.versions : [null]) {
    const version = typeof value === "string" && value.trim() ? value.trim() : null;
    versions.set(version, (versions.get(version) || 0) + 1);
  }
  const versionResults = [...versions].map(([version, inventoryCount]) => {
    let result;
    if (cve.vulnStatus === "Rejected") {
      result = outcome("potential", "Rejected CVE records do not establish an affected version.");
    } else if (!Array.isArray(cve.configurations) || !cve.configurations.length) {
      result = outcome("potential", "NVD has no usable CPE configurations; a keyword match is not version evidence.");
    } else {
      result = combineAlternatives(cve.configurations.map(config =>
        evaluateConfiguration(config, product, version, true)));
    }
    return { version, inventoryCount, ...result };
  });
  const matchStatus = versionResults.some(result => result.status === "affected") ? "affected" :
    versionResults.every(result => result.status === "not_established") ? "not_established" : "potential";
  return {
    classification: MATCH_LABELS[matchStatus], matchStatus,
    matchedVersions: versionResults.filter(result => result.status === "affected").map(result => result.version),
    versionResults
  };
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
  const data = await pool.query(`SELECT s.id, s.name, s.publisher, COUNT(v.id)::int AS version_count,
      ARRAY_AGG(v.version ORDER BY v.version) AS versions
    FROM software s JOIN software_versions v ON v.software_id = s.id
    GROUP BY s.id, s.name, s.publisher
    ORDER BY lower(s.name), lower(s.publisher), s.id
    LIMIT $1 OFFSET $2`, [BATCH_SIZE, offset]);

  const candidates = [];
  let searched = 0;
  let checkedVersions = 0;
  let failedSearches = 0;
  let nvdResultsTruncated = false;
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
      if (Number(json.totalResults) > json.vulnerabilities.length) nvdResultsTruncated = true;
      searched++;
      checkedVersions += product.version_count;
      for (const item of json.vulnerabilities) {
        const cve = item?.cve;
        if (!/^CVE-\d{4}-\d{4,}$/.test(cve?.id || "")) continue;
        candidates.push({
          id: cve.id, severity: severityOf(cve), productSearch: term,
          description: (cve.descriptions || []).find(d => d.lang === "en")?.value?.slice(0, 360) || "",
          url: `https://nvd.nist.gov/vuln/detail/${cve.id}`,
          ...matchCve(cve, product)
        });
      }
    } catch (error) {
      failedSearches++;
      errors.push(`${term}: ${error.message}`);
      console.error("Security Watch NVD search failed:", term, error.message);
    }
  }

  const deduped = [...new Map(candidates.map(x => [x.id + "|" + x.productSearch, x])).values()];
  const truncated = checkedVersions < total || failedSearches > 0 || nvdResultsTruncated;
  const error = failedSearches ? `${failedSearches} NVD product search(es) failed; results are incomplete` : null;
  // Advance only after processing this batch. A failed search is retried when the rotation returns.
  nextOffset = totalProducts ? (offset + data.rows.length) % totalProducts : 0;
  cache = {
    checkedAt: new Date().toISOString(), candidates: deduped,
    searched, total, truncated, error, checkedVersions,
    totalProducts, checkedProducts: searched, failedSearches,
    batchStart: offset,
    nvdResultsTruncated,
    // checkedVersions counts included rows, not verified affected versions.
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
    note: "Keyword search discovers candidates. Affected version match means an exact vendor/product identity and recorded version satisfy supported NVD CPE criteria, not confirmed exploitability. Uncertain matches require manual review. Not established as affected is not proof of safety. Results cover one rotating batch, at most 20 CVEs per product, and may omit vulnerabilities." });
});

const timer = setInterval(() => {
  if (Date.now() - lastAttempt > TTL) startScan();
}, 30 * 60 * 1000);
timer.unref();
module.exports = router;
