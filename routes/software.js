


const express = require("express");
const pool = require("../db");


const router = express.Router();

const STATUSES = new Set([
  "Approved",
  "Pending",
  "Denied"
]);

function isValidText(value, max = 120) {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.trim().length <= max
  );
}

function isUUID(value) {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      .test(value);
}

function requireAdmin(req, res, next) {
  if (!req.session?.adminId) {
    return res.status(401).json({
      error: "Administrator login required"
    });
  }

  next();
}

// Browser writes must come from the same origin.
// Keep your existing session and origin protections.
function requireSameOrigin(req, res, next) {
  const origin = req.get("origin");

  if (!origin) {
    return res.status(403).json({
      error: "Origin header required"
    });
  }

  try {
    const expected = new URL(
      `${req.protocol}://${req.get("host")}`
    );

    if (new URL(origin).origin !== expected.origin) {
      return res.status(403).json({
        error: "Cross-origin request rejected"
      });
    }
  } catch {
    return res.status(403).json({
      error: "Invalid origin"
    });
  }

  next();
}

// PUBLIC: Read all software and versions.
router.get("/", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        s.id,
        s.name,
        s.publisher,
        COALESCE(
          json_agg(
            json_build_object(
              'id', v.id,
              'number', v.version,
              'status', v.status
            )
            ORDER BY v.version, v.id
          ) FILTER (WHERE v.id IS NOT NULL),
          '[]'::json
        ) AS versions
      FROM software s
      LEFT JOIN software_versions v
        ON v.software_id = s.id
      GROUP BY s.id, s.name, s.publisher
      ORDER BY lower(s.name), lower(s.publisher)
    `);

    res.set("Cache-Control", "no-store");
    res.json(result.rows);
  } catch (error) {
    console.error("Inventory read failed:", error.message);
    res.status(500).json({
      error: "Unable to load inventory"
    });
  }
});

// All routes below require an authenticated admin
// and a same-origin browser request.
router.use(requireAdmin, requireSameOrigin);

// ADMIN: Add software or a version.
router.post("/", async (req, res) => {
  const { name, publisher, version, status } = req.body || {};

  if (!isValidText(name) ||
      !isValidText(publisher) ||
      !isValidText(version, 80) ||
      !STATUSES.has(status)) {
    return res.status(400).json({
      error: "Invalid software information"
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Serialize creation of a particular software group.
    const normalizedName = name.trim();
    const normalizedPublisher = publisher.trim();

    await client.query(
      `SELECT pg_advisory_xact_lock(
         hashtextextended($1, 0)
       )`,
      [
        normalizedName.toLowerCase() +
        "\u0000" +
        normalizedPublisher.toLowerCase()
      ]
    );

    let software = await client.query(
      `SELECT id
       FROM software
       WHERE lower(name) = lower($1)
         AND lower(publisher) = lower($2)
       LIMIT 1`,
      [normalizedName, normalizedPublisher]
    );

    let softwareId;

    if (software.rows.length) {
      softwareId = software.rows[0].id;
    } else {
     const inserted = await client.query(
      `INSERT INTO software (id, name, publisher)
      VALUES (gen_random_uuid(), $1, $2)
      RETURNING id`,
      [normalizedName, normalizedPublisher]
    );

      softwareId = inserted.rows[0].id;
    }

    const duplicate = await client.query(
      `SELECT id
       FROM software_versions
       WHERE software_id = $1
         AND lower(version) = lower($2)
       LIMIT 1`,
      [softwareId, version.trim()]
    );

    if (duplicate.rows.length) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: "That software version already exists"
      });
    }

    const insertedVersion = await client.query(
  `INSERT INTO software_versions
     (id, software_id, version, status)
   VALUES (gen_random_uuid(), $1, $2, $3)
   RETURNING id, software_id, version, status`,
  [softwareId, version.trim(), status]
);

    await recordApprovalEvent(client, {
  softwareVersionId: insertedVersion.rows[0].id,
  softwareName: normalizedName,
  publisher: normalizedPublisher,
  version: insertedVersion.rows[0].version,
  oldStatus: null,
  newStatus: insertedVersion.rows[0].status,
  action: "created",
  adminId: req.session.adminId,
  adminEmail: req.session.adminEmail
});

await client.query("COMMIT");

res.status(201).json({
  softwareId,
  version: insertedVersion.rows[0]
});
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Software creation failed:", error.message);

    res.status(500).json({
      error: "Unable to add software"
    });
  } finally {
    client.release();
  }
});

// ADMIN: Update a software group's name/publisher.
router.patch("/:id", async (req, res) => {
  const { id } = req.params;
  const { name, publisher } = req.body || {};

  if (!isUUID(id) ||
      !isValidText(name) ||
      !isValidText(publisher)) {
    return res.status(400).json({
      error: "Invalid software information"
    });
  }

  try {
    const result = await pool.query(
      `UPDATE software
       SET name = $1, publisher = $2
       WHERE id = $3
       RETURNING id, name, publisher`,
      [name.trim(), publisher.trim(), id]
    );

    if (!result.rowCount) {
      return res.status(404).json({
        error: "Software not found"
      });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error("Software update failed:", error.message);
    res.status(500).json({
      error: "Unable to update software"
    });
  }
});

// ADMIN: Edit a version or its approval status.
router.patch("/versions/:id", async (req, res) => {
  const { id } = req.params;
  const { version, status } = req.body || {};

  if (!isUUID(id) ||
      !isValidText(version, 80) ||
      !STATUSES.has(status)) {
    return res.status(400).json({
      error: "Invalid version information"
    });
  }

  try {
    const result = await pool.query(
      `UPDATE software_versions
       SET version = $1, status = $2
       WHERE id = $3
       RETURNING id, software_id, version, status`,
      [version.trim(), status, id]
    );

    if (!result.rowCount) {
      return res.status(404).json({
        error: "Version not found"
      });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error("Version update failed:", error.message);
    res.status(500).json({
      error: "Unable to update version"
    });
  }
});

// ADMIN: Delete a version.
router.delete("/versions/:id", async (req, res) => {
  if (!isUUID(req.params.id)) {
    return res.status(400).json({
      error: "Invalid version ID"
    });
  }

  try {
    const result = await pool.query(
      `DELETE FROM software_versions
       WHERE id = $1
       RETURNING id`,
      [req.params.id]
    );

    if (!result.rowCount) {
      return res.status(404).json({
        error: "Version not found"
      });
    }

    res.json({ success: true });
  } catch (error) {
    console.error("Version deletion failed:", error.message);
    res.status(500).json({
      error: "Unable to delete version"
    });
  }
});

// ADMIN: Delete an entire software group.
router.delete("/:id", async (req, res) => {
  if (!isUUID(req.params.id)) {
    return res.status(400).json({
      error: "Invalid software ID"
    });
  }

  try {
    const result = await pool.query(
      `DELETE FROM software
       WHERE id = $1
       RETURNING id`,
      [req.params.id]
    );

    if (!result.rowCount) {
      return res.status(404).json({
        error: "Software not found"
      });
    }

    res.json({ success: true });
  } catch (error) {
    console.error("Software deletion failed:", error.message);
    res.status(500).json({
      error: "Unable to delete software"
    });
  }
});

module.exports = router;


async function recordApprovalEvent(client, {
  softwareVersionId,
  softwareName,
  publisher,
  version,
  oldStatus = null,
  newStatus = null,
  action,
  adminId,
  adminEmail
}) {
  await client.query(
    `INSERT INTO approval_events (
      software_version_id,
      software_name,
      publisher,
      version,
      old_status,
      new_status,
      action,
      admin_id,
      admin_email
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      softwareVersionId,
      softwareName,
      publisher,
      version,
      oldStatus,
      newStatus,
      action,
      adminId,
      adminEmail
    ]
  );
}