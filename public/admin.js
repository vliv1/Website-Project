


"use strict";

// SoftTrack V3 Administrator Dashboard
// Phase 1: Read-only administrator inventory.

const adminEmail = document.getElementById("adminEmail");
const logoutButton = document.getElementById("logoutButton");
const adminContent = document.getElementById("adminContent");
const adminMessage = document.getElementById("adminMessage");
const adminSoftwareList =
  document.getElementById("adminSoftwareList");

const adminSearch = document.getElementById("adminSearch");
const adminStatusFilter =
  document.getElementById("adminStatusFilter");

const refreshButton =
  document.getElementById("refreshButton");

let softwareInventory = [];

function setAdminCount(id, value) {
  document.getElementById(id).textContent = String(value);
}

function updateAdminStats() {
  const versions = softwareInventory.flatMap(
    software => software.versions || []
  );

  setAdminCount("softwareCount", softwareInventory.length);

  setAdminCount(
    "approvedCount",
    versions.filter(v => v.status === "Approved").length
  );

  setAdminCount(
    "pendingCount",
    versions.filter(v => v.status === "Pending").length
  );

  setAdminCount(
    "deniedCount",
    versions.filter(v => v.status === "Denied").length
  );
}

function makeElement(tag, text, className = "") {
  const element = document.createElement(tag);
  element.textContent = text;

  if (className) element.className = className;

  return element;
}


/* ==========================================
   EDIT SOFTWARE VERSION / APPROVAL STATUS
   ========================================== */

function createVersionEditor(version) {
  const editor = document.createElement("form");
  editor.className = "admin-version-editor";

  const versionLabel = makeElement("label", "Version number");

  const versionInput = document.createElement("input");
  versionInput.type = "text";
  versionInput.value = version.number;
  versionInput.maxLength = 80;
  versionInput.required = true;

  const statusLabel = makeElement("label", "Approval status");

  const statusSelect = document.createElement("select");

  ["Pending", "Approved", "Denied"].forEach(status => {
    const option = document.createElement("option");
    option.value = status;
    option.textContent = status;
    option.selected = status === version.status;
    statusSelect.appendChild(option);
  });

  const buttonRow = document.createElement("div");
  buttonRow.className = "admin-edit-actions";

  const saveButton = makeElement("button", "Save Changes");
  saveButton.type = "submit";
  saveButton.className = "admin-edit-save";

  const cancelButton = makeElement("button", "Cancel");
  cancelButton.type = "button";
  cancelButton.className = "admin-edit-cancel";

  const message = makeElement("p", "");
  message.setAttribute("role", "status");
  message.setAttribute("aria-live", "polite");

  buttonRow.append(saveButton, cancelButton);

  editor.append(
    versionLabel,
    versionInput,
    statusLabel,
    statusSelect,
    buttonRow,
    message
  );

  cancelButton.addEventListener("click", () => {
    renderAdminInventory();
  });

  editor.addEventListener("submit", async event => {
    event.preventDefault();

    const newVersion = versionInput.value.trim();
    const newStatus = statusSelect.value;

    if (!newVersion) {
      message.textContent = "Version number is required.";
      return;
    }

    if (
      newVersion === version.number &&
      newStatus === version.status
    ) {
      message.textContent = "No changes to save.";
      return;
    }

    saveButton.disabled = true;
    cancelButton.disabled = true;
    message.textContent = "Saving changes...";

    try {
      const response = await fetch(
        `/api/software/versions/${encodeURIComponent(version.id)}`,
        {
          method: "PATCH",
          credentials: "same-origin",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            version: newVersion,
            status: newStatus
          })
        }
      );

      const result = await response.json();

      if (!response.ok) {
        if (response.status === 401) {
          window.location.replace("/login.html");
          return;
        }

        throw new Error(
          result.error || "Unable to update software version."
        );
      }

      await loadAdminInventory();

      adminMessage.textContent =
        `Version ${newVersion} updated successfully.`;

    } catch (error) {
      console.error("Version edit failed:", error);
      message.textContent =
        error.message || "Unable to save changes.";
    } finally {
      saveButton.disabled = false;
      cancelButton.disabled = false;
    }
  });

  return editor;
}


