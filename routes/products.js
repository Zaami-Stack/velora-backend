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

// GET /api/products/shop-categories - public, for homepage "Shop by Category"
router.get("/shop-categories", async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT id, name, slug, image FROM categories WHERE is_active = 1 ORDER BY sort_order ASC, id ASC"
    );
    res.json(rows);
  } catch (err) {
    console.error("Shop categories error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// GET /api/products/:id/reviews - public reviews for a product
router.get("/:id/reviews", async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT id, customer_name, rating, title, comment, created_at FROM reviews WHERE product_id = ? AND is_approved = 1 ORDER BY created_at DESC",
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    console.error("Product reviews error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// POST /api/products/:id/reviews - submit a review
router.post("/:id/reviews", async (req, res) => {
  try {
    const { customerName, name, customerEmail, email, rating, title, comment, orderId } = req.body;
    const reviewerName = customerName || name;
    const reviewerEmail = customerEmail || email;
    if (!reviewerName || !rating) return res.status(400).json({ error: "Name and rating are required" });
    if (rating < 1 || rating > 5) return res.status(400).json({ error: "Rating must be 1-5" });

    const [product] = await pool.query("SELECT id FROM products WHERE id = ?", [req.params.id]);
    if (product.length === 0) return res.status(404).json({ error: "Product not found" });

    const [result] = await pool.query(
      "INSERT INTO reviews (product_id, order_id, customer_name, customer_email, rating, title, comment, is_approved) VALUES (?, ?, ?, ?, ?, ?, ?, 0)",
      [req.params.id, orderId || null, reviewerName, reviewerEmail || null, rating, title || null, comment || null]
    );

    // Update product rating
    const [[{ avgRating, reviewCount }]] = await pool.query(
      "SELECT AVG(rating) AS avgRating, COUNT(*) AS reviewCount FROM reviews WHERE product_id = ? AND is_approved = 1",
      [req.params.id]
    );
    if (reviewCount > 0) {
      await pool.query("UPDATE products SET rating = ?, reviews = ? WHERE id = ?",
        [Number(avgRating).toFixed(1), reviewCount + 1, req.params.id]);
    }

    res.status(201).json({ message: "Review submitted for approval", id: result.insertId });
  } catch (err) {
    console.error("Review submit error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// POST /api/products/validate-coupon - validate a coupon code
router.post("/validate-coupon", async (req, res) => {
  try {
    const { code, subtotal } = req.body;
    if (!code) return res.status(400).json({ error: "Coupon code is required" });

    const [[coupon]] = await pool.query("SELECT * FROM coupons WHERE code = ? AND is_active = 1", [code.toUpperCase()]);
    if (!coupon) return res.status(404).json({ error: "Invalid coupon code" });

    const now = new Date();
    if (coupon.expires_at && new Date(coupon.expires_at) < now) return res.status(400).json({ error: "Coupon has expired" });
    if (coupon.max_uses && coupon.times_used >= coupon.max_uses) return res.status(400).json({ error: "Coupon usage limit reached" });
    if (coupon.min_order && Number(subtotal || 0) < coupon.min_order) return res.status(400).json({ error: `Minimum order of ${coupon.min_order} DH required` });

    const discount = coupon.discount_type === "percentage"
      ? Number((Number(subtotal || 0) * coupon.discount_value / 100).toFixed(2))
      : coupon.discount_value;

    res.json({
      code: coupon.code,
      discountType: coupon.discount_type,
      discountValue: Number(coupon.discount_value),
      discount,
    });
  } catch (err) {
    console.error("Coupon validate error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// GET /api/products/pages/:slug - public page content
router.get("/pages/:slug", async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT * FROM pages WHERE slug = ?", [req.params.slug]);
    if (rows.length === 0) return res.status(404).json({ error: "Page not found" });
    const page = rows[0];
    let content = {};
    try { content = JSON.parse(page.content || "{}"); } catch {}
    res.json({ slug: page.slug, ...content });
  } catch (err) {
    console.error("Page fetch error:", err);
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
