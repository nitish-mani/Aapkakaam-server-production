const rateLimit = require("express-rate-limit");
const ENV = require("../config/env");

/**
 * Global request rate limiter.
 *
 * Always enabled, including lifecycle tests.
 * This protects the entire API from bulk request abuse.
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
 * Real authentication rate limiter.
 *
 * Protects:
 * - login
 * - signup
 * - OTP
 * - other authentication endpoints
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
 * Authentication rate limiter wrapper.
 *
 * During the explicitly enabled booking lifecycle E2E test,
 * authentication itself remains fully enabled:
 *
 *   signup -> real controller
 *   login  -> real controller
 *   JWT    -> real middleware
 *
 * Only the auth request-count limiter is bypassed so that the
 * test can create/login many temporary accounts without getting
 * HTTP 429.
 *
 * IMPORTANT:
 * Both conditions are required to bypass:
 *
 *   NODE_ENV=development
 *   ALLOW_LIFECYCLE_TEST=1
 *
 * Therefore normal development and production continue to use
 * the real authentication rate limiter.
 */
const authRateLimiter = (req, res, next) => {
  // const isDevelopment = process.env.NODE_ENV === "development";

  // const lifecycleTestEnabled = isDevelopment && process.env.ALLOW_LIFECYCLE_TEST === "1";

  // const authorizationTestEnabled = isDevelopment && process.env.ALLOW_AUTHORIZATION_TEST === "1";

  // const e2eAuthLimiterBypass = lifecycleTestEnabled || authorizationTestEnabled;

  // if (e2eAuthLimiterBypass) {
  //   return next();
  // }

  return realAuthRateLimiter(req, res, next);
};

/*
 * Preserve the existing export structure.
 *
 * Existing imports continue working:
 *
 * const globalLimiter = require("./rateLimiter");
 *
 * const {
 *   globalLimiter,
 *   authRateLimiter
 * } = require("./rateLimiter");
 */
module.exports = globalLimiter;
module.exports.globalLimiter = globalLimiter;
module.exports.authRateLimiter = authRateLimiter;
