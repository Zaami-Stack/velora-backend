const express = require("express");
const { randomUUID: uuidv4 } = require("crypto");
const { pool } = require("../models/db");
const { orderLimiter } = require("../middleware/rateLimiter");

const router = express.Router();

const VALID_STATUSES = ["pending", "processing", "shipped", "delivered", "cancelled"];

// POST /api/orders - create order (guest checkout, no auth required)
router.post("/", orderLimiter, async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { items, shippingAddress } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "No items provided" });
    }

    if (items.length > 50) {
      return res.status(400).json({ error: "Too many items (max 50)" });
    }

    for (const item of items) {
      if (!item.productId || !Number.isInteger(Number(item.productId))) {
        return res.status(400).json({ error: "Invalid product ID" });
      }
      if (!item.quantity || item.quantity < 1 || item.quantity > 99) {
        return res.status(400).json({ error: "Invalid quantity" });
      }
    }

    await conn.beginTransaction();

    const orderItems = [];
    let droppedCount = 0;
    for (const item of items) {
      const [rows] = await conn.query("SELECT * FROM products WHERE id = ?", [item.productId]);
      if (rows.length === 0) { droppedCount++; continue; }
      const product = rows[0];
      orderItems.push({
        productId: product.id,
        name: product.name,
        image: product.image,
        price: Number(product.price),
        quantity: item.quantity,
        size: item.size || null,
        color: item.color || null,
      });
    }

    if (orderItems.length === 0) {
      await conn.rollback();
      return res.status(400).json({ error: "No valid products found" });
    }

    if (droppedCount > 0 && droppedCount === items.length) {
      await conn.rollback();
      return res.status(400).json({ error: "None of the products exist" });
    }

    const subtotal = Number((orderItems.reduce((sum, i) => sum + i.price * i.quantity, 0)).toFixed(2));
    const shipping = subtotal >= 50 ? 0 : 9.99;
    const total = Number((subtotal + shipping).toFixed(2));
    const orderId = "ORD-" + uuidv4().slice(0, 8).toUpperCase();

    await conn.query(
      "INSERT INTO orders (id, user_id, subtotal, shipping, total, shipping_address, status) VALUES (?, NULL, ?, ?, ?, ?, ?)",
      [orderId, subtotal, shipping, total, JSON.stringify(shippingAddress || {}), "pending"]
    );

    for (const item of orderItems) {
      await conn.query(
        "INSERT INTO order_items (order_id, product_id, name, image, price, quantity) VALUES (?, ?, ?, ?, ?, ?)",
        [orderId, item.productId, item.name, item.image, item.price, item.quantity]
      );
    }

    await conn.commit();

    res.status(201).json({
      id: orderId,
      items: orderItems,
      subtotal,
      shipping,
      total,
      shippingAddress: shippingAddress || {},
      status: "pending",
      createdAt: new Date().toISOString(),
    });
  } catch (err) {
    await conn.rollback();
    console.error("Order create error:", err);
    res.status(500).json({ error: "Server error" });
  } finally {
    conn.release();
  }
});

module.exports = router;
