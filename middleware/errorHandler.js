// Global error handler middleware
function errorHandler(err, req, res, _next) {
  console.error(`[ERROR] ${req.method} ${req.originalUrl}:`, err.message);

  // Don't leak stack traces in production
  const isDev = process.env.NODE_ENV !== "production";

  if (err.type === "entity.parse.failed") {
    return res.status(400).json({ error: "Invalid JSON in request body" });
  }

  if (err.type === "entity.too.large") {
    return res.status(413).json({ error: "Request body too large" });
  }

  if (err.code === "LIMIT_UNEXPECTED_FILE") {
    return res.status(400).json({ error: "Unexpected field in request" });
  }

  // MySQL errors
  if (err.code === "ER_DUP_ENTRY") {
    return res.status(409).json({ error: "Duplicate entry" });
  }

  if (err.code === "ER_NO_SUCH_TABLE") {
    return res.status(500).json({ error: "Database table not found" });
  }

  if (err.code === "ECONNREFUSED" || err.code === "PROTOCOL_CONNECTION_LOST") {
    return res.status(503).json({ error: "Database connection error" });
  }

  // Default
  res.status(500).json({
    error: "Internal server error",
    ...(isDev && { details: err.message, stack: err.stack }),
  });
}

// 404 handler
function notFound(req, res) {
  res.status(404).json({ error: "Route not found" });
}

module.exports = { errorHandler, notFound };
