"use strict";

const express = require("express");
const pool = require("../db");
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

module.exports = function productIdentification({ requestNvd, parseCpe23, literalCpe, scanIfDue }, requireSameOrigin) {
  const router = express.Router();
  router.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  function candidate(cpe) {
    if (!cpe || cpe.deprecated !== false || !uuid.test(cpe.cpeNameId)) return null;
    const fields = parseCpe23(cpe.cpeName);
    if (fields?.[0] !== "a") return null;
    const publisher = literalCpe(fields[1]);
    const name = literalCpe(fields[2]);
    if (!publisher || !name) return null;
    return { id: cpe.cpeNameId, family: `cpe:2.3:${fields.slice(0, 3).join(":")}`, publisher, name };
  }

  router.get("/", async (_req, res) => {
    const scanning = scanIfDue();
    const { rows } = await pool.query(`SELECT id, name, publisher, nvd_family AS family,
        nvd_needs_identification AS unresolved FROM public.software s
      WHERE EXISTS (SELECT 1 FROM public.software_versions v WHERE v.software_id = s.id)
        AND (nvd_family IS NOT NULL OR nvd_needs_identification IS DISTINCT FROM false)
      ORDER BY lower(name), lower(publisher), id`);
    res.json({ scanning, pending: rows.filter(r => r.unresolved === null && !r.family).length,
      products: rows.filter(r => r.unresolved || r.family) });
  });

  router.get("/search", async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const start = Number(req.query.start || 0);
    if (q.length < 2 || q.length > 120 || !Number.isSafeInteger(start) || start < 0) {
      return res.status(400).json({ error: "Enter a product name between 2 and 120 characters." });
    }
    const page = await requestNvd("cpes", { keywordSearch: q, startIndex: start, resultsPerPage: 200 });
    if (!Array.isArray(page.products) || page.startIndex !== start || !Number.isSafeInteger(page.totalResults)) {
      throw new Error("Invalid NVD dictionary page");
    }
    const choices = new Map();
    for (const item of page.products) {
      const option = candidate(item.cpe);
      if (option) choices.set(option.family, option);
    }
    const next = start + page.products.length;
    res.json({ choices: [...choices.values()], next: next > start && next < page.totalResults ? next : null });
  });

  router.put("/:id", requireSameOrigin, async (req, res) => {
    const { choiceId, family, previousFamily, name, publisher } = req.body || {};
    if (!uuid.test(req.params.id) || !uuid.test(choiceId) || typeof family !== "string" ||
        !(previousFamily === null || typeof previousFamily === "string") ||
        typeof name !== "string" || typeof publisher !== "string") {
      return res.status(400).json({ error: "Choose a product from the dictionary results." });
    }
    const page = await requestNvd("cpes", { cpeNameId: choiceId });
    const selected = page.products.map(item => candidate(item.cpe)).find(option =>
      option && option.id.toLowerCase() === choiceId.toLowerCase() && option.family === family);
    if (!selected) return res.status(409).json({ error: "This dictionary choice has changed. Search again." });
    const result = await pool.query(`UPDATE public.software SET nvd_family = $2, nvd_needs_identification = false
      WHERE id = $1 AND nvd_family IS NOT DISTINCT FROM $3 AND name = $4 AND publisher = $5`,
      [req.params.id, selected.family, previousFamily, name, publisher]);
    if (!result.rowCount) return res.status(409).json({ error: "This inventory entry changed. Refresh the list before saving." });
    res.json({ family: selected.family });
  });

  router.use((error, _req, res, _next) => {
    console.error("Product identification:", error.message);
    res.status(503).json({ error: "Product identification is unavailable. Please try again." });
  });
  return router;
};
