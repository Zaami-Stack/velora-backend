const jwt = require("jsonwebtoken");
const { pool } = require("../models/db");

function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Access denied. No token provided." });
  }
  try {
    const token = header.split(" ")[1];
    if (!token || token.split(".").length !== 3) {
      return res.status(401).json({ error: "Invalid token format." });
    }
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      return res.status(401).json({ error: "Token expired." });
    }
    return res.status(401).json({ error: "Invalid token." });
  }
}

function optionalAuth(req, res, next) {
  const header = req.headers.authorization;
  if (header && header.startsWith("Bearer ")) {
    try {
      const token = header.split(" ")[1];
      req.user = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
      // Ignore invalid tokens for optional auth
    }
  }
  next();
}

async function adminOnly(req, res, next) {
  if (!req.user) {
    return res.status(403).json({ error: "Admin access required" });
  }
  try {
    const [rows] = await pool.query("SELECT is_admin FROM users WHERE id = ?", [req.user.id]);
    if (rows.length === 0 || !rows[0].is_admin) {
      return res.status(403).json({ error: "Admin access required" });
    }
    next();
  } catch (err) {
    console.error("Admin check error:", err);
    return res.status(403).json({ error: "Admin access required" });
  }
}

module.exports = { auth, optionalAuth, adminOnly };
