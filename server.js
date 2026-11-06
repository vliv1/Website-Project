
require("dotenv").config();

const express = require("express");
const path = require("path");
const helmet = require("helmet");
const session = require("express-session");
const connectPgSimple = require("connect-pg-simple");
const { rateLimit } = require("express-rate-limit");
const argon2 = require("argon2");
const pool = require("./db");
const softwareRoutes = require("./routes/software");

const app = express();
const PORT = process.env.PORT || 3000;
const production = process.env.NODE_ENV === "production";

if (!process.env.SESSION_SECRET ||
    process.env.SESSION_SECRET.length < 32) {
  throw new Error(
    "SESSION_SECRET must contain at least 32 characters"
  );
}

app.disable("x-powered-by");

if (production) {
  // Render forwards HTTPS requests through its proxy.
  app.set("trust proxy", 1);
}

// Temporary: your V2 index.html contains inline scripts.
// We will move them into a separate file before production.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"]
    }
  }
}));

app.use(express.json({ limit: "10kb" }));

const PgSession = connectPgSimple(session);

const sessionStore = new PgSession({
  pool,
  tableName: "session",
  createTableIfMissing: true,
  pruneSessionInterval: 60 * 15
});

app.use(session({
  name: "softtrack.sid",
  store: sessionStore,
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: false,
  cookie: {
    httpOnly: true,
    secure: production,
    sameSite: "lax",
    maxAge: 1000 * 60 * 60 * 4,
    path: "/"
  }
}));

// Require same-origin requests for state-changing endpoints.
// This protects these JSON endpoints from cross-site requests.

function requireSameOrigin(req, res, next) {
  const origin = req.get("origin");
  const allowedOrigin = process.env.APP_ORIGIN;

  if (!allowedOrigin) {
    return res.status(500).json({
      error: "Application origin is not configured"
    });
  }

  if (!origin) {
    return res.status(403).json({
      error: "Origin header required"
    });
  }

  try {
    const source = new URL(origin);
    const destination = new URL(allowedOrigin);

    if (
      !["http:", "https:"].includes(source.protocol) ||
      !["http:", "https:"].includes(destination.protocol) ||
      source.origin !== destination.origin
    ) {
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




function requireAdmin(req, res, next) {
  if (!req.session.adminId) {
    return res.status(401).json({
      error: "Administrator login required"
    });
  }

  next();
}

function requireAdminPage(req, res, next) {
  if (!req.session.adminId) {
    return res.redirect("/login.html");
  }

  next();
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    error: "Too many attempts. Try again later."
  }
});

function regenerateSession(req) {
  return new Promise((resolve, reject) => {
    req.session.regenerate(error =>
      error ? reject(error) : resolve()
    );
  });
}

function saveSession(req) {
  return new Promise((resolve, reject) => {
    req.session.save(error =>
      error ? reject(error) : resolve()
    );
  });
}

// Public login endpoint
app.post(
  "/api/admin/login",
  loginLimiter,
  requireSameOrigin,
  async (req, res) => {
    try {
      const { email, password } = req.body || {};

      if (typeof email !== "string" ||
          typeof password !== "string" ||
          email.length > 254 ||
          password.length > 1024) {
        return res.status(400).json({
          error: "Invalid login request"
        });
      }

      const result = await pool.query(
        `SELECT id, email, password_hash
         FROM admins
         WHERE email = $1`,
        [email.trim().toLowerCase()]
      );

      const admin = result.rows[0];

      // Keep failure messages generic.
      const valid = admin
        ? await argon2.verify(
            admin.password_hash,
            password
          )
        : false;

      if (!valid) {
        return res.status(401).json({
          error: "Invalid email or password"
        });
      }

      // Prevent session fixation.
      await regenerateSession(req);

      req.session.adminId = admin.id;
      req.session.adminEmail = admin.email;

      await saveSession(req);

      res.json({
        success: true,
        redirect: "/admin"
      });
    } catch (error) {
      console.error("Login failed:", error.message);

      res.status(500).json({
        error: "Unable to sign in"
      });
    }
  }
);

// Return current login state
app.get("/api/admin/me", (req, res) => {
  res.set("Cache-Control", "no-store");

  if (!req.session.adminId) {
    return res.json({
      authenticated: false
    });
  }

  res.json({
    authenticated: true,
    email: req.session.adminEmail
  });
});

// Protected API example
app.get(
  "/api/admin/check",
  requireAdmin,
  (req, res) => {
    res.json({
      success: true,
      message: "Administrator access confirmed"
    });
  }
);





// Log out and invalidate the session
app.post(
  "/api/admin/logout",
  requireSameOrigin,
  (req, res) => {
    req.session.destroy(error => {
      if (error) {
        return res.status(500).json({
          error: "Unable to sign out"
        });
      }

      res.clearCookie("softtrack.sid", {
        path: "/",
        secure: production,
        sameSite: "lax",
        httpOnly: true
      });

      res.json({ success: true });
    });
  }
);

// Protect the private administrator page.
app.get(
  "/admin",
  requireAdminPage,
  (req, res) => {
    res.set("Cache-Control", "no-store");
    res.sendFile(
      path.join(__dirname, "private", "admin.html")
    );
  }
);

app.use("/api/software", softwareRoutes);

// Keep your existing V2 public website working.
app.use(express.static(
  path.join(__dirname, "public")
));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`SoftTrack running on port ${PORT}`);
});
