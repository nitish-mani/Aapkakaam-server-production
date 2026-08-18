/**
 * Centralised, validated environment configuration.
 *
 * - Fails fast at boot if any required variable is missing.
 * - Freezes the exported object so runtime code cannot mutate config.
 * - Never falls back to insecure defaults for secrets in production.
 */
require("dotenv").config();

const NODE_ENV = process.env.NODE_ENV || "development";
const isProd = NODE_ENV === "production";

const requiredEnv = ["PORT", "JWT_SECRET", "MONGODB_URL_1"];

// In production, additionally require secure/operational variables.
if (isProd) {
  requiredEnv.push(
    "ALLOWED_ORIGINS",
    "JWT_USER_SECRET",
    "JWT_VENDOR_SECRET",
    "JWT_ADMIN_SECRET",
    "JWT_EMPLOYEE_SECRET",
  );
}

for (const key of requiredEnv) {
  if (!process.env[key] || String(process.env[key]).trim() === "") {
    // eslint-disable-next-line no-console
    console.error(`[env] Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

const parseNumber = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const parseList = (value) =>
  String(value || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);

const ENV = Object.freeze({
  NODE_ENV,
  IS_PROD: isProd,

  PORT: parseNumber(process.env.PORT, 3000),

  // Comma separated list of origins allowed by CORS.
  ALLOWED_ORIGINS: parseList(process.env.ALLOWED_ORIGINS),

  // Trust N proxies in front (0 = disabled). Set to 1 behind ELB/nginx.
  TRUST_PROXY: parseNumber(process.env.TRUST_PROXY, 0),

  LOG_LEVEL: process.env.LOG_LEVEL || (isProd ? "info" : "debug"),

  // ---- Auth secrets ----
  // Per-audience secrets fall back to JWT_SECRET so legacy tokens keep working
  // in dev. In production all four are required (see requiredEnv above).
  JWT_SECRET: process.env.JWT_SECRET,
  JWT_USER_SECRET: process.env.JWT_USER_SECRET || process.env.JWT_SECRET,
  JWT_VENDOR_SECRET: process.env.JWT_VENDOR_SECRET || process.env.JWT_SECRET,
  JWT_ADMIN_SECRET: process.env.JWT_ADMIN_SECRET || process.env.JWT_SECRET,
  JWT_EMPLOYEE_SECRET: process.env.JWT_EMPLOYEE_SECRET || process.env.JWT_SECRET,
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || "72h",
  BCRYPT_ROUNDS: parseNumber(process.env.BCRYPT_ROUNDS, 12),

  // ---- Mongo ----
  MONGO_URI: process.env.MONGODB_URL_1,
  MONGO_MAX_POOL_SIZE: parseNumber(process.env.MONGO_MAX_POOL_SIZE, 50),
  MONGO_MIN_POOL_SIZE: parseNumber(process.env.MONGO_MIN_POOL_SIZE, 5),
  MONGO_CONNECT_TIMEOUT_MS: parseNumber(process.env.MONGO_CONNECT_TIMEOUT_MS, 30000),
  MONGO_SOCKET_TIMEOUT_MS: parseNumber(process.env.MONGO_SOCKET_TIMEOUT_MS, 45000),
  MONGO_SERVER_SELECTION_TIMEOUT_MS: parseNumber(
    process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS,
    5000,
  ),

  // ---- Rate limiting ----
  RATE_LIMIT_WINDOW_MS: parseNumber(process.env.RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000),
  RATE_LIMIT_MAX: parseNumber(process.env.RATE_LIMIT_MAX, 300),
  AUTH_RATE_LIMIT_MAX: parseNumber(process.env.AUTH_RATE_LIMIT_MAX, 10),

  // ---- AWS ----
  AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
  AWS_REGION: process.env.AWS_REGION,
  S3_BUCKET: process.env.S3_BUCKET,

  // ---- Firebase ----
  // Provide either GOOGLE_APPLICATION_CREDENTIALS (path) or
  // FIREBASE_SERVICE_ACCOUNT_JSON (base64-encoded service account JSON).
  FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID,
  FIREBASE_SERVICE_ACCOUNT_JSON: process.env.FIREBASE_SERVICE_ACCOUNT_JSON,
  GOOGLE_APPLICATION_CREDENTIALS: process.env.GOOGLE_APPLICATION_CREDENTIALS,

  // ---- Razorpay ----
  RAZORPAY_KEY_ID: process.env.RAZORPAY_KEY_ID,
  RAZORPAY_SECRET: process.env.RAZORPAY_SECRET || process.env.RAZORPAY_KEY_SECRET,
  RAZORPAY_WEBHOOK_SECRET: process.env.RAZORPAY_WEBHOOK_SECRET,
  MERCHANT_ACCOUNT_ID: process.env.MERCHANT_ACCOUNT_ID,

  FRONTEND_URL: process.env.FRONTEND_URL,

  // ---- Fast2SMS ----
  FAST2SMS: process.env.FAST2SMS,
  FAST2SMSBOOKING: process.env.FAST2SMSBOOKING,
  FAST2SMSCANCEL: process.env.FAST2SMSCANCEL,
  FAST2SMSPAYMENTSUCCESS: process.env.FAST2SMSPAYMENTSUCCESS,
  FAST2SMSPAYMENTFAILED: process.env.FAST2SMSPAYMENTFAILED,

  RUN_RECONCILIATION_JOB: process.env.RUN_RECONCILIATION_JOB,

  ADMIN_EMAIL: process.env.ADMIN_EMAIL,
  ADMIN_PHONENO: process.env.ADMIN_PHONENO,
});

module.exports = ENV;
