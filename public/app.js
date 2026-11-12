
"use strict";

// SoftTrack V3 — Public read-only inventory
// This file does not write to Neon or localStorage.

const softwareList = document.getElementById("softwareList");
const emptyMessage = document.getElementById("emptyMessage");
const searchInput = document.getElementById("search");
const statusFilter = document.getElementById("statusFilter");
const exportBtn = document.getElementById("exportBtn");

const publicInventoryTable = softwareList ? InventoryTable.create({ container: softwareList }) : null;
let inventory = [];
let loadError = false;

function setCount(id, value) {
  const element = document.getElementById(id);
  if (element) element.textContent = String(value);
}

function updateDashboard() {
  const versions = inventory.flatMap(
    software => software.versions || []
  );

  setCount("softwareCount", inventory.length);
  setCount(
    "approvedCount",
    versions.filter(v => v.status === "Approved").length
  );
  setCount(
    "pendingCount",
    versions.filter(v => v.status === "Pending").length
  );
  setCount(
    "deniedCount",
    versions.filter(v => v.status === "Denied").length
  );
}

// Draw the Dashboard chart using the same version counts as the cards.
function renderApprovalChart() {
  const container = document.getElementById("approvalChart");
  if (!container) return; // Inventory page has no chart.

  container.replaceChildren();

  if (loadError) {
    container.textContent =
      "Unable to load approval data. Please refresh to try again.";
    return;
  }

  const versions = inventory.flatMap(
    software => software.versions || []
  );

  const statuses = [
    {
      label: "Approved",
      count: versions.filter(v => v.status === "Approved").length,
      color: "#16875d"
    },
    {
      label: "Pending",
      count: versions.filter(v => v.status === "Pending").length,
      color: "#e5a32b"
    },
    {
      label: "Denied",
      count: versions.filter(v => v.status === "Denied").length,
      color: "#d64f5b"
    }
  ];

  const total = statuses.reduce(
    (sum, item) => sum + item.count,
    0
  );

  if (total === 0) {
    container.textContent = "No approval statuses to chart yet.";
    return;
  }

  const wrapper = document.createElement("div");
  wrapper.style.cssText =
    "display:flex;flex-wrap:wrap;align-items:center;" +
    "justify-content:center;gap:32px;padding:16px 0;";

  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");

  svg.setAttribute("viewBox", "0 0 240 240");
  svg.setAttribute("width", "240");
  svg.setAttribute("height", "240");
  svg.setAttribute("role", "img");

  svg.setAttribute(
    "aria-label",
    `Approval status: ${statuses
      .map(s => `${s.label} ${s.count}`)
      .join(", ")}. Total ${total} versions.`
  );

  svg.style.cssText =
    "max-width:100%;height:auto;flex:0 1 240px;";

  const radius = 82;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;

  statuses.forEach(item => {
    if (item.count === 0) return;

    const circle = document.createElementNS(ns, "circle");

    circle.setAttribute("cx", "120");
    circle.setAttribute("cy", "120");
    circle.setAttribute("r", String(radius));
    circle.setAttribute("fill", "none");
    circle.setAttribute("stroke", item.color);
    circle.setAttribute("stroke-width", "28");

    circle.setAttribute(
      "stroke-dasharray",
      `${item.count / total * circumference} ${circumference}`
    );

    circle.setAttribute(
      "stroke-dashoffset",
      String(-offset)
    );

    circle.setAttribute(
      "transform",
      "rotate(-90 120 120)"
    );

    svg.appendChild(circle);

    offset += item.count / total * circumference;
  });

  const centerNumber = document.createElementNS(ns, "text");

  centerNumber.setAttribute("x", "120");
  centerNumber.setAttribute("y", "119");
  centerNumber.setAttribute("text-anchor", "middle");
  centerNumber.setAttribute("font-size", "36");
  centerNumber.setAttribute("font-weight", "700");
  centerNumber.setAttribute("fill", "currentColor");
  centerNumber.textContent = String(total);

  svg.appendChild(centerNumber);

  const centerLabel = document.createElementNS(ns, "text");

  centerLabel.setAttribute("x", "120");
  centerLabel.setAttribute("y", "143");
  centerLabel.setAttribute("text-anchor", "middle");
  centerLabel.setAttribute("font-size", "13");
  centerLabel.setAttribute("fill", "currentColor");
  centerLabel.textContent = "Versions";

  svg.appendChild(centerLabel);
  wrapper.appendChild(svg);

  const legend = document.createElement("div");

  legend.style.cssText =
    "display:grid;gap:14px;min-width:200px;";

  statuses.forEach(item => {
    const row = document.createElement("div");

    row.style.cssText =
      "display:flex;align-items:center;gap:10px;" +
      "justify-content:space-between;";

    const label = document.createElement("span");

    label.style.cssText =
      "display:flex;align-items:center;gap:8px;";

    const dot = document.createElement("span");

    dot.style.cssText =
      `width:12px;height:12px;border-radius:50%;` +
      `background:${item.color};display:inline-block;flex:none;`;

    label.append(dot, document.createTextNode(item.label));

    const value = document.createElement("strong");

    value.textContent =
      `${item.count} (${Math.round(item.count / total * 100)}%)`;

    row.append(label, value);
    legend.appendChild(row);
  });

  wrapper.appendChild(legend);
  container.appendChild(wrapper);
}

