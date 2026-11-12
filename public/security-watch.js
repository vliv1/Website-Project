
"use strict";

(() => {
  const byId = id => document.getElementById(id);

  const status = byId("cveScanStatus");
  const results = byId("cveResults");
  const search = byId("cveSearch");

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
  }

  function renderResults() {
    const query = (search?.value || "").trim().toLowerCase();

    const filtered = candidates.filter(item =>
      [item.id, item.productSearch, item.description, matchLabel(item.matchStatus),
        ...(Array.isArray(item.versionResults) ? item.versionResults : [])
          .map(result => `${result.version || "Unknown"} ${matchLabel(result.status)} ${result.reason || ""}`)]
        .some(value => String(value || "").toLowerCase().includes(query))
    );

    results.replaceChildren();

    const summary = document.createElement("p");
    summary.textContent =
      `Showing ${filtered.length} of ${candidates.length} CVE candidates. Severity counters include all candidates, not confirmed vulnerabilities.`;
    results.appendChild(summary);

    for (const item of filtered) {
      const card = document.createElement("article");
      card.style.padding = "14px";
      card.style.marginBottom = "12px";
      card.style.border = "1px solid #8885";
      card.style.borderRadius = "10px";

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
        `${item.severity || "UNKNOWN"} | Search: ${item.productSearch || "Unknown"}`;

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
            evidence.style.display = "block";
            evidence.textContent = `NVD CPE: ${result.evidence.criteria}`;
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
      renderResults();

      if (data.scanning) {
        status.textContent =
          `Security scan running. Last completed scan: ${displayDate(data.checkedAt)}.`;
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
        status.textContent += " NVD returned more CVEs than the 20-per-product search limit.";
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

  if (search) search.addEventListener("input", renderResults);

  loadSecurityWatch();
  loadUpdateTimes();
})();

