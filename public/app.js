
const V1_KEY = "softwareApprovalTrackerV1";
const V2_KEY = "softwareApprovalTrackerV2";

const STATUSES = ["Approved", "Pending", "Denied"];

let software = [];

// Generate unique identifiers
function newId() {
  return crypto.randomUUID();
}

// Read saved data safely
function readStorage(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? null : JSON.parse(raw);
  } catch (error) {
    console.error("Storage read failed:", error);
    return null;
  }
}

// Convert Version 1 entries to Version 2
function migrateV1(oldEntries) {
  const groups = [];

  for (const item of oldEntries) {
    if (!item ||
        typeof item.name !== "string" ||
        typeof item.publisher !== "string") {
      continue;
    }

    const name = item.name.trim();
    const publisher = item.publisher.trim();

    if (!name || !publisher) continue;

    const status = STATUSES.includes(item.status)
      ? item.status
      : "Pending";

    let group = groups.find(g =>
      g.name.toLowerCase() === name.toLowerCase() &&
      g.publisher.toLowerCase() === publisher.toLowerCase()
    );

    if (!group) {
      group = {
        id: newId(),
        name,
        publisher,
        versions: []
      };
      groups.push(group);
    }

    group.versions.push({
      id: newId(),
      number: "Unspecified",
      status
    });
  }

  return groups;
}

// Load V2, or migrate V1 on first launch
function loadSoftware() {
  const savedV2 = readStorage(V2_KEY);

  if (Array.isArray(savedV2)) {
    return savedV2;
  }

  // Do not overwrite an existing V2 key
  if (localStorage.getItem(V2_KEY) !== null) {
    alert("V2 data could not be read. Export or back up your browser data before making changes.");
    throw new Error("Invalid V2 storage");
  }

  const savedV1 = readStorage(V1_KEY);

  if (localStorage.getItem(V1_KEY) !== null &&
      !Array.isArray(savedV1)) {
    alert("V1 data could not be read. Migration stopped to protect your existing data.");
    throw new Error("Invalid V1 storage");
  }

  const migrated = migrateV1(savedV1 || []);

  // Write V2 without changing V1
  localStorage.setItem(V2_KEY, JSON.stringify(migrated));

  return migrated;
}

software = loadSoftware();

// DOM references
const form = document.getElementById("softwareForm");
const list = document.getElementById("softwareList");
const search = document.getElementById("search");
const filter = document.getElementById("statusFilter");

function saveSoftware() {
  try {
    localStorage.setItem(V2_KEY, JSON.stringify(software));
    return true;
  } catch (error) {
    alert("Could not save changes. Browser storage may be full.");
    return false;
  }
}

function updateDashboard() {
  const versions = software.flatMap(g => g.versions);

  document.getElementById("softwareCount").textContent =
    software.length;

  for (const status of STATUSES) {
    const count = versions.filter(
      v => v.status === status
    ).length;

    document.getElementById(
      status.toLowerCase() + "Count"
    ).textContent = count;
  }
}

function createStatusSelect(version, group) {
  const select = document.createElement("select");
  select.className = "status-select";

  for (const status of STATUSES) {
    const option = document.createElement("option");
    option.value = status;
    option.textContent =
      status === "Pending" ? "Pending Approval" : status;
    select.appendChild(option);
  }

  select.value = version.status;

  select.addEventListener("change", () => {
    const previous = version.status;
    version.status = select.value;

    if (!saveSoftware()) {
      version.status = previous;
    }

    refresh();
  });

  return select;
}

