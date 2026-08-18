/**
 * Shared test bootstrap: sets required env vars BEFORE any app module is
 * required (env.js fails fast if PORT/JWT_SECRET/MONGODB_URL_1 are missing).
 */
process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.PORT = process.env.PORT || "0"; // ephemeral
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-1234567890";
process.env.JWT_USER_SECRET = process.env.JWT_USER_SECRET || process.env.JWT_SECRET;
process.env.JWT_VENDOR_SECRET = process.env.JWT_VENDOR_SECRET || process.env.JWT_SECRET;
process.env.JWT_ADMIN_SECRET = process.env.JWT_ADMIN_SECRET || process.env.JWT_SECRET;
process.env.JWT_EMPLOYEE_SECRET = process.env.JWT_EMPLOYEE_SECRET || process.env.JWT_SECRET;
process.env.MONGODB_URL_1 =
  process.env.MONGODB_URL_1 || "mongodb://127.0.0.1:27017/aapkakaam_test_placeholder";
process.env.ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || "";
// Tune limiters so we can exercise them without waiting 15 minutes.
process.env.RATE_LIMIT_WINDOW_MS = process.env.RATE_LIMIT_WINDOW_MS || "5000";
process.env.RATE_LIMIT_MAX = process.env.RATE_LIMIT_MAX || "1000";
process.env.AUTH_RATE_LIMIT_MAX = process.env.AUTH_RATE_LIMIT_MAX || "3";
