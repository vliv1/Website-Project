"use strict";

const express = require("express");
const argon2 = require("argon2");
const pool = require("../db");

module.exports = function adminUsers(requireSameOrigin, creationLimiter) {
  const router = express.Router();
  router.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  router.get("/", async (_req, res) => {
    try {
      const result = await pool.query(
        "SELECT id, email, created_at FROM public.admins ORDER BY created_at, id"
      );
      res.json(result.rows);
    } catch (error) {
      console.error("Administrator list failed:", error.message);
      res.status(500).json({ error: "Unable to load administrator accounts." });
    }
  });

  router.post("/", requireSameOrigin, creationLimiter, async (req, res) => {
    const { email, password, confirmPassword } = req.body || {};
    if (typeof email !== "string" || email.trim().length > 254 ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      return res.status(400).json({ error: "Enter a valid email address." });
    }
    if (typeof password !== "string" || password.length < 16 || password.length > 1024) {
      return res.status(400).json({ error: "Use a password between 16 and 1,024 characters." });
    }
    if (password !== confirmPassword) {
      return res.status(400).json({ error: "The passwords do not match." });
    }

    const normalizedEmail = email.trim().toLowerCase();
    let client;
    try {
      const hash = await argon2.hash(password, {
        type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1
      });
      client = await pool.connect();
      await client.query("BEGIN");
      // Serialize attempts for the same address, including differently cased input.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [normalizedEmail]);
      const existing = await client.query(
        "SELECT id FROM public.admins WHERE lower(email) = $1", [normalizedEmail]
      );
      if (existing.rowCount) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "An administrator with this email already exists." });
      }
      const result = await client.query(
        "INSERT INTO public.admins (email, password_hash) VALUES ($1, $2) RETURNING id, email, created_at",
        [normalizedEmail, hash]
      );
      await client.query("COMMIT");
      res.status(201).json(result.rows[0]);
    } catch (error) {
      if (client) await client.query("ROLLBACK").catch(() => {});
      // A unique constraint also covers accounts created by the setup script.
      if (error.code === "23505") {
        return res.status(409).json({ error: "An administrator with this email already exists." });
      }
      console.error("Administrator creation failed:", error.message);
      res.status(500).json({ error: "Unable to create the administrator. Refresh the account list before trying again." });
    } finally {
      client?.release();
    }
  });
  return router;
};
