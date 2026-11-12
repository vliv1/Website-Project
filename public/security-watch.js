
"use strict";

(() => {
  const byId = id => document.getElementById(id);

  const status = byId("cveScanStatus");
  const results = byId("cveResults");
  const search = byId("cveSearch");
  const matchFilter = byId("cveMatchFilter");
  const previous = byId("cvePrevious"), next = byId("cveNext");
  const PAGE_SIZE = 25;
  let page = 1;

  if (!status || !results) return;

  let candidates = [];
  let securityCheckedAt = null;
  const matchLabels = {
    affected: "Affected version match — NVD criteria",
    potential: "Potential match — manual review required",
    not_established: "Not established as affected — not proof of safety"
  };

  function matchLabel(value) {
    return Object.prototype.hasOwnProperty.call(matchLabels, value)
      ? matchLabels[value] : matchLabels.potential;
  }

  function displayDate(value) {
    if (!value) return "Unavailable";
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? "Unavailable"
      : date.toLocaleString();
  }

  function setText(id, value) {
    const element = byId(id);
    if (element) element.textContent = value;
  }

  function updateCounts(items) {
    const counts = {
      CRITICAL: 0,
      HIGH: 0,
      MEDIUM: 0,
      LOW: 0
    };

    for (const item of items) {
      const severity = String(item.severity || "").toUpperCase();
      if (severity in counts) counts[severity]++;
    }

    setText("cveCritical", counts.CRITICAL);
    setText("cveHigh", counts.HIGH);
    setText("cveMedium", counts.MEDIUM);
    setText("cveLow", counts.LOW);
    setText("cveAffected", items.filter(item => item.matchStatus === "affected").length);
    setText("cveNotEstablished", items.filter(item => item.matchStatus === "not_established").length);
    setText("cveReview", items.filter(item => !["affected", "not_established"].includes(item.matchStatus)).length);
  }

  function renderCoverage(products) {
    const container = byId("cveProductCoverage");
    if (!container) return;
    container.replaceChildren();
    if (!Array.isArray(products) || !products.length) {
      container.textContent = "Product coverage will appear after a scan completes.";
      return;
    }
    const labels = { complete: "All returned pages checked", limited: "Partial coverage", failed: "Scan incomplete", unresolved: "Needs product identification" };
    for (const product of products) {
      const entry = document.createElement("div");
      entry.className = "cve-product";
      const heading = document.createElement("strong");
      heading.textContent = `${product.name} (${product.publisher}) — ${labels[product.status] || "Needs review"}`;
      const description = document.createElement("p");
      description.textContent = product.message || "";
      entry.append(heading, description);
      if (product.criteria) {
        const coverage = document.createElement("p");
        coverage.textContent = `${product.fetchedCves || 0} of ${product.totalCves ?? "unknown"} CVEs retrieved across ${product.pages || 0} pages. Product identity: ${product.criteria}`;
        entry.appendChild(coverage);
      }
      container.appendChild(entry);
    }
  }

  function renderResults() {
    const query = (search?.value || "").trim().toLowerCase();

    const selected = matchFilter?.value || "all";
    const filtered = candidates.filter(item =>
      (selected === "all" || selected === (item.matchStatus || "potential")) &&
      [item.id, item.productSearch, item.description, matchLabel(item.matchStatus),
        ...(Array.isArray(item.versionResults) ? item.versionResults : [])
          .map(result => `${result.version || "Unknown"} ${matchLabel(result.status)} ${result.reason || ""}`)]
        .some(value => String(value || "").toLowerCase().includes(query))
    );

    results.replaceChildren();

    const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    page = Math.min(page, pages);
    const start = (page - 1) * PAGE_SIZE;
    const visible = filtered.slice(start, start + PAGE_SIZE);
    if (previous) previous.disabled = page <= 1;
    if (next) next.disabled = page >= pages;
    setText("cvePageLabel", `Page ${page} of ${pages}`);

    const summary = document.createElement("p");
    summary.textContent =
      `Showing ${filtered.length ? start + 1 : 0}–${start + visible.length} of ${filtered.length} matching results (${candidates.length} product/CVE pairs in this batch). Severity counters include all results, not confirmed vulnerabilities.`;
    results.appendChild(summary);

    for (const item of visible) {
      const card = document.createElement("article");
      card.className = "cve-record";

      const heading = document.createElement("h3");
      const link = document.createElement("a");
      link.textContent = item.id;
      link.href = /^CVE-\d{4}-\d{4,}$/.test(item.id || "")
        ? `https://nvd.nist.gov/vuln/detail/${item.id}`
        : "https://nvd.nist.gov/";
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      heading.appendChild(link);

      const meta = document.createElement("p");
      meta.textContent =
        `${item.severity || "UNKNOWN"} | Product: ${item.productSearch || "Unknown"}` +
        (item.published ? ` | Published: ${displayDate(item.published)}` : "");

      const description = document.createElement("p");
      description.textContent = item.description || "No description available.";

      const warning = document.createElement("small");
      warning.textContent = matchLabel(item.matchStatus) + ". " +
        (item.matchStatus === "affected"
          ? "At least one recorded version matches supported NVD criteria. This does not confirm exploitability; review each version below."
          : item.matchStatus === "not_established"
            ? "Evaluated versions fall outside the supported criteria. This is not proof of safety."
            : "Product identity, version, or applicability still needs verification.");

      card.append(heading, meta, description, warning);
      if (Array.isArray(item.versionResults) && item.versionResults.length) {
        const versions = document.createElement("ul");
        for (const result of item.versionResults) {
          const version = document.createElement("li");
          version.textContent = `Version ${result.version || "Unknown"}: ${matchLabel(result.status)}. ${result.reason || ""}`;
          if (typeof result.evidence?.criteria === "string") {
            const evidence = document.createElement("small");
            evidence.className = "cve-evidence";
            evidence.textContent = `NVD CPE: ${result.evidence.criteria}`;
            for (const [key, label] of Object.entries({ versionStartIncluding: "From (inclusive)", versionStartExcluding: "After (exclusive)", versionEndIncluding: "Through (inclusive)", versionEndExcluding: "Before (exclusive)" })) {
              if (result.evidence[key] != null) evidence.textContent += ` · ${label}: ${result.evidence[key]}`;
            }
            version.appendChild(evidence);
          }
          versions.appendChild(version);
        }
        card.appendChild(versions);
      }
      results.appendChild(card);
    }
  }

  async function loadSecurityWatch() {
    try {
      const response = await fetch("/api/security-watch/cves", {
        cache: "no-store"
      });

      if (!response.ok) {
        throw new Error(`CVE API returned HTTP ${response.status}`);
      }

      const data = await response.json();

      securityCheckedAt = data.checkedAt || securityCheckedAt;
      if (securityCheckedAt) setText("securityUpdated", displayDate(securityCheckedAt));

      candidates = Array.isArray(data.candidates)
        ? data.candidates
        : [];

      updateCounts(candidates);
      renderCoverage(data.productResults);
      renderResults();

      if (data.scanning) {
        status.textContent =
          `Security scan running. Last completed scan: ${displayDate(data.checkedAt)}.`;
        if (data.progress) status.textContent += ` ${data.progress.phase}: ${data.progress.product}. ${data.progress.fetchedCves || 0} CVEs retrieved so far.`;
      } else if (data.error) {
        status.textContent =
          `Warning: ${data.error}. Last completed scan: ${displayDate(data.checkedAt)}.`;
      } else {
        status.textContent =
          `Last completed scan: ${displayDate(data.checkedAt)}. ` +
          `${data.searched || 0} product searches completed.`;
      }

      if (data.truncated) {
        status.textContent += " Coverage is limited.";
      }
      if (data.nvdResultsTruncated) {
        status.textContent += " Some NVD product histories could not be fully retrieved. See product coverage below.";
      }
      if (data.coverageNote) status.textContent += ` ${data.coverageNote}`;

      if (data.scanning) {
        setTimeout(loadSecurityWatch, 10000);
      }
    } catch (error) {
      console.error("Security Watch failed:", error);
      status.textContent =
        "Unable to load Security Watch. Check the browser console.";
    }
  }

  async function loadUpdateTimes() {
    try {
      const response = await fetch("/api/security-watch/status", {
        cache: "no-store"
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const data = await response.json();

      setText("inventoryUpdated", displayDate(data.inventoryUpdated));
      setText("securityUpdated", displayDate(securityCheckedAt || data.securityUpdated));
      setText("releaseUpdated", displayDate(data.releaseUpdated));
    } catch (error) {
      console.error("Last Updated timestamps failed:", error);
    }
  }

  if (search) search.addEventListener("input", () => { page = 1; renderResults(); });
  if (matchFilter) matchFilter.addEventListener("change", () => { page = 1; renderResults(); });
  if (previous) previous.addEventListener("click", () => { if (page > 1) { page--; renderResults(); } });
  if (next) next.addEventListener("click", () => { if (!next.disabled) { page++; renderResults(); } });

  loadSecurityWatch();
  loadUpdateTimes();
})();