function renderAdminInventory() {
  adminSoftwareList.replaceChildren();

  const query = adminSearch.value.trim().toLowerCase();
  const selectedStatus = adminStatusFilter.value;

  const filtered = softwareInventory
    .map(software => {
      const groupMatches =
        software.name.toLowerCase().includes(query) ||
        software.publisher.toLowerCase().includes(query);

      const versions = (software.versions || []).filter(v => {
        const statusMatches =
          selectedStatus === "All" ||
          v.status === selectedStatus;

        const searchMatches =
          !query ||
          groupMatches ||
          String(v.number).toLowerCase().includes(query);

        return statusMatches && searchMatches;
      });

      return { ...software, versions };
    })
    .filter(software =>
      software.versions.length > 0 ||
      (
        selectedStatus === "All" &&
        (
          software.name.toLowerCase().includes(query) ||
          software.publisher.toLowerCase().includes(query)
        )
      )
    );

  if (filtered.length === 0) {
    adminMessage.textContent =
      "No software records match your filters.";
    return;
  }

  adminMessage.textContent = "";

  filtered.forEach(software => {
    const card = document.createElement("article");
    card.className = "admin-software-card";

    const title = makeElement(
      "h3",
      software.name,
      "admin-software-title"
    );

    const publisher = makeElement(
      "p",
      software.publisher,
      "admin-publisher"
    );

    card.append(title, publisher);

    
software.versions.forEach(version => {
  const row = document.createElement("div");
  row.className = "admin-version-row";

  const number = makeElement(
    "span",
    `Version ${version.number}`
  );

  const status = makeElement(
    "span",
    version.status,
    `admin-status status-${version.status.toLowerCase()}`
  );

  const editButton = makeElement("button", "✏️ Edit");
  editButton.type = "button";
  editButton.className = "admin-edit-button";

  editButton.addEventListener("click", () => {
    // Show the editor below this version.
    const existingEditor = row.querySelector(
      ".admin-version-editor"
    );

    if (existingEditor) {
      existingEditor.remove();
      return;
    }

    const editor = createVersionEditor(version);
    row.appendChild(editor);
  });

  row.append(number, status, editButton);
  card.appendChild(row);
});


    adminSoftwareList.appendChild(card);
  });
}

async function loadAdminInventory() {
  adminMessage.textContent = "Loading software inventory...";
  refreshButton.disabled = true;

  try {
    const response = await fetch("/api/software", {
      credentials: "same-origin",
      cache: "no-store"
    });

    if (!response.ok) {
      throw new Error("Inventory request failed");
    }

    const data = await response.json();

    if (!Array.isArray(data)) {
      throw new Error("Invalid inventory response");
    }

    softwareInventory = data;
    updateAdminStats();
    renderAdminInventory();
  } catch (error) {
    console.error("Admin inventory error:", error);
    adminMessage.textContent =
      "Unable to load software inventory.";
  } finally {
    refreshButton.disabled = false;
  }
}

async function loadAdmin() {
  try {
    const response = await fetch("/api/admin/me", {
      credentials: "same-origin",
      cache: "no-store"
    });

    if (response.status === 401) {
      window.location.replace("/login.html");
      return;
    }

    if (!response.ok) {
      throw new Error("Unable to verify session");
    }

    const result = await response.json();

    if (!result.authenticated) {
      window.location.replace("/login.html");
      return;
    }

    adminEmail.textContent =
      `Signed in as: ${result.email}`;

    adminContent.hidden = false;

    await loadAdminInventory();
  } catch (error) {
    console.error("Session verification failed:", error);

    adminEmail.textContent =
      "Unable to verify administrator session.";

    adminContent.hidden = true;
    logoutButton.disabled = true;
  }
}

logoutButton.addEventListener("click", async () => {
  logoutButton.disabled = true;

  try {
    const response = await fetch("/api/admin/logout", {
      method: "POST",
      credentials: "same-origin"
    });

    if (!response.ok) {
      throw new Error("Logout failed");
    }

    window.location.replace("/login.html");
  } catch {
    logoutButton.disabled = false;
    alert("Unable to sign out. Please try again.");
  }
});

adminSearch.addEventListener("input", renderAdminInventory);

adminStatusFilter.addEventListener(
  "change",
  renderAdminInventory
);

refreshButton.addEventListener(
  "click",
  loadAdminInventory
);


// Highlight the selected admin navigation link

const adminNavLinks = document.querySelectorAll(
  ".admin-sidebar-links a"
);

function updateActiveAdminLink() {
  const currentHash = window.location.hash || "#adminDashboard";

  adminNavLinks.forEach(link => {
    const isActive = link.getAttribute("href") === currentHash;

    link.classList.toggle("active", isActive);

    if (isActive) {
      link.setAttribute("aria-current", "location");
    } else {
      link.removeAttribute("aria-current");
    }
  });
}

window.addEventListener("hashchange", updateActiveAdminLink);
updateActiveAdminLink();

// ==========================================
// SoftTrack V3 Admin Light / Dark Mode
// ==========================================

const adminThemeToggle =
  document.getElementById("adminThemeToggle");

const adminThemeStorageKey = "softTrackAdminTheme";

