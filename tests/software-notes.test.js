"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const express = require("express");
const InventoryTable = require("../public/inventory-table");
const { createDocument, descendants } = require("./helpers/dom");

const id = "11111111-1111-4111-8111-111111111111";
function setup({ failAudit = false } = {}) {
  const queries = [];
  const original = { id, version: "1.0", status: "Approved", notes: "Reviewed by IT", software_name: "App", publisher: "Vendor" };
  let stored = { ...original }, pending = null;
  const client = {
    release() {},
    async query(sql, params = []) {
      queries.push({ sql, params: Array.from(params) });
      if (sql === "BEGIN") pending = { ...stored };
      if (sql === "COMMIT") stored = pending;
      if (sql === "ROLLBACK") pending = null;
      if (sql.includes("FOR UPDATE OF v")) return { rows: [{ ...stored }], rowCount: 1 };
      if (sql.includes("UPDATE software_versions")) {
        pending = { ...pending, version: params[0], status: params[1], notes: params[3] };
        return { rows: [{ ...pending }], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO softtrack_audit_events") && failAudit) throw new Error("Audit unavailable");
      if (sql.includes("SELECT id") && sql.includes("FROM software_versions")) return { rows: [], rowCount: 0 };
      if (sql.includes("SELECT id") && sql.includes("FROM software")) return { rows: [{ id }], rowCount: 1 };
      if (sql.includes("INSERT INTO software_versions")) {
        pending = { ...original, version: params[1], status: params[2], notes: params[3] };
        return { rows: [{ ...pending }], rowCount: 1 };
      }
      if (sql.includes("json_agg")) {
        assert.match(sql, /'notes', v.notes/);
        return { rows: [{ name: "App", versions: [{ number: stored.version, status: stored.status, notes: stored.notes }] }] };
      }
      return { rows: [], rowCount: 0 };
    }
  };
  const context = { require: name => name === "express" ? express : { connect: async () => client, query: client.query }, module: { exports: {} }, URL, console: { error() {} } };
  vm.runInNewContext(fs.readFileSync(require.resolve("../routes/software"), "utf8"), context);
  function request(method, url, body, { admin = true, origin = "http://localhost:3000" } = {}) {
    return new Promise((resolve, reject) => {
      let code = 200;
      context.module.exports.handle({ method, url, body, headers: {}, protocol: "http",
        session: admin ? { adminId: id, adminEmail: "test@example.com" } : {},
        get: key => key === "host" ? "localhost:3000" : origin
      }, {
        set() {}, status(value) { code = value; return this; },
        json(value) { resolve({ status: code, data: JSON.parse(JSON.stringify(value)) }); }
      }, error => error ? reject(error) : reject(new Error("Route not found")));
    });
  }
  return { request, queries, stored: () => stored, audits: () => queries.filter(q => q.sql.includes("INSERT INTO softtrack_audit_events")) };
}

test("notes: admin authorization and same-origin checks run before writes", async () => {
  const h = setup();
  const body = { version: "1.0", status: "Denied", notes: "Reason" };
  assert.equal((await h.request("PATCH", `/versions/${id}`, body, { admin: false })).status, 401);
  assert.equal((await h.request("PATCH", `/versions/${id}`, body, { origin: "https://elsewhere.example" })).status, 403);
  assert.equal(h.queries.length, 0);
});

test("notes: rejects invalid types, excessive length and NUL characters before DB access", async () => {
  for (const notes of [null, {}, 123, "x".repeat(2001), "a\u0000b"]) {
    for (const method of ["POST", "PATCH"]) {
      const h = setup();
      const response = await h.request(method, method === "POST" ? "/" : `/versions/${id}`,
        { name: "App", publisher: "Vendor", version: "1.0", status: "Approved", notes });
      assert.equal(response.status, 400);
      assert.equal(h.queries.length, 0);
    }
  }
});

test("notes: notes-only updates persist, are audited and are publicly readable", async () => {
  const h = setup();
  const notes = "Approved for training.\n<img src=x onerror=alert(1)>";
  const response = await h.request("PATCH", `/versions/${id}`, { version: "1.0", status: "Approved", notes });
  assert.equal(response.status, 200);
  assert.equal(h.stored().notes, notes);
  assert.equal(h.audits().length, 1);
  assert.deepEqual(h.audits()[0].params.slice(-2), ["Reviewed by IT", notes]);
  const publicRead = await h.request("GET", "/", undefined, { admin: false });
  assert.equal(publicRead.data[0].versions[0].notes, notes);
});

test("notes: status change preserves omitted notes and explicit empty text clears them", async () => {
  const h = setup();
  await h.request("PATCH", `/versions/${id}`, { version: "1.0", status: "Denied" });
  assert.equal(h.stored().notes, "Reviewed by IT");
  assert.equal(h.audits()[0].params[13], "status_changed");
  await h.request("PATCH", `/versions/${id}`, { version: "1.0", status: "Denied", notes: "  " });
  assert.equal(h.stored().notes, "");
  assert.deepEqual(h.audits()[1].params.slice(-2), ["Reviewed by IT", ""]);
});

test("notes: unchanged submissions do not create misleading audit events", async () => {
  const h = setup();
  const response = await h.request("PATCH", `/versions/${id}`, { version: "1.0", status: "Approved", notes: "Reviewed by IT" });
  assert.equal(response.data.unchanged, true);
  assert.equal(response.data.notes, "Reviewed by IT");
  assert.equal(h.audits().length, 0);
});

test("notes: audit failure rolls back the status and notes together", async () => {
  const h = setup({ failAudit: true });
  const response = await h.request("PATCH", `/versions/${id}`, { version: "1.0", status: "Denied", notes: "New reason" });
  assert.equal(response.status, 500);
  assert.equal(h.stored().status, "Approved");
  assert.equal(h.stored().notes, "Reviewed by IT");
  assert.equal(h.queries.at(-1).sql, "ROLLBACK");
});

test("notes: creating software accepts a note and legacy CSV-style requests default to empty", async () => {
  for (const notes of [undefined, "  Approved after review.  "]) {
    const h = setup();
    const response = await h.request("POST", "/", { name: "App", publisher: "Vendor", version: "2.0", status: "Approved", notes });
    assert.equal(response.status, 201);
    assert.equal(response.data.version.notes, notes?.trim() || "");
    assert.equal(h.audits()[0].params.at(-1), notes?.trim() || "");
  }
});

test("notes: public and admin tables show accessible notes as literal text", () => {
  for (const admin of [false, true]) {
    const document = createDocument(), container = document.createElement("div");
    const notes = "Reviewed.\n<script>alert(1)</script>";
    const table = InventoryTable.create({ container, createDetails: admin ? () => document.createElement("div") : undefined });
    table.update([{ id, name: "App", publisher: "Vendor", versions: [{ id, number: "1.0", status: "Approved", notes }] }]);
    const detail = descendants(container, "details")[0];
    assert.equal(descendants(detail, "p")[0].textContent, notes);
    assert.equal(descendants(detail, "summary")[0].getAttribute("aria-label"), "View notes for App, version 1.0");
    assert.equal(descendants(detail, "script").length, 0);
  }
});

for (const status of ["Approved", "Denied", "Pending"]) {
  test(`notes: ${status} detail page retains public notes as plain text`, async () => {
    const html = fs.readFileSync(require.resolve(`../public/${status.toLowerCase()}.html`), "utf8");
    const document = createDocument();
    for (const id of ["detailList", "detailCount", "detailSearch"]) document.elements.set(id, document.createElement("div"));
    const notes = "Reason on line one.\n<script>literal text</script>";
    const context = { document, console, fetch: async () => ({ ok: true, json: async () => [{ name: "App", publisher: "Vendor", versions: [{ number: "1.0", status, notes }] }] }) };
    for (const [, script] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) vm.runInNewContext(script, context);
    await new Promise(setImmediate);
    const list = document.elements.get("detailList");
    assert.ok(descendants(list, "p").some(p => p.textContent === "Notes: " + notes));
    assert.equal(descendants(list, "script").length, 0);
  });
}
