"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const pool = require("../db");

async function migrate() {
  const client = await pool.connect();
  try {
    const sql = await fs.readFile(path.join(__dirname, "../migrations/001-version-notes.sql"), "utf8");
    await client.query(sql);
    console.log("Software version notes migration complete.");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

migrate().catch(error => {
  console.error("Migration failed:", error.message);
  process.exitCode = 1;
}).finally(() => pool.end());
