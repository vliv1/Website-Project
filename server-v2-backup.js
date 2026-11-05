
require("dotenv").config();

const express = require("express");
const path = require("path");
const helmet = require("helmet");
const { rateLimit } = require("express-rate-limit");
const pool = require("./db");

const app = express();
const PORT = process.env.PORT || 3000;

app.disable("x-powered-by");

app.use(helmet());

app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 100,
  standardHeaders: "draft-8",
  legacyHeaders: false
}));

// Keep serving the existing SoftTrack frontend
app.use(express.static(
  path.join(__dirname, "public")
));

// A temporary local-only connectivity test.
// No database records or credentials are returned.
app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok" });
  } catch (error) {
    console.error("Database health check failed");
    res.status(503).json({
      status: "unavailable"
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`SoftTrack running on port ${PORT}`);
});