function renderSoftware() {
  // Remember which groups are expanded
  const openGroups = new Set(
    [...list.querySelectorAll("details[open]")]
      .map(element => element.dataset.id)
  );

  list.replaceChildren();

  const term = search.value.toLowerCase().trim();
  const selectedStatus = filter.value;

  let visibleCount = 0;

  for (const group of software) {
    const matchesText =
      group.name.toLowerCase().includes(term) ||
      group.publisher.toLowerCase().includes(term) ||
      group.versions.some(v =>
        v.number.toLowerCase().includes(term)
      );

    if (!matchesText) continue;

    const visibleVersions = group.versions.filter(v =>
      selectedStatus === "All" ||
      v.status === selectedStatus
    );

    if (!visibleVersions.length) continue;

    visibleCount++;

    const details = document.createElement("details");
    details.className = "software-group";
    details.dataset.id = group.id;

    if (openGroups.has(group.id) || term) {
      details.open = true;
    }

    const summary = document.createElement("summary");
    summary.className = "group-heading";

    const heading = document.createElement("div");

    const title = document.createElement("strong");
    title.textContent = group.name;

    const subtitle = document.createElement("small");
    subtitle.textContent =
      `${group.publisher} · ${group.versions.length} version(s)`;

    heading.append(title, subtitle);
    summary.appendChild(heading);
    details.appendChild(summary);

    for (const version of visibleVersions) {
      const row = document.createElement("div");
      row.className = "version-row";

      const versionText = document.createElement("span");
      versionText.textContent = `Version ${version.number}`;

      const select = createStatusSelect(version, group);

      const deleteButton = document.createElement("button");
      deleteButton.className = "danger";
      deleteButton.textContent = "Delete";

      deleteButton.addEventListener("click", () => {
        if (!confirm(
          `Delete ${group.name} version ${version.number}?`
        )) return;

        const previous = group.versions;

        group.versions = group.versions.filter(
          v => v.id !== version.id
        );

        // Remove the group if no versions remain
        const previousSoftware = [...software];

        if (group.versions.length === 0) {
          software = software.filter(g => g.id !== group.id);
        }

        if (!saveSoftware()) {
          software = previousSoftware;
          group.versions = previous;
        }

        refresh();
      });

      row.append(versionText, select, deleteButton);
      details.appendChild(row);
    }

    list.appendChild(details);
  }

  document.getElementById("emptyMessage").hidden =
    visibleCount > 0;
}

function refresh() {
  updateDashboard();
  renderSoftware();
}

// Add a software version
form.addEventListener("submit", event => {
  event.preventDefault();

  const name = document.getElementById("softwareName")
    .value.trim();
  const publisher = document.getElementById("publisher")
    .value.trim();
  const number = document.getElementById("version")
    .value.trim();
  const status = document.getElementById("status").value;

  if (!name || !publisher || !number ||
      !STATUSES.includes(status)) return;

  let group = software.find(g =>
    g.name.toLowerCase() === name.toLowerCase() &&
    g.publisher.toLowerCase() === publisher.toLowerCase()
  );

  // Prevent duplicate version numbers within a group
  if (group && group.versions.some(v =>
    v.number.toLowerCase() === number.toLowerCase()
  )) {
    alert("This software version already exists.");
    return;
  }

  const previous = JSON.stringify(software);

  if (!group) {
    group = {
      id: newId(),
      name,
      publisher,
      versions: []
    };

    software.push(group);
  }

  group.versions.push({
    id: newId(),
    number,
    status
  });

  if (!saveSoftware()) {
    software = JSON.parse(previous);
    return;
  }

  refresh();
  form.reset();
  document.getElementById("softwareName").focus();
});

search.addEventListener("input", renderSoftware);
filter.addEventListener("change", renderSoftware);

// CSV export
document.getElementById("exportBtn")
  .addEventListener("click", () => {

    const safeCell = value => {
      let text = String(value);

      // Prevent spreadsheet formula execution
      if (/^\s*[=+\-@]/.test(text)) {
        text = "'" + text;
      }

      return '"' + text.replace(/"/g, '""') + '"';
    };

    const rows = [
      ["Software Name", "Publisher", "Version", "Status"]
    ];

    for (const group of software) {
      for (const version of group.versions) {
        rows.push([
          group.name,
          group.publisher,
          version.number,
          version.status
        ]);
      }
    }

    const csv = rows
      .map(row => row.map(safeCell).join(","))
      .join("\r\n");

    const blob = new Blob([csv], {
      type: "text/csv;charset=utf-8"
    });

    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = "software-versions.csv";
    document.body.appendChild(link);
    link.click();
    link.remove();

    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

// Initialize
refresh();
