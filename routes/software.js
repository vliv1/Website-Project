
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
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}

function requireAdmin(req, res, next) {
  if (!req.session?.adminId) {
    return res.status(401).json({
      error: "Administrator login required"
    });
  }

  next();
}

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

// Save an audit event inside the current database transaction.


async function recordApprovalEvent(client, {
  softwareVersionId = null,
  softwareName,
  publisher,
  version = "",
  oldStatus = null,
  newStatus = null,
  oldVersion = null,
  newVersion = null,
  oldSoftwareName = null,
  newSoftwareName = null,
  oldPublisher = null,
  newPublisher = null,
  deletedStatus = null,
  action,
  adminId,
  adminEmail
}) {
  await client.query(
    `INSERT INTO softtrack_audit_events (
      software_version_id,
      software_name,
      publisher,
      version,
      old_status,
      new_status,
      old_version,
      new_version,
      old_software_name,
      new_software_name,
      old_publisher,
      new_publisher,
      deleted_status,
      action,
      admin_id,
      admin_email
    )
    VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8,
      $9, $10, $11, $12, $13, $14, $15, $16
    )`,
    [
      softwareVersionId,
      softwareName,
      publisher,
      version,
      oldStatus,
      newStatus,
      oldVersion,
      newVersion,
      oldSoftwareName,
      newSoftwareName,
      oldPublisher,
      newPublisher,
      deletedStatus,
      action,
      adminId,
      adminEmail
    ]
  );
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

// All routes below require an authenticated administrator
// and a same-origin browser request.
router.use(requireAdmin);

router.use((req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD") {
    return next();
  }

  return requireSameOrigin(req, res, next);
});


// ADMIN: Read recent software audit history.

router.get("/audit", async (req, res) => {
  try {
    const result = await pool.query(
  `SELECT
     id,
     software_version_id,
     software_name,
     publisher,
     version,
     old_status,
     new_status,
     deleted_status,
     old_version,
     new_version,
     old_software_name,
     new_software_name,
     old_publisher,
     new_publisher,
     action,
     admin_email,
     created_at
   FROM softtrack_audit_events
   ORDER BY created_at DESC, id DESC
   LIMIT 100`
);

    res.set("Cache-Control", "no-store");
    res.json(result.rows);

  } catch (error) {
    console.error(
      "Audit history failed:",
      error.message
    );

    res.status(500).json({
      error: "Unable to load audit history"
    });
  }
});



// ADMIN: Add software or a new version.
router.post("/", async (req, res) => {
  const { name, publisher, version, status } = req.body || {};

  if (
    !isValidText(name) ||
    !isValidText(publisher) ||
    !isValidText(version, 80) ||
    !STATUSES.has(status)
  ) {
    return res.status(400).json({
      error: "Invalid software information"
    });
  }

  let client;

  try {
    client = await pool.connect();

    await client.query("BEGIN");

    const normalizedName = name.trim();
    const normalizedPublisher = publisher.trim();

    // Prevent simultaneous requests from creating duplicate
    // software groups.
    //
    // IMPORTANT: PostgreSQL does not allow NUL characters
    // in text. chr(31) replaces the old \u0000 separator.
    await client.query(
      `SELECT pg_advisory_xact_lock(
        hashtextextended(
          lower($1) || chr(31) || lower($2),
          0
        )
      )`,
      [normalizedName, normalizedPublisher]
    );

    // Check whether the software group already exists.
    const software = await client.query(
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
        `INSERT INTO software (
          id,
          name,
          publisher
        )
        VALUES (
          gen_random_uuid(),
          $1,
          $2
        )
        RETURNING id`,
        [normalizedName, normalizedPublisher]
      );

      softwareId = inserted.rows[0].id;
    }

    // Prevent duplicate versions.
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

    // Insert the software version.
    const insertedVersion = await client.query(
      `INSERT INTO software_versions (
        id,
        software_id,
        version,
        status
      )
      VALUES (
        gen_random_uuid(),
        $1,
        $2,
        $3
      )
      RETURNING
        id,
        software_id,
        version,
        status`,
      [softwareId, version.trim(), status]
    );

    // Record who created the software version.
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

    // Save both the software version and audit event.
    await client.query("COMMIT");

    res.status(201).json({
      softwareId,
      version: insertedVersion.rows[0]
    });

  } catch (error) {
    if (client) {
      await client.query("ROLLBACK").catch(() => {});
    }

    console.error(
      "Software creation failed:",
      error.message
    );

    res.status(500).json({
      error: "Unable to add software"
    });

  } finally {
    if (client) {
      client.release();
    }
  }
});

// ADMIN: Update a software group's name and publisher.

