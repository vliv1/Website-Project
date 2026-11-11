"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

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
  const elements = new Map();
  function element() {
    const attrs = {}, classes = new Set();
    return {
      value: "", children: [], handlers: {}, dataset: {}, hidden: true,
      classList: { toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); } },
      setAttribute(name, value) { attrs[name] = value; },
      getAttribute(name) { return attrs[name]; },
      removeAttribute(name) { delete attrs[name]; },
      addEventListener(name, callback) { this.handlers[name] = callback; },
      appendChild(child) { this.children.push(child); },
      append(...children) { this.children.push(...children); },
      replaceChildren() { this.children = []; }
    };
  }
  for (const [, id] of html.matchAll(/\bid="([^"]+)"/g)) elements.set(id, element());
  if (elements.has("adminStatusFilter")) elements.get("adminStatusFilter").value = "All";
  const nav = pages.map(([key]) => ({ ...element(), dataset: { adminPage: key } }));
  const requests = [], redirects = [], saved = new Map();
  const body = { dataset: { adminPage: html.match(/<body[^>]*data-admin-page="([^"]+)"/)[1] } };
  const context = {
    console, document: { body, getElementById: id => elements.get(id) || null, querySelectorAll: () => nav, createElement: element },
    window: { location: { pathname, hash, replace: url => redirects.push(url) }, addEventListener() {}, matchMedia: () => ({ matches: false }) },
    localStorage: { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value) },
    fetch: async url => {
      requests.push(url);
      return { ok: true, status: 200, json: async () => url === "/api/admin/me" ? { authenticated, email: "test@example.com" } : [] };
    }
  };
  vm.runInNewContext(fs.readFileSync(path.resolve("public/admin.js"), "utf8"), context);
  return { elements, requests, redirects, nav, saved, body };
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
