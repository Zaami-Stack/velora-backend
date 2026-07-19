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
        is_admin TINYINT(1) NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Migration: add columns to existing tables
    try { await conn.query("ALTER TABLE users ADD COLUMN is_admin TINYINT(1) NOT NULL DEFAULT 0"); } catch (e) {}
    try { await conn.query("ALTER TABLE users ADD COLUMN secret_hash VARCHAR(255) NULL"); } catch (e) {}
    try { await conn.query("ALTER TABLE users MODIFY COLUMN id VARCHAR(36) NOT NULL"); } catch (e) {}
    try { await conn.query("ALTER TABLE users ADD COLUMN phone VARCHAR(30) NULL"); } catch (e) {}
    try { await conn.query("ALTER TABLE orders MODIFY COLUMN user_id VARCHAR(36) NOT NULL"); } catch (e) {}

    // Drop old password_resets table if it exists
    try { await conn.query("DROP TABLE IF EXISTS password_resets"); } catch (e) {}

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
        user_id VARCHAR(36) NOT NULL,
        subtotal DECIMAL(10,2) NOT NULL,
        shipping DECIMAL(10,2) NOT NULL,
        total DECIMAL(10,2) NOT NULL,
        shipping_address JSON NULL,
        status VARCHAR(30) NOT NULL DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
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
        FOREIGN KEY (product_id) REFERENCES products(id)
      )
    `);

    console.log("Database tables initialized");
  } finally {
    conn.release();
  }
}

module.exports = { pool, initDB };