router.patch("/:id", async (req, res) => {
  const { id } = req.params;
  const { name, publisher } = req.body || {};

  if (
    !isUUID(id) ||
    !isValidText(name) ||
    !isValidText(publisher)
  ) {
    return res.status(400).json({
      error: "Invalid software information"
    });
  }

  let client;

  try {
    client = await pool.connect();
    await client.query("BEGIN");

    const existing = await client.query(
      `SELECT id, name, publisher
       FROM software
       WHERE id = $1
       FOR UPDATE`,
      [id]
    );

    if (!existing.rowCount) {
      await client.query("ROLLBACK");

      return res.status(404).json({
        error: "Software not found"
      });
    }

    const previous = existing.rows[0];
    const newName = name.trim();
    const newPublisher = publisher.trim();

    const nameChanged = previous.name !== newName;
    const publisherChanged =
      previous.publisher !== newPublisher;

    if (!nameChanged && !publisherChanged) {
      await client.query("ROLLBACK");

      return res.json({
        ...previous,
        unchanged: true
      });
    }

    const updated = await client.query(
      `UPDATE software
       SET name = $1,
           publisher = $2
       WHERE id = $3
       RETURNING id, name, publisher`,
      [newName, newPublisher, id]
    );

    await recordApprovalEvent(client, {
      softwareVersionId: null,
      softwareName: newName,
      publisher: newPublisher,
      version: "",
      oldSoftwareName: previous.name,
      newSoftwareName: newName,
      oldPublisher: previous.publisher,
      newPublisher: newPublisher,
      action: "software_updated",
      adminId: req.session.adminId,
      adminEmail: req.session.adminEmail
    });

    await client.query("COMMIT");

    res.json(updated.rows[0]);

  } catch (error) {
    if (client) {
      await client.query("ROLLBACK").catch(() => {});
    }

    console.error(
      "Software update failed:",
      error.message
    );

    if (error.code === "23505") {
      return res.status(409).json({
        error: "A software group with that name and publisher already exists"
      });
    }

    res.status(500).json({
      error: "Unable to update software"
    });

  } finally {
    if (client) {
      client.release();
    }
  }
});



 // ADMIN: Edit a version or its approval status.
router.patch("/versions/:id", async (req, res) => {
  const { id } = req.params;
  const { version, status } = req.body || {};

  if (
    !isUUID(id) ||
    !isValidText(version, 80) ||
    !STATUSES.has(status)
  ) {
    return res.status(400).json({
      error: "Invalid version information"
    });
  }

  let client;

  try {
    client = await pool.connect();
    await client.query("BEGIN");

    // Lock the version while we read its previous values.
    const existing = await client.query(
      `SELECT
         v.id,
         v.version,
         v.status,
         s.name AS software_name,
         s.publisher
       FROM software_versions v
       JOIN software s ON s.id = v.software_id
       WHERE v.id = $1
       FOR UPDATE OF v`,
      [id]
    );

    if (!existing.rowCount) {
      await client.query("ROLLBACK");

      return res.status(404).json({
        error: "Version not found"
      });
    }

    const previous = existing.rows[0];
    const newVersion = version.trim();

    const versionChanged =
      previous.version !== newVersion;

    const statusChanged =
      previous.status !== status;

    // Nothing changed.
    if (!versionChanged && !statusChanged) {
      await client.query("ROLLBACK");

      return res.json({
        id,
        version: previous.version,
        status: previous.status,
        unchanged: true
      });
    }

    const updated = await client.query(
      `UPDATE software_versions
       SET version = $1,
           status = $2
       WHERE id = $3
       RETURNING id, software_id, version, status`,
      [newVersion, status, id]
    );

    // Record changes before committing the transaction.
    // If both change, create two separate audit events.
    if (statusChanged) {
      await recordApprovalEvent(client, {
        softwareVersionId: id,
        softwareName: previous.software_name,
        publisher: previous.publisher,
        version: newVersion,
        oldStatus: previous.status,
        newStatus: status,
        action: "status_changed",
        adminId: req.session.adminId,
        adminEmail: req.session.adminEmail
      });
    }

    
if (versionChanged) {
  await recordApprovalEvent(client, {
    softwareVersionId: id,
    softwareName: previous.software_name,
    publisher: previous.publisher,
    version: newVersion,
    oldStatus: previous.status,
    newStatus: status,
    oldVersion: previous.version,
    newVersion: newVersion,
    action: "version_updated",
    adminId: req.session.adminId,
    adminEmail: req.session.adminEmail
  });
}


    await client.query("COMMIT");

    res.json(updated.rows[0]);

  } catch (error) {
    if (client) {
      await client.query("ROLLBACK").catch(() => {});
    }

    console.error("Version update failed:", error.message);

    if (error.code === "23505") {
      return res.status(409).json({
        error: "That software version already exists"
      });
    }

    res.status(500).json({
      error: "Unable to update version"
    });

  } finally {
    if (client) {
      client.release();
    }
  }
});


