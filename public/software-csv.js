"use strict";

// Shared by the admin page and the Node tests; no external CSV dependency.
(function (root) {
  const MAX_ROWS = 500;
  const MAX_BYTES = 1024 * 1024;

  function parse(text) {
    const records = [];
    let fields = [], field = "", quoted = false, closed = false;
    let line = 1, startLine = 1;
    const pushField = () => { fields.push(field); field = ""; closed = false; };
    const pushRecord = () => {
      pushField();
      if (fields.length > 1 || fields.some(value => value.trim())) {
        records.push({ values: fields, row: startLine });
        if (records.length > MAX_ROWS + 1) throw new Error(`Use at most ${MAX_ROWS} data rows per file.`);
      }
      fields = [];
    };

    text = text.replace(/^\uFEFF/, "");
    if (text.includes("\0")) throw new Error("Save the file as CSV (UTF-8). NUL characters are not supported.");
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (quoted) {
        if (char === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else { quoted = false; closed = true; }
        } else {
          field += char;
          if (char === "\n" || (char === "\r" && text[i + 1] !== "\n")) line++;
        }
      } else if (char === ",") {
        pushField();
      } else if (char === "\n" || char === "\r") {
        pushRecord();
        if (char === "\r" && text[i + 1] === "\n") i++;
        line++;
        startLine = line;
      } else if (char === '"' && !field && !closed) {
        quoted = true;
      } else if (char === '"' || closed) {
        throw new Error(`CSV row ${line}: unexpected text or quote. Put fields containing commas inside double quotes.`);
      } else {
        field += char;
      }
    }
    if (quoted) throw new Error(`CSV row ${startLine}: missing closing double quote.`);
    pushRecord();
    return records;
  }

  function validate(text) {
    const records = parse(text);
    if (!records.length) throw new Error("This CSV is empty. Start with the downloadable template.");
    const aliases = Object.assign(Object.create(null), { name: "name", softwarename: "name", publisher: "publisher", version: "version", status: "status", approvalstatus: "status" });
    const headers = records.shift().values.map(value => aliases[value.trim().toLowerCase().replace(/[ _-]/g, "")]);
    if (headers.some(value => !value) || new Set(headers).size !== headers.length ||
        ["name", "publisher", "version"].some(value => !headers.includes(value))) {
      throw new Error("Use unique headers: name, publisher, version, and optionally status. Software Name and Approval Status are also accepted.");
    }
    if (!records.length) throw new Error("The CSV has headers but no software rows.");
    const errors = [], rows = [];
    const statuses = Object.assign(Object.create(null), { pending: "Pending", approved: "Approved", denied: "Denied" });
    for (const record of records) {
      if (record.values.length !== headers.length) {
        errors.push(`CSV row ${record.row}: expected ${headers.length} columns, found ${record.values.length}.`);
        continue;
      }
      const entry = { row: record.row };
      headers.forEach((header, index) => { entry[header] = record.values[index].trim(); });
      for (const key of ["name", "publisher", "version"]) {
        const max = key === "version" ? 80 : 120;
        if (!entry[key] || entry[key].length > max) errors.push(`CSV row ${record.row}: ${key} is required and must be ${max} characters or fewer.`);
      }
      entry.status = statuses[(entry.status || "Pending").toLowerCase()];
      if (!entry.status) errors.push(`CSV row ${record.row}: status must be Pending, Approved, or Denied.`);
      rows.push(entry);
    }
    return { rows, errors };
  }

  // Keep successful saves when a later request fails. The remaining rows can
  // be retried; the existing API rejects duplicate versions without updating them.
  async function importRows(rows, send, onProgress = () => {}) {
    let imported = 0, skipped = 0, processed = 0;
    for (const entry of rows) {
      const { name, publisher, version, status } = entry;
      try {
        const response = await send({ name, publisher, version, status });
        if (response.status === 401) {
          return { imported, skipped, remaining: rows.slice(processed), error: "Your session expired. Sign in again and reselect the CSV; saved versions will be skipped.", authExpired: true };
        }
        if (response.status === 409) skipped++;
        else if (response.ok) imported++;
        else {
          const result = await response.json().catch(() => ({}));
          throw new Error(result.error || `Request failed (${response.status}).`);
        }
        processed++;
        onProgress({ imported, skipped, processed, total: rows.length });
      } catch (error) {
        return { imported, skipped, remaining: rows.slice(processed), error: `Stopped at CSV row ${entry.row}: ${error.message} Retry the remaining rows. If the last request was saved, it will be skipped on retry.` };
      }
    }
    return { imported, skipped, remaining: [], error: "" };
  }

  const api = { validate, importRows, MAX_ROWS, MAX_BYTES };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SoftwareCSV = api;
})(globalThis);
