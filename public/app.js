
"use strict";

// SoftTrack V3 — Public read-only inventory
// This file does not write to Neon or localStorage.

const softwareList = document.getElementById("softwareList");
const emptyMessage = document.getElementById("emptyMessage");
const searchInput = document.getElementById("search");
const statusFilter = document.getElementById("statusFilter");
const exportBtn = document.getElementById("exportBtn");

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

function getFilteredInventory() {
  const query = searchInput.value.trim().toLowerCase();
  const selectedStatus = statusFilter.value;

  return inventory
    .map(software => {
      const groupMatches =
        software.name.toLowerCase().includes(query) ||
        software.publisher.toLowerCase().includes(query);

      const versions = (software.versions || []).filter(v => {
        const matchesStatus =
          selectedStatus === "All" ||
          v.status === selectedStatus;

        const matchesSearch =
          !query ||
          groupMatches ||
          String(v.number).toLowerCase().includes(query);

        return matchesStatus && matchesSearch;
      });

      return { ...software, versions };
    })
    .filter(software => {
      const hasVersions = software.versions.length > 0;

      const matchesGroup =
        software.name.toLowerCase().includes(query) ||
        software.publisher.toLowerCase().includes(query);

      return hasVersions ||
        (statusFilter.value === "All" && matchesGroup);
    });
}

function createTextElement(tag, text, className = "") {
  const element = document.createElement(tag);
  element.textContent = text;

  if (className) element.className = className;

  return element;
}

function renderInventory() {
  softwareList.replaceChildren();

  const filtered = getFilteredInventory();

  if (filtered.length === 0) {
    emptyMessage.hidden = false;
    emptyMessage.textContent = loadError
      ? "Unable to load software inventory."
      : "No software records match your filters.";
    return;
  }

  emptyMessage.hidden = true;

  filtered.forEach(software => {
    const card = document.createElement("article");
    card.className = "software-group";

    const heading = document.createElement("div");
    heading.className = "software-heading";

    const title = createTextElement(
      "h3",
      software.name,
      "software-title"
    );

    const publisher = createTextElement(
      "p",
      software.publisher,
      "software-publisher"
    );

    heading.append(title, publisher);
    card.appendChild(heading);

    const versions = document.createElement("div");
    versions.className = "software-versions";

    if (software.versions.length === 0) {
      versions.appendChild(
        createTextElement(
          "p",
          "No versions recorded.",
          "help-text"
        )
      );
    }

    software.versions.forEach(version => {
      const row = document.createElement("div");
      row.className = "version-row";

      const number = createTextElement(
        "span",
        `Version ${version.number}`,
        "version-number"
      );

      const status = createTextElement(
        "span",
        version.status,
        "status-badge"
      );

      status.classList.add(
        `status-${version.status.toLowerCase()}`
      );

      row.append(number, status);
      versions.appendChild(row);
    });

    card.appendChild(versions);
    softwareList.appendChild(card);
  });
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

  getFilteredInventory().forEach(software => {
    software.versions.forEach(version => {
      rows.push([
        software.name,
        software.publisher,
        version.number,
        version.status
      ]);
    });
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
  renderInventory();
}

searchInput.addEventListener("input", renderInventory);
statusFilter.addEventListener("change", renderInventory);
exportBtn.addEventListener("click", exportCsv);

loadInventory();
