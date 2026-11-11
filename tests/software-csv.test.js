"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { validate, importRows, MAX_ROWS } = require("../public/software-csv");

test("accepts Excel BOM, CRLF, aliases, reordered columns and quoted commas/quotes/newlines", () => {
  const result = validate('\uFEFFPublisher,Software Name,Approval Status,Version\r\n"Acme, Inc.","An ""App""\nSuite",approved,01.02\r\n');
  assert.deepEqual(result, { errors: [], rows: [{ row: 2, name: 'An "App"\nSuite', publisher: "Acme, Inc.", version: "01.02", status: "Approved" }] });
});

test("defaults missing or blank status to Pending and ignores blank lines", () => {
  assert.equal(validate("name,publisher,version\n\n App , Vendor ,001\n").rows[0].status, "Pending");
  assert.equal(validate("name,publisher,version,status\nApp,Vendor,001,\n").rows[0].status, "Pending");
});

test("reports actual CSV line numbers and all field errors", () => {
  const { errors } = validate('name,publisher,version,status\n"Line\nBreak",Vendor,1,Pending\n,Vendor,,unknown\nApp,Vendor\n');
  assert.equal(errors.length, 4);
  assert.ok(errors.slice(0, 3).every(value => value.startsWith("CSV row 4:")));
  assert.match(errors[3], /CSV row 5: expected 4 columns/);
});

test("rejects malformed quotes, missing/duplicate/unknown headers and empty files", () => {
  for (const csv of ["", "name,publisher,version", 'name,publisher,version\n"App,Vendor,1', 'name,publisher,version\nA"pp,Vendor,1', 'name,publisher,version\n"App"x,Vendor,1', "name,name,version\nA,B,1", "name,publisher,other\nA,B,1", "name,publisher\nA,B", "name,publisher,version\nA\0,B,1"]) {
    assert.throws(() => validate(csv));
  }
});

test("enforces row and field limits", () => {
  const header = "name,publisher,version\n";
  assert.equal(validate(header + "A,B,1\n".repeat(MAX_ROWS)).rows.length, MAX_ROWS);
  assert.throws(() => validate(header + "A,B,1\n".repeat(MAX_ROWS + 1)), /at most 500/);
  assert.equal(validate(header + `${"x".repeat(121)},${"x".repeat(121)},${"x".repeat(81)}`).errors.length, 3);
});

test("rejects empty data records and inherited object property names", () => {
  assert.equal(validate("name,publisher,version,status\n,,,").errors.length, 3);
  assert.equal(validate("name,publisher,version,status\nApp,Vendor,1,constructor").errors.length, 1);
  assert.throws(() => validate("name,publisher,version,constructor\nApp,Vendor,1,anything"), /unique headers/);
});

const rows = validate("name,publisher,version\nApp,Vendor,1\nApp,Vendor,2\nApp,Vendor,3").rows;
const response = status => ({ status, ok: status >= 200 && status < 300, json: async () => ({ error: "Service unavailable" }) });

test("imports sequentially, skips conflicts and sends only API fields", async () => {
  const sent = [], progress = [];
  const result = await importRows(rows, async row => {
    sent.push(row);
    return response(row.version === "2" ? 409 : 201);
  }, value => progress.push(value));
  assert.deepEqual(result, { imported: 2, skipped: 1, remaining: [], error: "" });
  assert.deepEqual(Object.keys(sent[0]), ["name", "publisher", "version", "status"]);
  assert.deepEqual(sent.map(row => row.version), ["1", "2", "3"]);
  assert.equal(progress.at(-1).processed, 3);
});

test("stops on server errors and resumes only unsaved rows", async () => {
  const result = await importRows(rows, async row => response(row.version === "2" ? 500 : 201));
  assert.equal(result.imported, 1);
  assert.deepEqual(result.remaining, rows.slice(1));
  assert.match(result.error, /CSV row 3: Service unavailable/);
  const retried = await importRows(result.remaining, async () => response(201));
  assert.equal(retried.imported, 2);
});

test("handles network loss after a save by skipping that version on retry", async () => {
  const result = await importRows(rows, async () => { throw new Error("Network error"); });
  assert.deepEqual(result.remaining, rows);
  assert.equal(result.imported, 0);
  const retried = await importRows(result.remaining, async row => response(row.version === "1" ? 409 : 201));
  assert.equal(retried.imported, 2);
  assert.equal(retried.skipped, 1);
});

test("stops on expired sessions with accurate partial counts", async () => {
  const result = await importRows(rows, async row => response(row.version === "2" ? 401 : 201));
  assert.equal(result.authExpired, true);
  assert.equal(result.imported, 1);
  assert.deepEqual(result.remaining, rows.slice(1));
});
