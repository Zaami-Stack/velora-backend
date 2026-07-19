const express = require("express");
const { auth, adminOnly } = require("../middleware/auth");
const { pool } = require("../models/db");
const { updateOrderStatusRules, adminOrderListRules } = require("../middleware/validate");

const router = express.Router();

// GET /api/admin/dashboard
router.get("/dashboard", auth, adminOnly, async (req, res) => {
  try {
    const [[{ totalOrders }]] = await pool.query("SELECT COUNT(*) AS totalOrders FROM orders");
    const [[{ totalRevenue }]] = await pool.query("SELECT COALESCE(SUM(total), 0) AS totalRevenue FROM orders");
    const [[{ totalUsers }]] = await pool.query("SELECT COUNT(*) AS totalUsers FROM users");
    const [[{ pendingOrders }]] = await pool.query(
      "SELECT COUNT(*) AS pendingOrders FROM orders WHERE status = 'pending'"
    );

    const [recentOrders] = await pool.query(`
      SELECT o.*, u.name AS customer_name, u.email AS customer_email
      FROM orders o
      JOIN users u ON o.user_id = u.id
      ORDER BY o.created_at DESC
      LIMIT 5
    `);

    for (const order of recentOrders) {
      const [items] = await pool.query("SELECT * FROM order_items WHERE order_id = ?", [order.id]);
      order.items = items;
    }

    res.json({
      totalOrders,
      totalRevenue: Number(totalRevenue),
      totalUsers,
      pendingOrders,
      recentOrders,
    });
  } catch (err) {
    console.error("Admin dashboard error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// GET /api/admin/orders
router.get("/orders", auth, adminOnly, adminOrderListRules, async (req, res) => {
  try {
    const { status } = req.query;
    let sql = `
      SELECT o.*, u.name AS customer_name, u.email AS customer_email
      FROM orders o
      JOIN users u ON o.user_id = u.id
    `;
    const params = [];

    if (status && status !== "all") {
      sql += " WHERE o.status = ?";
      params.push(status);
    }

    sql += " ORDER BY o.created_at DESC";

    const [orders] = await pool.query(sql, params);

    for (const order of orders) {
      const [items] = await pool.query("SELECT * FROM order_items WHERE order_id = ?", [order.id]);
      order.items = items;
    }

    res.json(orders);
  } catch (err) {
    console.error("Admin orders list error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// PATCH /api/admin/orders/:id
router.patch("/orders/:id", auth, adminOnly, updateOrderStatusRules, async (req, res) => {
  try {
    const { status } = req.body;

    const [result] = await pool.query("UPDATE orders SET status = ? WHERE id = ?", [status, req.params.id]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Order not found" });
    }

    const [rows] = await pool.query(`
      SELECT o.*, u.name AS customer_name, u.email AS customer_email
      FROM orders o
      JOIN users u ON o.user_id = u.id
      WHERE o.id = ?
    `, [req.params.id]);

    const order = rows[0];
    const [items] = await pool.query("SELECT * FROM order_items WHERE order_id = ?", [order.id]);
    order.items = items;

    res.json(order);
  } catch (err) {
    console.error("Admin order update error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// GET /api/admin/users
router.get("/users", auth, adminOnly, async (req, res) => {
  try {
    const [users] = await pool.query(`
      SELECT u.id, u.name, u.email, u.phone, u.is_admin, u.created_at,
        COUNT(o.id) AS order_count,
        COALESCE(SUM(o.total), 0) AS total_spent
      FROM users u
      LEFT JOIN orders o ON u.id = o.user_id
      GROUP BY u.id
      ORDER BY u.created_at DESC
    `);
    res.json(users);
  } catch (err) {
    console.error("Admin users list error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