// ADMIN: Delete a software version.

router.delete("/versions/:id", async (req, res) => {
  const { id } = req.params;

  if (!isUUID(id)) {
    return res.status(400).json({
      error: "Invalid version ID"
    });
  }

  let client;

  try {
    client = await pool.connect();
    await client.query("BEGIN");

    // Read the version and its software details.
    const existing = await client.query(
      `SELECT
         v.id,
         v.version,
         v.status,
         s.name AS software_name,
         s.publisher
       FROM software_versions v
       JOIN software s ON s.id = v.software_id
       WHERE v.id = $1
       FOR UPDATE OF v`,
      [id]
    );

    if (!existing.rowCount) {
      await client.query("ROLLBACK");

      return res.status(404).json({
        error: "Version not found"
      });
    }

    const previous = existing.rows[0];

    // Save the audit event before deleting.
    await recordApprovalEvent(client, {
      softwareVersionId: previous.id,
      softwareName: previous.software_name,
      publisher: previous.publisher,
      version: previous.version,
      oldStatus: previous.status,
      newStatus: null,
      deletedStatus: previous.status,
      action: "deleted",
      adminId: req.session.adminId,
      adminEmail: req.session.adminEmail
    });

    // Delete the selected version only.
    await client.query(
      `DELETE FROM software_versions
       WHERE id = $1`,
      [id]
    );

    // Commit the audit record and deletion together.
    await client.query("COMMIT");

    res.json({
      success: true,
      message: "Software version deleted and audited."
    });

  } catch (error) {
    if (client) {
      await client.query("ROLLBACK").catch(() => {});
    }

    console.error(
      "Version deletion failed:",
      error.message
    );

    res.status(500).json({
      error: "Unable to delete software version"
    });

  } finally {
    if (client) {
      client.release();
    }
  }
});

// ADMIN: Delete an entire software group.

router.delete("/:id", async (req, res) => {
  const { id } = req.params;

  if (!isUUID(id)) {
    return res.status(400).json({
      error: "Invalid software ID"
    });
  }

  let client;

  try {
    client = await pool.connect();
    await client.query("BEGIN");

    // Lock the software group before deleting it.
    const existing = await client.query(
      `SELECT id, name, publisher
       FROM software
       WHERE id = $1
       FOR UPDATE`,
      [id]
    );

    if (!existing.rowCount) {
      await client.query("ROLLBACK");

      return res.status(404).json({
        error: "Software not found"
      });
    }

    const software = existing.rows[0];

    // Read and lock all versions belonging to this group.
    const versionsResult = await client.query(
      `SELECT id, version, status
       FROM software_versions
       WHERE software_id = $1
       ORDER BY id
       FOR UPDATE`,
      [id]
    );

    const versions = versionsResult.rows;

    // Preserve an audit record for every deleted version.
    for (const version of versions) {
      await recordApprovalEvent(client, {
        softwareVersionId: version.id,
        softwareName: software.name,
        publisher: software.publisher,
        version: version.version,
        oldStatus: version.status,
        newStatus: null,
        deletedStatus: version.status,
        action: "deleted",
        adminId: req.session.adminId,
        adminEmail: req.session.adminEmail
      });
    }

    // Also preserve the deletion of the software group.
    // This works even if the group has zero versions.
    await recordApprovalEvent(client, {
      softwareVersionId: null,
      softwareName: software.name,
      publisher: software.publisher,
      version: "",
      oldSoftwareName: software.name,
      newSoftwareName: null,
      oldPublisher: software.publisher,
      newPublisher: null,
      action: "deleted",
      adminId: req.session.adminId,
      adminEmail: req.session.adminEmail
    });

    // Delete the versions explicitly.
    await client.query(
      `DELETE FROM software_versions
       WHERE software_id = $1`,
      [id]
    );

    // Delete the software group.
    const deleted = await client.query(
      `DELETE FROM software
       WHERE id = $1
       RETURNING id`,
      [id]
    );

    if (!deleted.rowCount) {
      throw new Error("Software group deletion did not complete");
    }

    // Commit all audit events and deletions together.
    await client.query("COMMIT");

    res.json({
      success: true,
      message: "Software group deleted and audited.",
      deletedVersions: versions.length
    });

  } catch (error) {
    if (client) {
      await client.query("ROLLBACK").catch(() => {});
    }

    console.error(
      "Software group deletion failed:",
      error.message
    );

    res.status(500).json({
      error: "Unable to delete software group"
    });

  } finally {
    if (client) {
      client.release();
    }
  }
});


module.exports = router;
