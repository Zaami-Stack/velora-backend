const express = require("express");
const { pool } = require("../models/db");

const { productListRules, productIdRules } = require("../middleware/validate");

const router = express.Router();

// GET /api/products
router.get("/", productListRules, async (req, res) => {
  try {
    const { category, search, sort, minPrice, maxPrice, badge } = req.query;

    let sql = `
      SELECT p.*
      FROM products p
    `;
    const conditions = [];
    const params = [];

    if (category && category !== "All" && category !== "New In") {
      conditions.push("p.category = ?");
      params.push(category);
    }
    if (category === "New In") {
      conditions.push("p.badge = ?");
      params.push("New");
    }
    if (badge) {
      conditions.push("p.badge = ?");
      params.push(badge);
    }
    if (search) {
      conditions.push("(LOWER(p.name) LIKE ? OR LOWER(p.category) LIKE ? OR LOWER(p.description) LIKE ?)");
      const q = `%${search.toLowerCase()}%`;
      params.push(q, q, q);
    }
    if (minPrice) {
      conditions.push("p.price >= ?");
      params.push(Number(minPrice));
    }
    if (maxPrice) {
      conditions.push("p.price <= ?");
      params.push(Number(maxPrice));
    }

    if (conditions.length > 0) {
      sql += " WHERE " + conditions.join(" AND ");
    }

    switch (sort) {
      case "price_asc": sql += " ORDER BY p.price ASC"; break;
      case "price_desc": sql += " ORDER BY p.price DESC"; break;
      case "rating": sql += " ORDER BY p.rating DESC"; break;
      case "newest": sql += " ORDER BY (p.badge = 'New') DESC"; break;
      default: sql += " ORDER BY p.id ASC"; break;
    }

    const [rows] = await pool.query(sql, params);
    const [allColors] = await pool.query("SELECT product_id, color_hex, image FROM product_colors");
    const colorMap = {};
    allColors.forEach((c) => {
      if (!colorMap[c.product_id]) colorMap[c.product_id] = [];
      colorMap[c.product_id].push({ hex: c.color_hex, image: c.image || null });
    });
    const products = rows.map((r) => ({ ...r, colors: colorMap[r.id] || [] }));

    res.json({ products, total: products.length });
  } catch (err) {
    console.error("Products list error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// GET /api/products/categories
router.get("/categories", async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT category AS name, COUNT(*) AS count FROM products GROUP BY category ORDER BY category"
    );
    res.json(rows);
  } catch (err) {
    console.error("Categories error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// GET /api/products/banners - public, for homepage carousel
router.get("/banners", async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT id, title, subtitle, badge, button_text AS buttonText, button_link AS buttonLink, image FROM banners WHERE is_active = 1 ORDER BY sort_order ASC, id ASC"
    );
    res.json(rows);
  } catch (err) {
    console.error("Banners list error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// GET /api/products/:id
router.get("/:id", productIdRules, async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT * FROM products WHERE id = ?", [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: "Product not found" });

    const [colors] = await pool.query(
      "SELECT color_hex, image FROM product_colors WHERE product_id = ?",
      [req.params.id]
    );
    const product = { ...rows[0], colors: colors.map((c) => ({ hex: c.color_hex, image: c.image || null })) };

    res.json(product);
  } catch (err) {
    console.error("Product detail error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
