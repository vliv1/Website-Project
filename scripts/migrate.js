"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const pool = require("../db");

async function migrate() {
  const client = await pool.connect();
  try {
    const directory = path.join(__dirname, "../migrations");
    for (const file of (await fs.readdir(directory)).filter(name => name.endsWith(".sql")).sort()) {
      await client.query(await fs.readFile(path.join(directory, file), "utf8"));
      console.log(`Applied ${file}`);
    }
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
