"use strict";

const express = require("express");
const path = require("path");
const router = express.Router();

// Only these files are exposed, and every page uses the same session check.
const pages = [
  ["/admin", "admin.html"],
  ["/admin/inventory", "admin-inventory.html"],
  ["/admin/add-software", "admin-add-software.html"],
  ["/admin/import", "admin-import.html"],
  ["/admin/audit", "admin-audit.html"],
  ["/admin/settings", "admin-settings.html"]
];

for (const [url, file] of pages) {
  router.get([url, `/${file}`], (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!req.session?.adminId) return res.redirect("/login.html");
    res.sendFile(path.join(__dirname, "..", "private", file));
  });
}

module.exports = router;
