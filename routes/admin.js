const express = require("express");
const { pool } = require("../models/db");
const { auth, adminOnly } = require("../middleware/auth");
const { sendStatusUpdate } = require("../services/email");

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
    const [[{ totalUsers }]] = await pool.query("SELECT COUNT(DISTINCT JSON_UNQUOTE(JSON_EXTRACT(shipping_address, '$.email'))) AS totalUsers FROM orders WHERE JSON_UNQUOTE(JSON_EXTRACT(shipping_address, '$.email')) IS NOT NULL");

    const [recentOrders] = await pool.query(`
      SELECT o.*,
        COALESCE(u.name, CONCAT(JSON_UNQUOTE(JSON_EXTRACT(o.shipping_address, '$.firstName')), ' ', JSON_UNQUOTE(JSON_EXTRACT(o.shipping_address, '$.lastName')))) AS customer_name,
        COALESCE(u.email, JSON_UNQUOTE(JSON_EXTRACT(o.shipping_address, '$.email'))) AS customer_email,
        JSON_UNQUOTE(JSON_EXTRACT(o.shipping_address, '$.phone')) AS customer_phone
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
      totalUsers,
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
        COALESCE(u.email, JSON_UNQUOTE(JSON_EXTRACT(o.shipping_address, '$.email'))) AS customer_email,
        JSON_UNQUOTE(JSON_EXTRACT(o.shipping_address, '$.phone')) AS customer_phone
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
    const validStatuses = ["pending", "processing", "shipped", "delivered", "cancelled"];
    if (!status || !validStatuses.includes(status)) {
      return res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(", ")}` });
    }

    const [result] = await pool.query("UPDATE orders SET status = ? WHERE id = ?", [status, req.params.id]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Order not found" });
    }

    const [rows] = await pool.query(`
      SELECT o.*,
        COALESCE(u.name, CONCAT(JSON_UNQUOTE(JSON_EXTRACT(o.shipping_address, '$.firstName')), ' ', JSON_UNQUOTE(JSON_EXTRACT(o.shipping_address, '$.lastName')))) AS customer_name,
        COALESCE(u.email, JSON_UNQUOTE(JSON_EXTRACT(o.shipping_address, '$.email'))) AS customer_email,
        JSON_UNQUOTE(JSON_EXTRACT(o.shipping_address, '$.phone')) AS customer_phone
      FROM orders o
      LEFT JOIN users u ON o.user_id = u.id
      WHERE o.id = ?
    `, [req.params.id]);

    const order = rows[0];
    const [items] = await pool.query("SELECT * FROM order_items WHERE order_id = ?", [order.id]);
    order.items = items;

    // Send status update email (non-blocking)
    sendStatusUpdate(order, order.status, status).catch(() => {});

    res.json(order);
  } catch (err) {
    console.error("Admin order update error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// GET /api/admin/users
router.get("/users", async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT
        LOWER(REPLACE(JSON_UNQUOTE(JSON_EXTRACT(o.shipping_address, '$.email')), '@', '')) AS id,
        TRIM(CONCAT(
          IFNULL(JSON_UNQUOTE(JSON_EXTRACT(o.shipping_address, '$.firstName')), ''),
          ' ',
          IFNULL(JSON_UNQUOTE(JSON_EXTRACT(o.shipping_address, '$.lastName')), '')
        )) AS name,
        JSON_UNQUOTE(JSON_EXTRACT(o.shipping_address, '$.email')) AS email,
        IFNULL(JSON_UNQUOTE(JSON_EXTRACT(o.shipping_address, '$.phone')), '') AS phone,
        MIN(o.created_at) AS created_at,
        COUNT(o.id) AS order_count,
        COALESCE(SUM(o.total), 0) AS total_spent
      FROM orders o
      WHERE JSON_UNQUOTE(JSON_EXTRACT(o.shipping_address, '$.email')) IS NOT NULL
        AND JSON_UNQUOTE(JSON_EXTRACT(o.shipping_address, '$.email')) != 'null'
        AND JSON_UNQUOTE(JSON_EXTRACT(o.shipping_address, '$.email')) != ''
      GROUP BY id, name, email, phone
      ORDER BY order_count DESC
    `);

    const emails = rows.map((r) => r.email).filter(Boolean);
    let adminEmails = new Set();
    if (emails.length > 0) {
      const [admins] = await pool.query(
        `SELECT email FROM users WHERE is_admin = 1 AND email IN (${emails.map(() => "?").join(",")})`,
        emails
      );
      adminEmails = new Set(admins.map((a) => a.email));
    }

    res.json(rows.map((r) => ({
      ...r,
      created_at: r.created_at || new Date().toISOString(),
      total_spent: Number(r.total_spent) || 0,
      order_count: Number(r.order_count) || 0,
      is_admin: adminEmails.has(r.email) ? 1 : 0,
    })));
  } catch (err) {
    console.error("Admin users list error:", err);
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
    const { name, category, price, original_price, delivery_price, image, badge, rating, reviews, description, colors, stock } = req.body;

    if (!name || !category || !price || !image) {
      return res.status(400).json({ error: "Name, category, price, and image are required" });
    }

    const [[{ maxId }]] = await pool.query("SELECT COALESCE(MAX(id), 0) AS maxId FROM products");
    const newId = maxId + 1;

    await pool.query(
      "INSERT INTO products (id, name, category, price, original_price, delivery_price, image, badge, rating, reviews, description, stock) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [newId, name, category, price, original_price || null, delivery_price || 0, image, badge || null, rating || 0, reviews || 0, description || null, stock !== undefined && stock !== null ? stock : null]
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
    const { name, category, price, original_price, delivery_price, image, badge, rating, reviews, description, colors, stock } = req.body;
    const { id } = req.params;

    const [existing] = await pool.query("SELECT id FROM products WHERE id = ?", [id]);
    if (existing.length === 0) return res.status(404).json({ error: "Product not found" });

    await pool.query(
      "UPDATE products SET name = ?, category = ?, price = ?, original_price = ?, delivery_price = ?, image = ?, badge = ?, rating = ?, reviews = ?, description = ?, stock = ? WHERE id = ?",
      [name, category, price, original_price || null, delivery_price || 0, image, badge || null, rating || 0, reviews || 0, description || null, stock !== undefined && stock !== null ? stock : null, id]
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
  const conn = await pool.getConnection();
  try {
    const { id } = req.params;
    const [existing] = await conn.query("SELECT id FROM products WHERE id = ?", [id]);
    if (existing.length === 0) { conn.release(); return res.status(404).json({ error: "Product not found" }); }

    await conn.beginTransaction();
    await conn.query("SET FOREIGN_KEY_CHECKS = 0");
    await conn.query("UPDATE order_items SET product_id = NULL WHERE product_id = ?", [id]);
    await conn.query("SET FOREIGN_KEY_CHECKS = 1");
    await conn.query("DELETE FROM product_colors WHERE product_id = ?", [id]);
    await conn.query("DELETE FROM products WHERE id = ?", [id]);
    await conn.commit();

    res.json({ message: "Product deleted" });
  } catch (err) {
    await conn.rollback();
    console.error("Admin product delete error:", err);
    res.status(500).json({ error: "Server error" });
  } finally {
    conn.release();
  }
});

// ─── Banners CRUD ───────────────────────────────────────────────

// GET /api/admin/banners
router.get("/banners", async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT * FROM banners ORDER BY sort_order ASC, id ASC");
    res.json(rows);
  } catch (err) {
    console.error("Admin banners list error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// POST /api/admin/banners
router.post("/banners", async (req, res) => {
  try {
    const { title, subtitle, badge, button_text, button_link, image, sort_order, is_active } = req.body;
    if (!title || !image) {
      return res.status(400).json({ error: "Title and image are required" });
    }
    const [result] = await pool.query(
      "INSERT INTO banners (title, subtitle, badge, button_text, button_link, image, sort_order, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [title, subtitle || null, badge || null, button_text || null, button_link || "#products", image, sort_order || 0, is_active !== undefined ? (is_active ? 1 : 0) : 1]
    );
    const [rows] = await pool.query("SELECT * FROM banners WHERE id = ?", [result.insertId]);
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error("Admin banner create error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// PUT /api/admin/banners/:id
router.put("/banners/:id", async (req, res) => {
  try {
    const { title, subtitle, badge, button_text, button_link, image, sort_order, is_active } = req.body;
    const { id } = req.params;
    const [existing] = await pool.query("SELECT id FROM banners WHERE id = ?", [id]);
    if (existing.length === 0) return res.status(404).json({ error: "Banner not found" });

    await pool.query(
      "UPDATE banners SET title = ?, subtitle = ?, badge = ?, button_text = ?, button_link = ?, image = ?, sort_order = ?, is_active = ? WHERE id = ?",
      [title, subtitle || null, badge || null, button_text || null, button_link || "#products", image, sort_order || 0, is_active !== undefined ? (is_active ? 1 : 0) : 1, id]
    );
    const [rows] = await pool.query("SELECT * FROM banners WHERE id = ?", [id]);
    res.json(rows[0]);
  } catch (err) {
    console.error("Admin banner update error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// DELETE /api/admin/banners/:id
router.delete("/banners/:id", async (req, res) => {
  try {
    const [existing] = await pool.query("SELECT id FROM banners WHERE id = ?", [req.params.id]);
    if (existing.length === 0) return res.status(404).json({ error: "Banner not found" });
    await pool.query("DELETE FROM banners WHERE id = ?", [req.params.id]);
    res.json({ message: "Banner deleted" });
  } catch (err) {
    console.error("Admin banner delete error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── Categories CRUD ───────────────────────────────────────────

// GET /api/admin/categories
router.get("/categories", async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT * FROM categories ORDER BY sort_order ASC, id ASC");
    res.json(rows);
  } catch (err) {
    console.error("Admin categories list error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// POST /api/admin/categories
router.post("/categories", async (req, res) => {
  try {
    const { name, slug, image, sort_order, is_active } = req.body;
    if (!name || !slug) {
      return res.status(400).json({ error: "Name and slug are required" });
    }
    const [existing] = await pool.query("SELECT id FROM categories WHERE slug = ?", [slug]);
    if (existing.length > 0) {
      return res.status(400).json({ error: "A category with this slug already exists" });
    }
    const [result] = await pool.query(
      "INSERT INTO categories (name, slug, image, sort_order, is_active) VALUES (?, ?, ?, ?, ?)",
      [name, slug, image || null, sort_order || 0, is_active !== undefined ? (is_active ? 1 : 0) : 1]
    );
    const [rows] = await pool.query("SELECT * FROM categories WHERE id = ?", [result.insertId]);
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error("Admin category create error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// PUT /api/admin/categories/:id
router.put("/categories/:id", async (req, res) => {
  try {
    const { name, slug, image, sort_order, is_active } = req.body;
    const { id } = req.params;
    const [existing] = await pool.query("SELECT id FROM categories WHERE id = ?", [id]);
    if (existing.length === 0) return res.status(404).json({ error: "Category not found" });

    if (slug) {
      const [dup] = await pool.query("SELECT id FROM categories WHERE slug = ? AND id != ?", [slug, id]);
      if (dup.length > 0) {
        return res.status(400).json({ error: "A category with this slug already exists" });
      }
    }

    await pool.query(
      "UPDATE categories SET name = ?, slug = ?, image = ?, sort_order = ?, is_active = ? WHERE id = ?",
      [name, slug, image || null, sort_order || 0, is_active !== undefined ? (is_active ? 1 : 0) : 1, id]
    );
    const [rows] = await pool.query("SELECT * FROM categories WHERE id = ?", [id]);
    res.json(rows[0]);
  } catch (err) {
    console.error("Admin category update error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// DELETE /api/admin/categories/:id
router.delete("/categories/:id", async (req, res) => {
  try {
    const [existing] = await pool.query("SELECT id FROM categories WHERE id = ?", [req.params.id]);
    if (existing.length === 0) return res.status(404).json({ error: "Category not found" });
    await pool.query("DELETE FROM categories WHERE id = ?", [req.params.id]);
    res.json({ message: "Category deleted" });
  } catch (err) {
    console.error("Admin category delete error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── Coupons CRUD ──────────────────────────────────────────────

router.get("/coupons", async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT * FROM coupons ORDER BY id DESC");
    res.json(rows);
  } catch (err) {
    console.error("Admin coupons list error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

router.post("/coupons", async (req, res) => {
  try {
    const { code, discount_type, discount_value, min_order, max_uses, expires_at, is_active } = req.body;
    if (!code || !discount_value) return res.status(400).json({ error: "Code and discount value are required" });
    const [dup] = await pool.query("SELECT id FROM coupons WHERE code = ?", [code.toUpperCase()]);
    if (dup.length > 0) return res.status(400).json({ error: "Coupon code already exists" });
    const [result] = await pool.query(
      "INSERT INTO coupons (code, discount_type, discount_value, min_order, max_uses, expires_at, is_active) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [code.toUpperCase(), discount_type || "percentage", discount_value, min_order || 0, max_uses || null, expires_at || null, is_active !== undefined ? (is_active ? 1 : 0) : 1]
    );
    const [rows] = await pool.query("SELECT * FROM coupons WHERE id = ?", [result.insertId]);
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error("Admin coupon create error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

router.put("/coupons/:id", async (req, res) => {
  try {
    const { code, discount_type, discount_value, min_order, max_uses, expires_at, is_active } = req.body;
    const { id } = req.params;
    const [existing] = await pool.query("SELECT id FROM coupons WHERE id = ?", [id]);
    if (existing.length === 0) return res.status(404).json({ error: "Coupon not found" });
    if (code) {
      const [dup] = await pool.query("SELECT id FROM coupons WHERE code = ? AND id != ?", [code.toUpperCase(), id]);
      if (dup.length > 0) return res.status(400).json({ error: "Coupon code already exists" });
    }
    await pool.query(
      "UPDATE coupons SET code = ?, discount_type = ?, discount_value = ?, min_order = ?, max_uses = ?, expires_at = ?, is_active = ? WHERE id = ?",
      [code.toUpperCase(), discount_type, discount_value, min_order || 0, max_uses || null, expires_at || null, is_active !== undefined ? (is_active ? 1 : 0) : 1, id]
    );
    const [rows] = await pool.query("SELECT * FROM coupons WHERE id = ?", [id]);
    res.json(rows[0]);
  } catch (err) {
    console.error("Admin coupon update error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

router.delete("/coupons/:id", async (req, res) => {
  try {
    const [existing] = await pool.query("SELECT id FROM coupons WHERE id = ?", [req.params.id]);
    if (existing.length === 0) return res.status(404).json({ error: "Coupon not found" });
    await pool.query("DELETE FROM coupons WHERE id = ?", [req.params.id]);
    res.json({ message: "Coupon deleted" });
  } catch (err) {
    console.error("Admin coupon delete error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── Reviews moderation ────────────────────────────────────────

router.get("/reviews", async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT r.*, p.name AS product_name
      FROM reviews r
      LEFT JOIN products p ON r.product_id = p.id
      ORDER BY r.created_at DESC
    `);
    res.json(rows);
  } catch (err) {
    console.error("Admin reviews list error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

router.patch("/reviews/:id/approve", async (req, res) => {
  try {
    const [result] = await pool.query("UPDATE reviews SET is_approved = 1 WHERE id = ?", [req.params.id]);
    if (result.affectedRows === 0) return res.status(404).json({ error: "Review not found" });
    res.json({ message: "Review approved" });
  } catch (err) {
    console.error("Admin review approve error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

router.patch("/reviews/:id/reject", async (req, res) => {
  try {
    const [result] = await pool.query("UPDATE reviews SET is_approved = 0 WHERE id = ?", [req.params.id]);
    if (result.affectedRows === 0) return res.status(404).json({ error: "Review not found" });
    res.json({ message: "Review rejected" });
  } catch (err) {
    console.error("Admin review reject error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

router.delete("/reviews/:id", async (req, res) => {
  try {
    const [existing] = await pool.query("SELECT id FROM reviews WHERE id = ?", [req.params.id]);
    if (existing.length === 0) return res.status(404).json({ error: "Review not found" });
    await pool.query("DELETE FROM reviews WHERE id = ?", [req.params.id]);
    res.json({ message: "Review deleted" });
  } catch (err) {
    console.error("Admin review delete error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── Stock management ──────────────────────────────────────────

router.get("/stock", async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT id, name, stock FROM products ORDER BY id ASC");
    res.json(rows);
  } catch (err) {
    console.error("Admin stock list error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

router.put("/stock/:id", async (req, res) => {
  try {
    const { stock } = req.body;
    const [existing] = await pool.query("SELECT id FROM products WHERE id = ?", [req.params.id]);
    if (existing.length === 0) return res.status(404).json({ error: "Product not found" });
    await pool.query("UPDATE products SET stock = ? WHERE id = ?", [stock, req.params.id]);
    res.json({ message: "Stock updated", stock });
  } catch (err) {
    console.error("Admin stock update error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── Pages (About/Contact) ─────────────────────────────────────

router.get("/pages", async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT * FROM pages ORDER BY id ASC");
    const pages = rows.map((p) => {
      let content = {};
      try { content = JSON.parse(p.content || "{}"); } catch {}
      return { id: p.id, slug: p.slug, content };
    });
    res.json(pages);
  } catch (err) {
    console.error("Admin pages list error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

router.put("/pages/:slug", async (req, res) => {
  try {
    const { content } = req.body;
    const { slug } = req.params;
    const contentStr = typeof content === "string" ? content : JSON.stringify(content || {});
    const [existing] = await pool.query("SELECT id FROM pages WHERE slug = ?", [slug]);
    if (existing.length === 0) {
      await pool.query("INSERT INTO pages (slug, content) VALUES (?, ?)", [slug, contentStr]);
      const [rows] = await pool.query("SELECT * FROM pages WHERE slug = ?", [slug]);
      return res.status(201).json({ id: rows[0].id, slug: rows[0].slug, content: JSON.parse(rows[0].content || "{}") });
    }
    await pool.query("UPDATE pages SET content = ? WHERE slug = ?", [contentStr, slug]);
    const [rows] = await pool.query("SELECT * FROM pages WHERE slug = ?", [slug]);
    res.json({ id: rows[0].id, slug: rows[0].slug, content: JSON.parse(rows[0].content || "{}") });
  } catch (err) {
    console.error("Admin page update error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
