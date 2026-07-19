const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { randomUUID: uuidv4 } = require("crypto");
const { pool } = require("../models/db");
const { auth } = require("../middleware/auth");
const { authLimiter } = require("../middleware/rateLimiter");
const { registerRules, loginRules } = require("../middleware/validate");

const router = express.Router();

// In-memory failed login tracker
const failedLogins = new Map();
const MAX_FAILED = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

function isLockedOut(email) {
  const record = failedLogins.get(email);
  if (!record) return false;
  if (Date.now() - record.firstAttempt > LOCKOUT_MS) {
    failedLogins.delete(email);
    return false;
  }
  return record.count >= MAX_FAILED;
}

function recordFailedLogin(email) {
  const record = failedLogins.get(email) || { count: 0, firstAttempt: Date.now() };
  record.count++;
  if (record.count === 1) record.firstAttempt = Date.now();
  failedLogins.set(email, record);
}

function clearFailedLogins(email) {
  failedLogins.delete(email);
}

function generateToken(user) {
  return jwt.sign(
    { id: user.id, name: user.name, email: user.email, is_admin: user.is_admin },
    process.env.JWT_SECRET,
    { expiresIn: "7d" }
  );
}

// POST /api/auth/register
router.post("/register", authLimiter, registerRules, async (req, res) => {
  try {
    const { name, email, password, phone, securityQuestion, securityAnswer } = req.body;

    const [existing] = await pool.query("SELECT id FROM users WHERE email = ?", [email]);
    if (existing.length > 0) {
      return res.status(409).json({ error: "Account already exists with this email" });
    }

    if (!securityQuestion || !securityAnswer || !securityAnswer.trim()) {
      return res.status(400).json({ error: "Security question and answer are required" });
    }

    const hashedPassword = await bcrypt.hash(password, 12);
    const id = uuidv4();
    const securityAnswerHash = await bcrypt.hash(securityAnswer.trim().toLowerCase(), 10);

    await pool.query(
      "INSERT INTO users (id, name, email, password, phone, security_question, security_answer_hash) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [id, name, email, hashedPassword, phone || null, securityQuestion, securityAnswerHash]
    );

    const token = generateToken({ id, name, email, is_admin: 0 });

    console.log(`[REGISTER] New user registered: ${email}`);

    res.status(201).json({ token, user: { id, name, email, is_admin: 0, phone: phone || null } });
  } catch (err) {
    console.error("Register error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// POST /api/auth/login
router.post("/login", authLimiter, loginRules, async (req, res) => {
  try {
    const { email, password } = req.body;

    if (isLockedOut(email)) {
      return res.status(429).json({ error: "Account temporarily locked. Please try again in 15 minutes." });
    }

    const [rows] = await pool.query("SELECT * FROM users WHERE email = ?", [email]);
    if (rows.length === 0) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const user = rows[0];
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      recordFailedLogin(email);
      return res.status(401).json({ error: "Invalid email or password" });
    }

    clearFailedLogins(email);

    const token = generateToken(user);
    res.json({
      token,
      user: { id: user.id, name: user.name, email: user.email, is_admin: user.is_admin },
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// GET /api/auth/me
router.get("/me", auth, async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT id, name, email, is_admin FROM users WHERE id = ?",
      [req.user.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: "User not found" });
    res.json(rows[0]);
  } catch (err) {
    console.error("Auth me error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// POST /api/auth/forgot-password — step 1: get the security question for an email
router.post("/forgot-password", authLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Email is required" });

    const [rows] = await pool.query("SELECT security_question FROM users WHERE email = ?", [email]);
    if (rows.length === 0 || !rows[0].security_question) {
      return res.status(404).json({ error: "No account found with this email" });
    }

    res.json({ securityQuestion: rows[0].security_question });
  } catch (err) {
    console.error("Forgot password error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// POST /api/auth/reset-password — step 2: verify answer + set new password
router.post("/reset-password", authLimiter, async (req, res) => {
  try {
    const { email, answer, password } = req.body;
    if (!email || !answer || !password) {
      return res.status(400).json({ error: "Email, security answer, and new password are required" });
    }
    if (password.length < 6 || password.length > 128) {
      return res.status(400).json({ error: "Password must be 6-128 characters" });
    }

    const [rows] = await pool.query("SELECT * FROM users WHERE email = ?", [email]);
    if (rows.length === 0) {
      return res.status(400).json({ error: "Invalid email or answer" });
    }

    const user = rows[0];

    if (!user.security_answer_hash) {
      return res.status(400).json({ error: "No security question set for this account. Contact support." });
    }

    const answerValid = await bcrypt.compare(answer.trim().toLowerCase(), user.security_answer_hash);
    if (!answerValid) {
      return res.status(400).json({ error: "Incorrect answer. Please try again." });
    }

    const hashedPassword = await bcrypt.hash(password, 12);
    await pool.query("UPDATE users SET password = ? WHERE id = ?", [hashedPassword, user.id]);

    console.log(`[PASSWORD RESET] Password updated for user`);

    res.json({ message: "Password has been reset successfully. You can now log in." });
  } catch (err) {
    console.error("Reset password error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// PUT /api/auth/profile — update user profile
router.put("/profile", auth, async (req, res) => {
  try {
    const { name, email, phone } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: "Name is required" });
    if (!email || !/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: "Valid email is required" });

    // Check if email is taken by another user
    const [existing] = await pool.query("SELECT id FROM users WHERE email = ? AND id != ?", [email, req.user.id]);
    if (existing.length > 0) {
      return res.status(409).json({ error: "Email is already in use" });
    }

    await pool.query("UPDATE users SET name = ?, email = ?, phone = ? WHERE id = ?", [name.trim(), email, phone || null, req.user.id]);
    res.json({ message: "Profile updated successfully", user: { id: req.user.id, name: name.trim(), email, phone: phone || null } });
  } catch (err) {
    console.error("Profile update error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// PUT /api/auth/password — change password (requires current password)
router.put("/password", auth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: "Current and new password are required" });
    }
    if (newPassword.length < 6 || newPassword.length > 128) {
      return res.status(400).json({ error: "New password must be 6-128 characters" });
    }

    const [rows] = await pool.query("SELECT password FROM users WHERE id = ?", [req.user.id]);
    if (rows.length === 0) return res.status(404).json({ error: "User not found" });

    const valid = await bcrypt.compare(currentPassword, rows[0].password);
    if (!valid) return res.status(400).json({ error: "Current password is incorrect" });

    const hashedPassword = await bcrypt.hash(newPassword, 12);
    await pool.query("UPDATE users SET password = ? WHERE id = ?", [hashedPassword, req.user.id]);

    res.json({ message: "Password changed successfully" });
  } catch (err) {
    console.error("Password change error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
