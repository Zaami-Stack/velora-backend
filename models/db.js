const mysql = require("mysql2/promise");

const dbConfig = {
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || "3306"),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 5,
  queueLimit: 0,
  connectTimeout: 10000,
};

if (process.env.DB_SSL === "true") {
  dbConfig.ssl = {
    rejectUnauthorized: false,
  };
}

const pool = mysql.createPool(dbConfig);

async function initDB() {
  const conn = await pool.getConnection();
  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS users (
        id VARCHAR(36) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) NOT NULL UNIQUE,
        password VARCHAR(255) NOT NULL,
        secret_hash VARCHAR(255) NULL,
        security_question VARCHAR(255) NULL,
        security_answer_hash VARCHAR(255) NULL,
        is_admin TINYINT(1) NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Migration: add columns to existing tables
    try { await conn.query("ALTER TABLE users ADD COLUMN is_admin TINYINT(1) NOT NULL DEFAULT 0"); } catch (e) {}
    try { await conn.query("ALTER TABLE users ADD COLUMN secret_hash VARCHAR(255) NULL"); } catch (e) {}
    try { await conn.query("ALTER TABLE users MODIFY COLUMN id VARCHAR(36) NOT NULL"); } catch (e) {}
    try { await conn.query("ALTER TABLE users ADD COLUMN phone VARCHAR(30) NULL"); } catch (e) {}
    try { await conn.query("ALTER TABLE users ADD COLUMN secret_hash VARCHAR(255) NULL"); } catch (e) {}
    try { await conn.query("ALTER TABLE users ADD COLUMN security_question VARCHAR(255) NULL"); } catch (e) {}
    try { await conn.query("ALTER TABLE users ADD COLUMN security_answer_hash VARCHAR(255) NULL"); } catch (e) {}
    try { await conn.query("ALTER TABLE orders MODIFY COLUMN user_id VARCHAR(36) NULL"); } catch (e) {}

    // Drop old password_resets table if it exists
    try { await conn.query("DROP TABLE IF EXISTS password_resets"); } catch (e) {}

    // Migration: add image column to product_colors
    try { await conn.query("ALTER TABLE product_colors ADD COLUMN image TEXT NULL"); } catch (e) {}

    // Migration: fix order_items FK to allow product deletion
    try { await conn.query("ALTER TABLE order_items MODIFY COLUMN product_id INT NULL"); } catch (e) {}
    try { await conn.query("ALTER TABLE order_items DROP FOREIGN KEY order_items_ibfk_2"); } catch (e) {}
    try { await conn.query("ALTER TABLE order_items ADD FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL"); } catch (e) {}

    // Migration: add delivery_price to products
    try { await conn.query("ALTER TABLE products ADD COLUMN delivery_price DECIMAL(10,2) NULL DEFAULT 0"); } catch (e) {}

    // Migration: add stock column to products
    try { await conn.query("ALTER TABLE products ADD COLUMN stock INT NULL DEFAULT NULL"); } catch (e) {}

    // Migration: add coupon_id and discount to orders
    try { await conn.query("ALTER TABLE orders ADD COLUMN coupon_id INT NULL"); } catch (e) {}
    try { await conn.query("ALTER TABLE orders ADD COLUMN discount DECIMAL(10,2) NULL DEFAULT 0"); } catch (e) {}

    // Migration: add size and color to order_items
    try { await conn.query("ALTER TABLE order_items ADD COLUMN size VARCHAR(20) NULL"); } catch (e) {}
    try { await conn.query("ALTER TABLE order_items ADD COLUMN color VARCHAR(20) NULL"); } catch (e) {}

    // Banners table for homepage carousel
    await conn.query(`
      CREATE TABLE IF NOT EXISTS banners (
        id INT AUTO_INCREMENT PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        subtitle TEXT NULL,
        badge VARCHAR(100) NULL,
        button_text VARCHAR(100) NULL,
        button_link VARCHAR(500) NULL,
        image TEXT NOT NULL,
        sort_order INT NOT NULL DEFAULT 0,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Categories table for homepage "Shop by Category" section
    await conn.query(`
      CREATE TABLE IF NOT EXISTS categories (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        slug VARCHAR(100) NOT NULL UNIQUE,
        image TEXT NULL,
        sort_order INT NOT NULL DEFAULT 0,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Coupons table for discount codes
    await conn.query(`
      CREATE TABLE IF NOT EXISTS coupons (
        id INT AUTO_INCREMENT PRIMARY KEY,
        code VARCHAR(50) NOT NULL UNIQUE,
        discount_type ENUM('percentage', 'fixed') NOT NULL DEFAULT 'percentage',
        discount_value DECIMAL(10,2) NOT NULL,
        min_order DECIMAL(10,2) NULL DEFAULT 0,
        max_uses INT NULL DEFAULT NULL,
        times_used INT NOT NULL DEFAULT 0,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        expires_at TIMESTAMP NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Reviews table for product reviews
    await conn.query(`
      CREATE TABLE IF NOT EXISTS reviews (
        id INT AUTO_INCREMENT PRIMARY KEY,
        product_id INT NOT NULL,
        order_id VARCHAR(50) NULL,
        customer_name VARCHAR(255) NOT NULL,
        customer_email VARCHAR(255) NULL,
        rating TINYINT NOT NULL,
        title VARCHAR(255) NULL,
        comment TEXT NULL,
        is_approved TINYINT(1) NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
      )
    `);

    // Pages table for About/Contact content
    await conn.query(`
      CREATE TABLE IF NOT EXISTS pages (
        id INT AUTO_INCREMENT PRIMARY KEY,
        slug VARCHAR(50) NOT NULL UNIQUE,
        content LONGTEXT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    // Seed default pages
    const [[aboutExists]] = await conn.query("SELECT id FROM pages WHERE slug = 'about'");
    if (!aboutExists) {
      await conn.query("INSERT INTO pages (slug, content) VALUES (?, ?)", [
        "about",
        JSON.stringify({
          title: "About Velora",
          subtitle: "Luxury Fashion, Redefined",
          story: "Velora was founded with a singular vision: to bring timeless elegance to the modern wardrobe. Every piece in our collection is curated for those who appreciate understated luxury and effortless sophistication.",
          mission: "We believe fashion should be both beautiful and responsible. Our commitment to quality means each garment is crafted to last, using premium materials and meticulous attention to detail.",
          values: ["Timeless Design", "Premium Quality", "Sustainable Practices", "Customer First"]
        })
      ]);
    }
    const [[contactExists]] = await conn.query("SELECT id FROM pages WHERE slug = 'contact'");
    if (!contactExists) {
      await conn.query("INSERT INTO pages (slug, content) VALUES (?, ?)", [
        "contact",
        JSON.stringify({
          title: "Contact Us",
          email: "support@velora.ma",
          phone: "+212 600 000 000",
          address: "Casablanca, Morocco",
          hours: "Mon-Sat: 9:00 AM - 7:00 PM",
          social: { instagram: "#", facebook: "#", tiktok: "#" }
        })
      ]);
    }

    await conn.query(`
      CREATE TABLE IF NOT EXISTS products (
        id INT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        category VARCHAR(100) NOT NULL,
        price DECIMAL(10,2) NOT NULL,
        original_price DECIMAL(10,2) NULL,
        image TEXT NOT NULL,
        badge VARCHAR(20) NULL,
        rating DECIMAL(2,1) NOT NULL DEFAULT 0,
        reviews INT NOT NULL DEFAULT 0,
        description TEXT NULL
      )
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS product_colors (
        id INT AUTO_INCREMENT PRIMARY KEY,
        product_id INT NOT NULL,
        color_hex VARCHAR(7) NOT NULL,
        FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
      )
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id VARCHAR(50) PRIMARY KEY,
        user_id VARCHAR(36) NULL,
        subtotal DECIMAL(10,2) NOT NULL,
        shipping DECIMAL(10,2) NOT NULL,
        total DECIMAL(10,2) NOT NULL,
        shipping_address JSON NULL,
        status VARCHAR(30) NOT NULL DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
      )
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS order_items (
        id INT AUTO_INCREMENT PRIMARY KEY,
        order_id VARCHAR(50) NOT NULL,
        product_id INT NOT NULL,
        name VARCHAR(255) NOT NULL,
        image TEXT NOT NULL,
        price DECIMAL(10,2) NOT NULL,
        quantity INT NOT NULL,
        FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
        FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL
      )
    `);

    console.log("Database tables initialized");
  } finally {
    conn.release();
  }
}

module.exports = { pool, initDB };
