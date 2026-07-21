const express = require("express");
const { randomUUID: uuidv4 } = require("crypto");
const { pool } = require("../models/db");
const { orderLimiter } = require("../middleware/rateLimiter");
const { sendOrderConfirmation } = require("../services/email");

const router = express.Router();

const VALID_STATUSES = ["pending", "processing", "shipped", "delivered", "cancelled"];

// POST /api/orders - create order (guest checkout, no auth required)
router.post("/", orderLimiter, async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { items, shippingAddress, couponCode } = req.body;

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
    let totalDelivery = 0;
    for (const item of items) {
      const [rows] = await conn.query("SELECT * FROM products WHERE id = ?", [item.productId]);
      if (rows.length === 0) { droppedCount++; continue; }
      const product = rows[0];

      // Stock check
      if (product.stock !== null && product.stock !== undefined) {
        if (product.stock < item.quantity) {
          await conn.rollback();
          return res.status(400).json({ error: `Insufficient stock for "${product.name}". Available: ${product.stock}` });
        }
        await conn.query("UPDATE products SET stock = stock - ? WHERE id = ?", [item.quantity, item.productId]);
      }

      const deliveryPrice = Number(product.delivery_price) || 0;
      totalDelivery += deliveryPrice * item.quantity;
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

    let subtotal = Number((orderItems.reduce((sum, i) => sum + i.price * i.quantity, 0)).toFixed(2));
    let shipping = Number(totalDelivery.toFixed(2));

    // Apply coupon
    let discount = 0;
    let couponId = null;
    if (couponCode) {
      const [[coupon]] = await conn.query("SELECT * FROM coupons WHERE code = ? AND is_active = 1", [couponCode.toUpperCase()]);
      if (coupon) {
        const now = new Date();
        const expired = coupon.expires_at && new Date(coupon.expires_at) < now;
        const maxedOut = coupon.max_uses && coupon.times_used >= coupon.max_uses;
        const belowMin = coupon.min_order && subtotal < coupon.min_order;
        if (!expired && !maxedOut && !belowMin) {
          discount = coupon.discount_type === "percentage"
            ? Number((subtotal * coupon.discount_value / 100).toFixed(2))
            : Math.min(coupon.discount_value, subtotal);
          couponId = coupon.id;
          await conn.query("UPDATE coupons SET times_used = times_used + 1 WHERE id = ?", [coupon.id]);
        }
      }
    }

    const total = Number((subtotal - discount + shipping).toFixed(2));
    const orderId = "ORD-" + uuidv4().slice(0, 8).toUpperCase();

    await conn.query(
      "INSERT INTO orders (id, user_id, subtotal, shipping, total, shipping_address, status, coupon_id, discount) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?)",
      [orderId, subtotal, shipping, total, JSON.stringify(shippingAddress || {}), "pending", couponId, discount]
    );

    for (const item of orderItems) {
      await conn.query(
        "INSERT INTO order_items (order_id, product_id, name, image, price, quantity, size, color) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [orderId, item.productId, item.name, item.image, item.price, item.quantity, item.size, item.color]
      );
    }

    await conn.commit();

    // Send confirmation email (non-blocking)
    const orderData = { id: orderId, subtotal, shipping, discount, total, status: "pending", shippingAddress: shippingAddress || {}, customerEmail: shippingAddress?.email };
    sendOrderConfirmation(orderData, orderItems).catch(() => {});

    res.status(201).json({
      id: orderId,
      items: orderItems,
      subtotal,
      shipping,
      discount,
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

// GET /api/orders/:id/track - public order tracking (no auth)
router.get("/:id/track", async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT id, status, subtotal, shipping, discount, total, shipping_address, created_at FROM orders WHERE id = ?",
      [req.params.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: "Order not found" });
    }
    const order = rows[0];
    const [items] = await pool.query("SELECT name, image, price, quantity, size, color FROM order_items WHERE order_id = ?", [order.id]);
    res.json({
      id: order.id,
      status: order.status,
      subtotal: Number(order.subtotal),
      shipping: Number(order.shipping),
      discount: Number(order.discount || 0),
      total: Number(order.total),
      items,
      createdAt: order.created_at,
    });
  } catch (err) {
    console.error("Order track error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// GET /api/orders/:id - get order details (auth required, own orders only)
const { auth } = require("../middleware/auth");
router.get("/:id", auth, async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT * FROM orders WHERE id = ? AND user_id = ?", [req.params.id, req.user.id]);
    if (rows.length === 0) return res.status(404).json({ error: "Order not found" });
    const [items] = await pool.query("SELECT * FROM order_items WHERE order_id = ?", [req.params.id]);
    res.json({ ...rows[0], items });
  } catch (err) {
    console.error("Order detail error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// GET /api/orders - list user orders (auth required)
router.get("/", auth, async (req, res) => {
  try {
    const [orders] = await pool.query("SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC", [req.user.id]);
    for (const order of orders) {
      const [items] = await pool.query("SELECT * FROM order_items WHERE order_id = ?", [order.id]);
      order.items = items;
    }
    res.json(orders);
  } catch (err) {
    console.error("Orders list error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// PATCH /api/orders/:id/cancel
router.patch("/:id/cancel", auth, async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT * FROM orders WHERE id = ? AND user_id = ?", [req.params.id, req.user.id]);
    if (rows.length === 0) return res.status(404).json({ error: "Order not found" });
    if (rows[0].status !== "pending") return res.status(400).json({ error: "Only pending orders can be cancelled" });

    await pool.query("UPDATE orders SET status = 'cancelled' WHERE id = ?", [req.params.id]);
    res.json({ message: "Order cancelled" });
  } catch (err) {
    console.error("Order cancel error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
