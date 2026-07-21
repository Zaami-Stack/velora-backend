const express = require("express");
const { pool } = require("../models/db");
const { auth, adminOnly } = require("../middleware/auth");

const router = express.Router();

router.use(auth, adminOnly);

// GET /api/admin/dashboard
router.get("/dashboard", async (req, res) => {
  try {
    const [[{ totalOrders }]] = await pool.query("SELECT COUNT(*) AS totalOrders FROM orders");
    const [[{ totalRevenue }]] = await pool.query("SELECT COALESCE(SUM(total), 0) AS totalRevenue FROM orders");
    const [[{ pendingOrders }]] = await pool.query(
      "SELECT COUNT(*) AS pendingOrders FROM orders WHERE status = 'pending'"
    );

    const [recentOrders] = await pool.query(`
      SELECT o.*,
        COALESCE(u.name, CONCAT(JSON_UNQUOTE(JSON_EXTRACT(o.shipping_address, '$.firstName')), ' ', JSON_UNQUOTE(JSON_EXTRACT(o.shipping_address, '$.lastName')))) AS customer_name,
        COALESCE(u.email, JSON_UNQUOTE(JSON_EXTRACT(o.shipping_address, '$.email'))) AS customer_email
      FROM orders o
      LEFT JOIN users u ON o.user_id = u.id
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
      pendingOrders,
      recentOrders,
    });
  } catch (err) {
    console.error("Admin dashboard error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// GET /api/admin/orders
router.get("/orders", async (req, res) => {
  try {
    const { status } = req.query;
    let sql = `
      SELECT o.*,
        COALESCE(u.name, CONCAT(JSON_UNQUOTE(JSON_EXTRACT(o.shipping_address, '$.firstName')), ' ', JSON_UNQUOTE(JSON_EXTRACT(o.shipping_address, '$.lastName')))) AS customer_name,
        COALESCE(u.email, JSON_UNQUOTE(JSON_EXTRACT(o.shipping_address, '$.email'))) AS customer_email
      FROM orders o
      LEFT JOIN users u ON o.user_id = u.id
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
router.patch("/orders/:id", async (req, res) => {
  try {
    const { status } = req.body;

    const [result] = await pool.query("UPDATE orders SET status = ? WHERE id = ?", [status, req.params.id]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Order not found" });
    }

    const [rows] = await pool.query(`
      SELECT o.*,
        COALESCE(u.name, CONCAT(JSON_UNQUOTE(JSON_EXTRACT(o.shipping_address, '$.firstName')), ' ', JSON_UNQUOTE(JSON_EXTRACT(o.shipping_address, '$.lastName')))) AS customer_name,
        COALESCE(u.email, JSON_UNQUOTE(JSON_EXTRACT(o.shipping_address, '$.email'))) AS customer_email
      FROM orders o
      LEFT JOIN users u ON o.user_id = u.id
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

// GET /api/admin/products
router.get("/products", async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT p.* FROM products p ORDER BY p.id ASC");
    const [allColors] = await pool.query("SELECT product_id, color_hex, image FROM product_colors");
    const colorMap = {};
    allColors.forEach((c) => {
      if (!colorMap[c.product_id]) colorMap[c.product_id] = [];
      colorMap[c.product_id].push({ hex: c.color_hex, image: c.image || null });
    });
    const products = rows.map((p) => ({ ...p, colors: colorMap[p.id] || [] }));
    res.json(products);
  } catch (err) {
    console.error("Admin products list error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// POST /api/admin/products
router.post("/products", async (req, res) => {
  try {
    const { name, category, price, original_price, image, badge, rating, reviews, description, colors } = req.body;

    if (!name || !category || !price || !image) {
      return res.status(400).json({ error: "Name, category, price, and image are required" });
    }

    const [[{ maxId }]] = await pool.query("SELECT COALESCE(MAX(id), 0) AS maxId FROM products");
    const newId = maxId + 1;

    await pool.query(
      "INSERT INTO products (id, name, category, price, original_price, image, badge, rating, reviews, description) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [newId, name, category, price, original_price || null, image, badge || null, rating || 0, reviews || 0, description || null]
    );

    if (colors && colors.length > 0) {
      const colorValues = colors.map((c) => {
        if (typeof c === "string") return [newId, c, null];
        return [newId, c.hex, c.image || null];
      });
      await pool.query("INSERT INTO product_colors (product_id, color_hex, image) VALUES ?", [colorValues]);
    }

    const [rows] = await pool.query("SELECT * FROM products WHERE id = ?", [newId]);
    const [colorRows] = await pool.query("SELECT color_hex, image FROM product_colors WHERE product_id = ?", [newId]);

    res.status(201).json({
      ...rows[0],
      colors: colorRows.map((c) => ({ hex: c.color_hex, image: c.image || null })),
    });
  } catch (err) {
    console.error("Admin product create error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// PUT /api/admin/products/:id
router.put("/products/:id", async (req, res) => {
  try {
    const { name, category, price, original_price, image, badge, rating, reviews, description, colors } = req.body;
    const { id } = req.params;

    const [existing] = await pool.query("SELECT id FROM products WHERE id = ?", [id]);
    if (existing.length === 0) return res.status(404).json({ error: "Product not found" });

    await pool.query(
      "UPDATE products SET name = ?, category = ?, price = ?, original_price = ?, image = ?, badge = ?, rating = ?, reviews = ?, description = ? WHERE id = ?",
      [name, category, price, original_price || null, image, badge || null, rating || 0, reviews || 0, description || null, id]
    );

    if (colors && Array.isArray(colors)) {
      await pool.query("DELETE FROM product_colors WHERE product_id = ?", [id]);
      if (colors.length > 0) {
        const colorValues = colors.map((c) => {
          if (typeof c === "string") return [id, c, null];
          return [id, c.hex, c.image || null];
        });
        await pool.query("INSERT INTO product_colors (product_id, color_hex, image) VALUES ?", [colorValues]);
      }
    }

    const [rows] = await pool.query("SELECT * FROM products WHERE id = ?", [id]);
    const [colorRows] = await pool.query("SELECT color_hex, image FROM product_colors WHERE product_id = ?", [id]);

    res.json({
      ...rows[0],
      colors: colorRows.map((c) => ({ hex: c.color_hex, image: c.image || null })),
    });
  } catch (err) {
    console.error("Admin product update error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// DELETE /api/admin/products/:id
router.delete("/products/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const [existing] = await pool.query("SELECT id FROM products WHERE id = ?", [id]);
    if (existing.length === 0) return res.status(404).json({ error: "Product not found" });

    await pool.query("DELETE FROM product_colors WHERE product_id = ?", [id]);
    await pool.query("DELETE FROM products WHERE id = ?", [id]);

    res.json({ message: "Product deleted" });
  } catch (err) {
    console.error("Admin product delete error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