function renderInventory() {
  if (!publicInventoryTable) return;
  if (emptyMessage) emptyMessage.hidden = true;
  publicInventoryTable.update(inventory, {
    query: searchInput?.value || "",
    status: statusFilter?.value || "All",
    error: loadError ? "Unable to load software inventory. Please refresh to try again." : ""
  });
  if (exportBtn) exportBtn.disabled = loadError;
}

function escapeCsv(value) {
  const text = String(value ?? "");

  // Prevent spreadsheet formula injection.
  const safe = /^[\s]*[=+\-@\t\r]/.test(text)
    ? "'" + text
    : text;

  return '"' + safe.replaceAll('"', '""') + '"';
}

function exportCsv() {
  const rows = [
    ["Software", "Publisher", "Version", "Status"]
  ];

  // Export every matching row in the selected sort order, across all pages.
  publicInventoryTable.getFilteredRows().forEach(row => {
    if (row.version) rows.push([row.name, row.publisher, row.number, row.status]);
  });

  const csv = rows
    .map(row => row.map(escapeCsv).join(","))
    .join("\r\n");

  const blob = new Blob(["\uFEFF" + csv], {
    type: "text/csv;charset=utf-8"
  });

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = "softtrack-inventory.csv";

  document.body.appendChild(link);
  link.click();
  link.remove();

  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function loadInventory() {
  try {
    const response = await fetch("/api/software", {
      cache: "no-store"
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();

    if (!Array.isArray(data)) {
      throw new Error("Invalid inventory response");
    }

    inventory = data;
    loadError = false;

  } catch (error) {
    console.error("Inventory loading failed:", error);

    inventory = [];
    loadError = true;
  }

  updateDashboard();
  renderApprovalChart();

  // The async chart changes the height above Security Watch. Re-align a direct
  // CVE link once that layout is ready, keeping it below the mobile toolbar.
  if (window.location.hash === "#cve") {
    document.getElementById("cve")?.scrollIntoView({ block: "start" });
  }

  // Render the table only on the Inventory page.
  if (softwareList && emptyMessage) {
    renderInventory();
  }
}

// Register Inventory controls only when they exist.
if (searchInput) {
  searchInput.addEventListener("input", renderInventory);
}

if (statusFilter) {
  statusFilter.addEventListener("change", renderInventory);
}

if (exportBtn) {
  exportBtn.addEventListener("click", exportCsv);
}

// Load read-only software data for either page.
loadInventory();
