const express = require("express");
const { pool } = require("../models/db");
const { orderLimiter } = require("../middleware/rateLimiter");

const router = express.Router();

// POST /api/orders - create order (guest checkout, no auth required)
router.post("/", orderLimiter, async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { items, shippingAddress } = req.body;

    if (!items || items.length === 0) {
      return res.status(400).json({ error: "No items provided" });
    }

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
        price: item.price || product.price,
        quantity: item.quantity,
        size: item.size || null,
        color: item.color || null,
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
      [orderId, null, subtotal, shipping, total, JSON.stringify(shippingAddress || {}), "pending"]
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

module.exports = router;
