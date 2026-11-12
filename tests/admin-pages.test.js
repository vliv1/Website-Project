"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const InventoryTable = require("../public/inventory-table");
const { createDocument, descendants } = require("./helpers/dom");

const pages = [
  ["dashboard", "/admin", "admin.html", "adminDashboard"],
  ["inventory", "/admin/inventory", "admin-inventory.html", "adminInventory"],
  ["add-software", "/admin/add-software", "admin-add-software.html", "adminAddSoftware"],
  ["import", "/admin/import", "admin-import.html", "adminImport"],
  ["audit", "/admin/audit", "admin-audit.html", "adminAudit"],
  ["settings", "/admin/settings", "admin-settings.html", "adminSettings"]
];

function loadPage(filename, pathname, hash = "", authenticated = true) {
  const html = fs.readFileSync(path.resolve("private", filename), "utf8");
  const document = createDocument();
  const elements = document.elements;
  const element = () => document.createElement("div");
  for (const [, id] of html.matchAll(/\bid="([^"]+)"/g)) elements.set(id, element());
  if (elements.has("adminStatusFilter")) elements.get("adminStatusFilter").value = "All";
  const nav = pages.map(([key]) => ({ ...element(), dataset: { adminPage: key } }));
  const requests = [], redirects = [], saved = new Map(), writes = [];
  elements.get("adminContent").hidden = true;
  const body = { dataset: { adminPage: html.match(/<body[^>]*data-admin-page="([^"]+)"/)[1] } };
  const context = {
    console, InventoryTable, document: Object.assign(document, { body, querySelectorAll: () => nav }),
    window: { location: { pathname, hash, replace: url => redirects.push(url) }, addEventListener() {}, matchMedia: () => ({ matches: false }) },
    localStorage: { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value) },
    fetch: async (url, options = {}) => {
      requests.push(url);
      if (options.body) writes.push({ url, body: JSON.parse(options.body) });
      return { ok: true, status: 200, json: async () => url === "/api/admin/me" ? { authenticated, email: "test@example.com" } : [] };
    }
  };
  vm.runInNewContext(fs.readFileSync(path.resolve("public/admin.js"), "utf8"), context);
  return { elements, requests, redirects, nav, saved, body, writes, context };
}

for (const [key, url, filename] of pages) {
  test(`${key}: shared script initializes with only this page's elements`, async () => {
    const page = loadPage(filename, url);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(page.elements.get("adminContent").hidden, false);
    assert.deepEqual(page.requests, ["/api/admin/me", ...(
      key === "dashboard" || key === "inventory" ? ["/api/software"] : key === "audit" ? ["/api/software/audit"] : []
    )]);
    assert.equal(page.nav.filter(link => link.getAttribute("aria-current") === "page").length, 1);
    assert.equal(page.nav.find(link => link.getAttribute("aria-current") === "page").dataset.adminPage, key);
    if (key === "settings") {
      page.elements.get("adminDarkMode").handlers.click();
      assert.equal(page.saved.get("softTrackAdminTheme"), "dark");
      assert.equal(page.elements.get("adminDarkMode").getAttribute("aria-pressed"), "true");
      assert.equal(page.elements.get("adminLightMode").getAttribute("aria-pressed"), "false");
    }
  });
}

test("old admin section bookmarks redirect to the corresponding pages", () => {
  for (const [, url, , section] of pages.slice(1, 5)) {
    const page = loadPage("admin.html", "/admin", `#${section}`);
    assert.deepEqual(page.redirects, [url]);
    assert.deepEqual(page.requests, []);
  }
});

test("expired sessions redirect before showing content or requesting page data", async () => {
  const page = loadPage("admin-audit.html", "/admin/audit", "", false);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(page.redirects, ["/login.html"]);
  assert.equal(page.elements.get("adminContent").hidden, true);
  assert.deepEqual(page.requests, ["/api/admin/me"]);
});

test("admin editor saves notes-only changes and allows clearing a note", async () => {
  const page = loadPage("admin-inventory.html", "/admin/inventory");
  await new Promise(setImmediate);
  for (const notes of ["Reviewed for classroom use.\nApproved by IT.", ""]) {
    const editor = page.context.createVersionEditor({ id: "version-1", number: "1.0", status: "Approved", notes: "Previous reason" });
    descendants(editor, "select")[0].value = "Approved";
    const textarea = descendants(editor, "textarea")[0];
    assert.equal(textarea.value, "Previous reason");
    assert.equal(textarea.maxLength, 2000);
    textarea.value = notes;
    await editor.handlers.submit({ preventDefault() {} });
    assert.deepEqual(page.writes.at(-1), { url: "/api/software/versions/version-1", body: { version: "1.0", status: "Approved", notes } });
  }
});

test("admin audit displays notes-only changes without claiming a version change", async () => {
  const page = loadPage("admin-audit.html", "/admin/audit");
  await new Promise(setImmediate);
  page.context.renderAuditHistory([{ action: "version_updated", software_name: "App", version: "1.0", old_version: "1.0", new_version: "1.0", old_notes: "Old reason", new_notes: "<script>literal text</script>", created_at: "2026-11-11T12:00:00Z" }]);
  const container = page.elements.get("auditHistoryList");
  assert.equal(descendants(container, "h3")[0].textContent, "Approval Notes Updated");
  const text = descendants(container, "p").map(p => p.textContent).join("\n");
  assert.match(text, /Previous notes: Old reason/);
  assert.match(text, /Notes: <script>literal text<\/script>/);
  assert.ok(!text.includes("Version changed:"));
  assert.equal(descendants(container, "script").length, 0);
});
