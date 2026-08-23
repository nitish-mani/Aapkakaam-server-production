const rateLimit = require("express-rate-limit");
const ENV = require("../config/env");

/**
 * ============================================================
 * GLOBAL API RATE LIMITER
 * ============================================================
 *
 * Protects the entire API from excessive traffic.
 *
 * Production:
 *   Always enabled.
 *
 * Local load testing:
 *   Can be bypassed ONLY when:
 *
 *   NODE_ENV=development
 *   ALLOW_LOAD_TEST=1
 *
 * IMPORTANT:
 * Never enable ALLOW_LOAD_TEST=1 in production.
 */

const globalLimiter = rateLimit({
  windowMs: ENV.RATE_LIMIT_WINDOW_MS,
  max: ENV.RATE_LIMIT_MAX,

  standardHeaders: true,
  legacyHeaders: false,

  message: {
    success: false,
    message: "Too many requests. Please try again later.",
  },
});

/**
 * ============================================================
 * GLOBAL LIMITER WRAPPER
 * ============================================================
 *
 * During local k6 load testing, bypass only the GLOBAL
 * request limiter.
 *
 * Authentication and authorization middleware remain active.
 */
const globalLimiterMiddleware = (req, res, next) => {
  const isDevelopment = process.env.NODE_ENV === "development";
  const loadTestEnabled = process.env.ALLOW_LOAD_TEST === "1";

  if (isDevelopment && loadTestEnabled) {
    return next();
  }

  return globalLimiter(req, res, next);
};

/**
 * ============================================================
 * AUTHENTICATION RATE LIMITER
 * ============================================================
 *
 * Protects:
 *
 * - login
 * - signup
 * - OTP
 * - password reset
 * - other authentication endpoints
 *
 * This limiter is intentionally NOT bypassed by the load-test
 * flag.
 *
 * This means your real authentication protection remains active.
 */
const realAuthRateLimiter = rateLimit({
  windowMs: ENV.RATE_LIMIT_WINDOW_MS,
  max: ENV.AUTH_RATE_LIMIT_MAX,

  standardHeaders: true,
  legacyHeaders: false,

  message: {
    success: false,
    message: "Too many auth attempts. Please try again later.",
  },
});

/**
 * Authentication rate limiter.
 *
 * Keep authentication protection active even during load tests.
 */
const authRateLimiter = (req, res, next) => {
  return realAuthRateLimiter(req, res, next);
};

/**
 * ============================================================
 * EXPORTS
 * ============================================================
 *
 * Existing imports continue to work:
 *
 * const rateLimiter = require("./rateLimiter");
 *
 * const {
 *   globalLimiter,
 *   authRateLimiter
 * } = require("./rateLimiter");
 */

module.exports = globalLimiterMiddleware;

module.exports.globalLimiter = globalLimiterMiddleware;
module.exports.realGlobalLimiter = globalLimiter;

module.exports.authRateLimiter = authRateLimiter;
module.exports.realAuthRateLimiter = realAuthRateLimiter;
