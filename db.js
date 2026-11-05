
require("dotenv").config();

const { Pool } = require("pg");

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not configured");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000
});

pool.on("error", error => {
  console.error(
    "Unexpected PostgreSQL pool error:",
    error.message
  );
});

module.exports = pool;
