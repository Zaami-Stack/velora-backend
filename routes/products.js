const express = require("express");
const { pool } = require("../models/db");

const { productListRules, productIdRules } = require("../middleware/validate");

const router = express.Router();

// GET /api/products
router.get("/", productListRules, async (req, res) => {
  try {
    const { category, search, sort, minPrice, maxPrice, badge } = req.query;

    let sql = `
      SELECT p.*, GROUP_CONCAT(pc.color_hex) AS colors
      FROM products p
      LEFT JOIN product_colors pc ON p.id = pc.product_id
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

    sql += " GROUP BY p.id";

    switch (sort) {
      case "price_asc": sql += " ORDER BY p.price ASC"; break;
      case "price_desc": sql += " ORDER BY p.price DESC"; break;
      case "rating": sql += " ORDER BY p.rating DESC"; break;
      case "newest": sql += " ORDER BY (p.badge = 'New') DESC"; break;
      default: sql += " ORDER BY p.id ASC"; break;
    }

    const [rows] = await pool.query(sql, params);
    const products = rows.map((r) => ({
      ...r,
      colors: r.colors ? r.colors.split(",") : [],
    }));

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

// GET /api/products/:id
router.get("/:id", productIdRules, async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT * FROM products WHERE id = ?", [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: "Product not found" });

    const [colors] = await pool.query(
      "SELECT color_hex FROM product_colors WHERE product_id = ?",
      [req.params.id]
    );
    const product = { ...rows[0], colors: colors.map((c) => c.color_hex) };

    res.json(product);
  } catch (err) {
    console.error("Product detail error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
