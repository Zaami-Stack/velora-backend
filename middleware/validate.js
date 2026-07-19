const { body, query, param, validationResult } = require("express-validator");

// Process validation results
function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const msg = errors.array().map((e) => e.msg).join(". ");
    return res.status(400).json({ error: msg });
  }
  next();
}

// Auth validators
const registerRules = [
  body("name")
    .trim()
    .notEmpty().withMessage("Name is required")
    .isLength({ min: 2, max: 100 }).withMessage("Name must be 2-100 characters")
    .matches(/^[a-zA-Z\s'-]+$/).withMessage("Name contains invalid characters"),
  body("email")
    .trim()
    .notEmpty().withMessage("Email is required")
    .isEmail().withMessage("Invalid email format")
    .normalizeEmail()
    .isLength({ max: 255 }).withMessage("Email is too long"),
  body("password")
    .notEmpty().withMessage("Password is required")
    .isLength({ min: 6, max: 128 }).withMessage("Password must be 6-128 characters"),
  validate,
];

const loginRules = [
  body("email")
    .trim()
    .notEmpty().withMessage("Email is required")
    .isEmail().withMessage("Invalid email format")
    .normalizeEmail(),
  body("password")
    .notEmpty().withMessage("Password is required"),
  validate,
];

// Product query validators
const productListRules = [
  query("category").optional().isString().isLength({ max: 50 }),
  query("search").optional().isString().isLength({ max: 100 }),
  query("sort").optional().isIn(["price_asc", "price_desc", "rating", "newest", ""]),
  query("minPrice").optional().isFloat({ min: 0 }),
  query("maxPrice").optional().isFloat({ min: 0 }),
  query("badge").optional().isString().isIn(["New", "Sale"]),
  validate,
];

const productIdRules = [
  param("id").isInt({ min: 1 }).withMessage("Invalid product ID"),
  validate,
];

// Order validators
const createOrderRules = [
  body("items")
    .isArray({ min: 1 }).withMessage("Order must contain at least one item"),
  body("items.*.productId")
    .isInt({ min: 1 }).withMessage("Invalid product ID"),
  body("items.*.quantity")
    .isInt({ min: 1, max: 99 }).withMessage("Quantity must be 1-99"),
  body("shippingAddress")
    .optional()
    .isObject(),
  body("shippingAddress.name")
    .optional().trim().isLength({ min: 1, max: 100 }),
  body("shippingAddress.address")
    .optional().trim().isLength({ min: 1, max: 255 }),
  body("shippingAddress.city")
    .optional().trim().isLength({ min: 1, max: 100 }),
  body("shippingAddress.zip")
    .optional().trim().isLength({ min: 1, max: 20 }),
  body("shippingAddress.phone")
    .optional().trim().isLength({ min: 1, max: 30 }),
  validate,
];

// Admin order status validator
const updateOrderStatusRules = [
  param("id").notEmpty().withMessage("Order ID is required"),
  body("status")
    .isIn(["pending", "processing", "shipped", "delivered", "cancelled"])
    .withMessage("Invalid status"),
  validate,
];

// Admin order list
const adminOrderListRules = [
  query("status")
    .optional()
    .isIn(["pending", "processing", "shipped", "delivered", "cancelled", "all"]),
  validate,
];

module.exports = {
  validate,
  registerRules,
  loginRules,
  productListRules,
  productIdRules,
  createOrderRules,
  updateOrderStatusRules,
  adminOrderListRules,
};
