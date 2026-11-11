"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const InventoryTable = require("../public/inventory-table");
const { createDocument, descendants } = require("./helpers/dom");

const data = [{ id: "a", name: "App", publisher: "Vendor", versions: Array.from({ length: 61 }, (_, i) => ({
  id: `version-${i + 1}`, number: `1.${i + 1}`, status: i % 2 ? "Approved" : "Pending"
})) }, { id: "b", name: "Empty App", publisher: "Other", versions: [] }];

test("sorts versions naturally before paging without modifying source data", () => {
  const original = JSON.stringify(data);
  const result = InventoryTable.select(data, { sort: "number", page: 2 });
  assert.equal(result.total, 62);
  assert.equal(result.pages, 3);
  assert.equal(result.visible.length, 25);
  assert.equal(result.visible[0].number, "1.26");
  assert.equal(result.visible[24].number, "1.50");
  assert.equal(InventoryTable.select(data, { sort: "number", direction: "desc" }).visible[0].number, "1.61");
  assert.equal(JSON.stringify(data), original);
});

test("supports both sort directions for all four columns", () => {
  const sample = [
    { id: "z", name: "Zulu", publisher: "Acme", versions: [{ id: "z1", number: "1.2", status: "Approved" }] },
    { id: "a", name: "Alpha", publisher: "Zeta", versions: [{ id: "a1", number: "1.10", status: "Pending" }] }
  ];
  for (const [sort, ascending] of [["name", "Alpha"], ["publisher", "Zulu"], ["number", "Zulu"], ["status", "Zulu"]]) {
    assert.equal(InventoryTable.select(sample, { sort }).visible[0].name, ascending);
    assert.notEqual(InventoryTable.select(sample, { sort, direction: "desc" }).visible[0].name, ascending);
  }
});

test("filters before paging, preserves truly empty groups, and excludes unmatched versions", () => {
  const approved = InventoryTable.select(data, { status: "Approved", query: " VENDOR ", page: 2 });
  assert.equal(approved.total, 30);
  assert.equal(approved.visible.length, 5);
  assert.ok(approved.rows.every(row => row.status === "Approved"));
  assert.equal(InventoryTable.select(data, { status: "Denied", query: "App" }).total, 0);
  assert.equal(InventoryTable.select(data, { query: "missing-version" }).total, 0);
  assert.equal(InventoryTable.select(data, { query: "Other" }).visible[0].version, null);
  assert.equal(InventoryTable.select(data, { query: "1.61" }).total, 1);
});

test("clamps pages after deletions and handles empty results and page-size changes", () => {
  assert.equal(InventoryTable.select(data, { page: 999 }).page, 3);
  assert.equal(InventoryTable.select(data, { pageSize: 50 }).pages, 2);
  assert.equal(InventoryTable.select(data, { pageSize: 100 }).visible.length, 62);
  const empty = InventoryTable.select([], { page: 3 });
  assert.equal(empty.page, 1);
  assert.equal(empty.start, 0);
  assert.equal(empty.end, 0);
});

function setup(createDetails) {
  const document = createDocument();
  const container = document.createElement("div");
  container.id = "testInventory";
  const table = InventoryTable.create({ container, createDetails });
  table.update(data);
  const buttons = () => descendants(container, "button");
  const findButton = text => buttons().find(button => button.textContent === text);
  const rows = () => descendants(container, "tbody")[0].children;
  return { document, container, table, buttons, findButton, rows };
}

test("table controls sort, paginate, reset filters, and preserve sorting during refresh", () => {
  const ui = setup();
  assert.equal(ui.rows().length, 25);
  assert.equal(ui.findButton("Previous").disabled, true);
  ui.findButton("Next").click();
  assert.equal(ui.rows()[0].children[2].textContent, "1.26");
  const sortVersion = ui.buttons().find(button => button.textContent.startsWith("Version"));
  sortVersion.click();
  sortVersion.click();
  assert.equal(ui.rows()[0].children[2].textContent, "1.61");
  assert.equal(descendants(ui.container, "th")[2].getAttribute("aria-sort"), "descending");
  ui.findButton("Next").click();
  ui.table.update(data, { query: "1.61" });
  assert.equal(ui.rows().length, 1);
  assert.equal(ui.findButton("Previous").disabled, true);
  assert.equal(ui.findButton("Next").disabled, true);
  ui.table.update(data);
  assert.equal(ui.rows()[0].children[2].textContent, "1.61");
  const select = descendants(ui.container, "select")[0];
  select.value = "50";
  select.handlers.change();
  assert.equal(ui.rows().length, 50);
});

test("public table has no actions; admin Manage receives the full group and selected version", () => {
  assert.equal(descendants(setup().container, "th").length, 4);
  const document = createDocument();
  let selected;
  const admin = setup(record => { selected = record; return document.createElement("div"); });
  assert.equal(descendants(admin.container, "th").length, 5);
  const manage = admin.findButton("Manage");
  manage.click();
  assert.equal(selected.software.versions.length, 61);
  assert.equal(selected.version.number, "1.1");
  assert.equal(manage.getAttribute("aria-expanded"), "true");
  assert.equal(admin.rows().length, 26);
  manage.click();
  assert.equal(admin.rows().length, 25);
});

test("empty/error states disable pagination and imported markup remains plain text", () => {
  const ui = setup();
  ui.table.update([{ id: "x", name: '<img src=x onerror=alert(1)>', publisher: "Vendor", versions: [] }]);
  assert.equal(ui.rows()[0].children[0].textContent, '<img src=x onerror=alert(1)>');
  assert.equal(descendants(ui.container, "img").length, 0);
  ui.table.update([], { error: "Unable to load inventory" });
  assert.equal(ui.findButton("Previous").disabled, true);
  assert.equal(ui.findButton("Next").disabled, true);
});

test("public CSV export includes all filtered rows in sort order, across pages", async () => {
  const document = createDocument();
  for (const id of ["softwareList", "emptyMessage", "search", "statusFilter", "exportBtn"]) {
    document.elements.set(id, document.createElement("div"));
  }
  document.getElementById("softwareList").id = "softwareList";
  document.getElementById("statusFilter").value = "All";
  let csv;
  vm.runInNewContext(fs.readFileSync(require.resolve("../public/app"), "utf8"), {
    document, InventoryTable, console, fetch: async () => ({ ok: true, json: async () => data }),
    Blob: class { constructor(parts) { csv = parts.join(""); } },
    URL: { createObjectURL: () => "blob:test", revokeObjectURL() {} }, setTimeout() {}
  });
  await new Promise(resolve => setImmediate(resolve));
  const container = document.getElementById("softwareList");
  const versionSort = descendants(container, "button").find(button => button.textContent.startsWith("Version"));
  versionSort.click(); versionSort.click();
  document.getElementById("exportBtn").click();
  const lines = csv.split("\r\n");
  assert.equal(lines.length, 62); // Header plus all 61 versions, excluding the empty group.
  assert.match(lines[1], /"1.61"/);
  document.getElementById("statusFilter").value = "Approved";
  document.getElementById("statusFilter").handlers.change();
  document.getElementById("exportBtn").click();
  assert.equal(csv.split("\r\n").length, 31);
});
