require("dotenv").config();
const bcrypt = require("bcryptjs");
const { pool, initDB } = require("./models/db");
const products = require("./data/products.json");

async function seed() {
  try {
    await initDB();
    console.log("Tables ready. Seeding...");

    // Seed admin user
    const adminEmail = "zaamianas2005@gmail.com";
    const [existing] = await pool.query("SELECT id FROM users WHERE email = ?", [adminEmail]);
    if (existing.length === 0) {
      const adminPassword = await bcrypt.hash('G,RY+6s8}fHDt"L', 10);
      const adminId = "admin-" + Date.now();
      await pool.query(
        "INSERT INTO users (id, name, email, password, is_admin) VALUES (?, ?, ?, ?, ?)",
        [adminId, "Admin", adminEmail, adminPassword, 1]
      );
      console.log("Admin user seeded:", adminEmail);
    } else {
      console.log("Admin user already exists, skipping");
    }

    // Seed products
    const [existingProducts] = await pool.query("SELECT COUNT(*) AS count FROM products");
    if (existingProducts[0].count === 0) {
      for (const p of products) {
        await pool.query(
          "INSERT INTO products (id, name, category, price, original_price, image, badge, rating, reviews, description) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [p.id, p.name, p.category, p.price, p.originalPrice || null, p.image, p.badge || null, p.rating, p.reviews, p.description || null]
        );
        if (p.colors && p.colors.length > 0) {
          for (const color of p.colors) {
            await pool.query("INSERT INTO product_colors (product_id, color_hex) VALUES (?, ?)", [p.id, color]);
          }
        }
      }
      console.log(`Seeded ${products.length} products with colors`);
    } else {
      console.log("Products already exist, skipping");
    }
  } catch (err) {
    console.error("Seed failed:", err);
  } finally {
    await pool.end();
  }
}

seed();
