"use strict";

(() => {
  const fileInput = document.getElementById("csvFile");
  const form = document.getElementById("csvImportForm");
  const button = document.getElementById("csvImportButton");
  const message = document.getElementById("csvImportMessage");
  const errors = document.getElementById("csvErrors");
  const preview = document.getElementById("csvPreview");
  const body = document.getElementById("csvPreviewBody");
  const caption = document.getElementById("csvPreviewCaption");
  let pending = [], reading = 0, importing = false;

  function renderPreview() {
    body.replaceChildren();
    for (const entry of pending.slice(0, 10)) {
      const row = document.createElement("tr");
      for (const key of ["row", "name", "publisher", "version", "status"]) {
        row.appendChild(makeElement("td", String(entry[key])));
      }
      body.appendChild(row);
    }
    caption.textContent = `Preview: first ${Math.min(10, pending.length)} of ${pending.length} remaining rows`;
    preview.hidden = !pending.length;
  }

  fileInput.addEventListener("change", async () => {
    const selection = ++reading;
    pending = [];
    button.disabled = true;
    button.textContent = "Import versions";
    errors.replaceChildren();
    errors.hidden = true;
    renderPreview();
    const file = fileInput.files[0];
    if (!file) {
      message.textContent = "Choose a file to validate and preview before importing.";
      return;
    }
    message.textContent = "Reading and validating CSV…";
    try {
      if (!/\.csv$/i.test(file.name)) throw new Error("Choose a file with a .csv extension.");
      if (file.size > SoftwareCSV.MAX_BYTES) throw new Error("This file is too large. Use a CSV of 1 MB or less.");
      const text = await file.text();
      if (selection !== reading) return;
      const result = SoftwareCSV.validate(text);
      if (result.errors.length) {
        result.errors.slice(0, 20).forEach(error => errors.appendChild(makeElement("li", error)));
        errors.hidden = false;
        throw new Error(`${result.errors.length} validation issue(s). Showing up to 20 below. Fix the CSV and select it again. Nothing has been imported.`);
      }
      pending = result.rows;
      renderPreview();
      button.disabled = false;
      button.textContent = `Import ${pending.length} row(s)`;
      message.textContent = `${file.name}: ${pending.length} valid row(s). Review the preview, then import.`;
    } catch (error) {
      if (selection === reading) message.textContent = error.message;
    }
  });

  window.addEventListener("beforeunload", event => {
    if (importing) { event.preventDefault(); event.returnValue = ""; }
  });

  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (importing || !pending.length) return;
    importing = true;
    button.disabled = true;
    fileInput.disabled = true;
    form.setAttribute("aria-busy", "true");
    message.textContent = "Importing… Keep this page open until the import finishes.";
    try {
      const result = await SoftwareCSV.importRows(pending, row => fetch("/api/software", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(row)
      }), progress => {
        message.textContent = `Processing ${progress.processed} of ${progress.total}: ${progress.imported} imported, ${progress.skipped} duplicates skipped. Keep this page open.`;
      });
      pending = result.remaining;
      renderPreview();
      message.textContent = `${result.error ? "Import paused." : "Import complete."} ${result.imported} imported, ${result.skipped} duplicates skipped in this attempt. ${pending.length} remaining. ${result.error}`;
      button.textContent = pending.length ? `Retry ${pending.length} remaining row(s)` : "Import complete";
      if (result.authExpired) {
        const login = makeElement("a", " Sign in again");
        login.href = "/login.html";
        message.appendChild(login);
        pending = [];
      } else {
        await Promise.all([loadAdminInventory(), loadAuditHistory()]);
      }
    } finally {
      importing = false;
      fileInput.disabled = false;
      button.disabled = !pending.length;
      form.removeAttribute("aria-busy");
    }
  });
})();
