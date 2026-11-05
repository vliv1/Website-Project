


require("dotenv").config();

const argon2 = require("argon2");
const pool = require("../db");

async function main() {
  const { input, password } = await import("@inquirer/prompts");

  const existing = await pool.query(
    "SELECT COUNT(*)::integer AS count FROM admins"
  );

  if (existing.rows[0].count !== 0) {
    throw new Error(
      "An admin already exists. Initial setup is disabled."
    );
  }

  const email = (await input({
    message: "Administrator email:",
    validate: value =>
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())
        ? true
        : "Enter a valid email address"
  })).trim().toLowerCase();

  const secret = await password({
    message: "Administrator password:",
    mask: "*",
    validate: value =>
      value.length >= 16
        ? true
        : "Use at least 16 characters"
  });

  const confirm = await password({
    message: "Confirm password:",
    mask: "*"
  });

  if (secret !== confirm) {
    throw new Error("Passwords do not match.");
  }

  const hash = await argon2.hash(secret, {
    type: argon2.argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 1
  });

  await pool.query(
    `INSERT INTO admins (email, password_hash)
     VALUES ($1, $2)`,
    [email, hash]
  );

  console.log("Administrator account created successfully.");
}

main()
  .catch(error => {
    console.error("Setup failed:", error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
