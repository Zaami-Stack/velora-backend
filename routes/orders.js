const express = require("express");
const { auth } = require("../middleware/auth");
const { pool } = require("../models/db");
const { orderLimiter } = require("../middleware/rateLimiter");
const { createOrderRules } = require("../middleware/validate");

const router = express.Router();

// GET /api/orders - list user's orders
router.get("/", auth, async (req, res) => {
  try {
    const [orders] = await pool.query(
      "SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC",
      [req.user.id]
    );

    for (const order of orders) {
      const [items] = await pool.query(
        "SELECT * FROM order_items WHERE order_id = ?",
        [order.id]
      );
      order.items = items;
    }

    res.json(orders);
  } catch (err) {
    console.error("Orders list error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// POST /api/orders - create order
router.post("/", auth, orderLimiter, createOrderRules, async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { items, shippingAddress } = req.body;

    await conn.beginTransaction();

    const orderItems = [];
    for (const item of items) {
      const [rows] = await conn.query("SELECT * FROM products WHERE id = ?", [item.productId]);
      if (rows.length === 0) continue;
      const product = rows[0];
      orderItems.push({
        productId: product.id,
        name: product.name,
        image: product.image,
        price: product.price,
        quantity: item.quantity,
      });
    }

    if (orderItems.length === 0) {
      await conn.rollback();
      return res.status(400).json({ error: "No valid products found" });
    }

    const subtotal = orderItems.reduce((sum, i) => sum + i.price * i.quantity, 0);
    const shipping = subtotal >= 50 ? 0 : 9.99;
    const total = subtotal + shipping;
    const orderId = "ORD-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6).toUpperCase();

    await conn.query(
      "INSERT INTO orders (id, user_id, subtotal, shipping, total, shipping_address, status) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [orderId, req.user.id, subtotal, shipping, total, JSON.stringify(shippingAddress || {}), "pending"]
    );

    for (const item of orderItems) {
      await conn.query(
        "INSERT INTO order_items (order_id, product_id, name, image, price, quantity) VALUES (?, ?, ?, ?, ?, ?)",
        [orderId, item.productId, item.name, item.image, item.price, item.quantity]
      );
    }

    await conn.commit();

    const order = {
      id: orderId,
      userId: req.user.id,
      items: orderItems,
      subtotal,
      shipping,
      total,
      shippingAddress: shippingAddress || {},
      status: "pending",
      createdAt: new Date().toISOString(),
    };

    res.status(201).json(order);
  } catch (err) {
    await conn.rollback();
    console.error("Order create error:", err);
    res.status(500).json({ error: "Server error" });
  } finally {
    conn.release();
  }
});

// GET /api/orders/:id - get single order
router.get("/:id", auth, async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT * FROM orders WHERE id = ? AND user_id = ?",
      [req.params.id, req.user.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: "Order not found" });

    const order = rows[0];
    const [items] = await pool.query("SELECT * FROM order_items WHERE order_id = ?", [order.id]);
    order.items = items;

    res.json(order);
  } catch (err) {
    console.error("Order detail error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// PATCH /api/orders/:id/cancel - cancel order (only if pending)
router.patch("/:id/cancel", auth, async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT * FROM orders WHERE id = ? AND user_id = ?",
      [req.params.id, req.user.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: "Order not found" });

    const order = rows[0];
    if (order.status !== "pending") {
      return res.status(400).json({ error: "Only pending orders can be cancelled" });
    }

    await pool.query("UPDATE orders SET status = 'cancelled' WHERE id = ?", [order.id]);
    res.json({ message: "Order cancelled successfully", status: "cancelled" });
  } catch (err) {
    console.error("Order cancel error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
