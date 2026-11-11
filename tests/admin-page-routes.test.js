"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const router = require("../routes/admin-pages");

const pages = [
  ["dashboard", "/admin", "admin.html", "adminDashboard"],
  ["inventory", "/admin/inventory", "admin-inventory.html", "adminInventory"],
  ["add-software", "/admin/add-software", "admin-add-software.html", "adminAddSoftware"],
  ["import", "/admin/import", "admin-import.html", "adminImport"],
  ["audit", "/admin/audit", "admin-audit.html", "adminAudit"],
  ["settings", "/admin/settings", "admin-settings.html", "adminSettings"]
];

function request(url, authenticated) {
  return new Promise((resolve, reject) => {
    const headers = {};
    router.handle({ method: "GET", url, headers: {}, session: authenticated ? { adminId: "test-admin" } : {} }, {
      set(name, value) { headers[name] = value; },
      redirect(url) { resolve({ redirect: url, headers }); },
      sendFile(file) { resolve({ file, headers }); }
    }, error => error ? reject(error) : resolve({ missing: true }));
  });
}

for (const [key, url, filename, section] of pages) {
  test(`${key}: both URL forms require login and serve the correct private file`, async () => {
    for (const address of [url, `/${filename}`]) {
      const anonymous = await request(address, false);
      assert.equal(anonymous.redirect, "/login.html");
      assert.equal(anonymous.file, undefined);
      const authenticated = await request(address, true);
      assert.equal(authenticated.file, path.resolve("private", filename));
      assert.equal(authenticated.headers["Cache-Control"], "no-store");
      const html = fs.readFileSync(authenticated.file, "utf8");
      assert.ok(html.includes(`id="${section}"`));
      for (const [, , , otherSection] of pages) {
        if (otherSection !== section) assert.ok(!html.includes(`id="${otherSection}"`));
      }
    }
  });
}