function getInitialAdminTheme() {
  try {
    const savedTheme = localStorage.getItem(adminThemeStorageKey);

    if (savedTheme === "light" || savedTheme === "dark") {
      return savedTheme;
    }
  } catch (error) {
    console.warn("Theme preference unavailable:", error);
  }

  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function applyAdminTheme(theme) {
  document.body.dataset.theme = theme;

  const isDark = theme === "dark";

  adminThemeToggle.textContent = isDark
    ? "☀️ Light Mode"
    : "🌙 Dark Mode";

  adminThemeToggle.setAttribute(
    "aria-label",
    isDark ? "Switch to light mode" : "Switch to dark mode"
  );

  adminThemeToggle.setAttribute(
    "aria-pressed",
    String(isDark)
  );
}

applyAdminTheme(getInitialAdminTheme());

adminThemeToggle.addEventListener("click", () => {
  const nextTheme =
    document.body.dataset.theme === "dark"
      ? "light"
      : "dark";

  applyAdminTheme(nextTheme);

  try {
    localStorage.setItem(adminThemeStorageKey, nextTheme);
  } catch (error) {
    console.warn("Unable to save theme preference:", error);
  }
});


/* ==========================================
   ADD SOFTWARE — NEON POSTGRESQL
   ========================================== */

const adminSoftwareForm =
  document.getElementById("adminSoftwareForm");

const addSoftwareButton =
  document.getElementById("addSoftwareButton");

const addSoftwareMessage =
  document.getElementById("addSoftwareMessage");

adminSoftwareForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const name =
    document.getElementById("newSoftwareName").value.trim();

  const publisher =
    document.getElementById("newPublisher").value.trim();

  const version =
    document.getElementById("newVersion").value.trim();

  const status =
    document.getElementById("newStatus").value;

  if (!name || !publisher || !version) {
    addSoftwareMessage.textContent =
      "Please complete all required fields.";
    return;
  }

  addSoftwareButton.disabled = true;
  addSoftwareMessage.textContent = "Saving software...";

  try {
    const response = await fetch("/api/software", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        name,
        publisher,
        version,
        status
      })
    });

    const result = await response.json();

    if (!response.ok) {
      if (response.status === 401) {
        window.location.replace("/login.html");
        return;
      }

      throw new Error(
        result.error || "Unable to add software."
      );
    }

    addSoftwareMessage.textContent =
      `Success! ${name} version ${version} was added.`;

    adminSoftwareForm.reset();

    await loadAdminInventory();

  } catch (error) {
    console.error("Add Software error:", error);

    addSoftwareMessage.textContent =
      error.message || "Unable to save software.";
  } finally {
    addSoftwareButton.disabled = false;
  }
});


/* ==========================================
   SOFTTRACK V3 AUDIT HISTORY
   ========================================== */

const auditHistoryList =
  document.getElementById("auditHistoryList");

const auditMessage =
  document.getElementById("auditMessage");

const refreshAuditButton =
  document.getElementById("refreshAuditButton");

function formatAuditAction(action) {
  const labels = {
    created: "Software Version Created",
    status_changed: "Approval Status Changed",
    version_updated: "Software Version Updated",
    deleted: "Software Version Deleted"
  };

  return labels[action] || action;
}

function renderAuditHistory(events) {
  auditHistoryList.replaceChildren();

  if (events.length === 0) {
    auditMessage.textContent =
      "No audit events have been recorded yet.";
    return;
  }

  auditMessage.textContent =
    `Showing ${events.length} recent audit events.`;

  events.forEach(event => {
    const card = document.createElement("article");
    card.className = "admin-audit-card";

    const title = makeElement(
      "h3",
      formatAuditAction(event.action)
    );

    const software = makeElement(
      "p",
      `${event.software_name} · Version ${event.version}`
    );

    const publisher = makeElement(
      "p",
      `Publisher: ${event.publisher}`
    );

    const administrator = makeElement(
      "p",
      `Administrator: ${event.admin_email}`
    );

    const date = new Date(event.created_at);

    const timestamp = makeElement(
      "p",
      `Date: ${
        Number.isNaN(date.getTime())
          ? "Unknown"
          : date.toLocaleString()
      }`
    );

    card.append(
      title,
      software,
      publisher
    );

    if (
      event.action === "status_changed" ||
      event.action === "created"
    ) {
      const status = makeElement(
        "p",
        `Status: ${event.old_status || "None"} → ${
          event.new_status || "None"
        }`
      );

      card.appendChild(status);
    }

    card.append(administrator, timestamp);
    auditHistoryList.appendChild(card);
  });
}

async function loadAuditHistory() {
  auditMessage.textContent = "Loading audit history...";
  refreshAuditButton.disabled = true;

  try {
    const response = await fetch("/api/software/audit", {
      credentials: "same-origin",
      cache: "no-store"
    });

    if (response.status === 401) {
      window.location.replace("/login.html");
      return;
    }

    if (!response.ok) {
      throw new Error("Unable to retrieve audit history.");
    }

    const events = await response.json();

    if (!Array.isArray(events)) {
      throw new Error("Invalid audit history response.");
    }

    renderAuditHistory(events);

  } catch (error) {
    console.error("Audit history error:", error);
    auditMessage.textContent =
      "Unable to load audit history. Please try again.";

  } finally {
    refreshAuditButton.disabled = false;
  }
}

refreshAuditButton.addEventListener(
  "click",
  loadAuditHistory
);

// Load history when the Audit sidebar link is selected.
window.addEventListener("hashchange", () => {
  if (window.location.hash === "#adminAudit") {
    loadAuditHistory();
  }
});

// Also handle opening the dashboard directly at #adminAudit.
if (window.location.hash === "#adminAudit") {
  // Wait until administrator session verification finishes.
  // The protected API still checks the session.
  loadAuditHistory();
}


loadAdmin();
