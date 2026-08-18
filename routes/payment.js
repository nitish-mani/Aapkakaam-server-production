const express = require("express");
const {
  create_order,
  payment_verification,
  webhook_handler,
  trackAbandonedPayment,
  trackPaymentFailure,
  getTransactionHistory,
  getTransactionStats,
} = require("../controller/payment");
const { authRateLimiter } = require("../src/middleware/rateLimiter");
const { validatePaymentRequest } = require("../middleware/validation");
const authenticate = require("../middleware/authenticate");
const router = express.Router();

// ============ RAZORPAY WEBHOOK ============
// Webhook endpoint - No auth required (Razorpay calls this)
router.post("/webhook", webhook_handler);

// ============ USER ROUTES ============
// Payment endpoints for users
router.post("/create-order", authRateLimiter, authenticate, validatePaymentRequest, create_order);
router.post("/verify-payment", authRateLimiter, authenticate, payment_verification);

// Track payment scenarios for users
router.post("/abandoned-payment", authRateLimiter, authenticate, trackAbandonedPayment);
router.post("/payment-failed", authRateLimiter, authenticate, trackPaymentFailure);

// Transaction history and stats for users
router.get("/transactions", authRateLimiter, authenticate, getTransactionHistory);
router.get("/transactions/stats", authRateLimiter, authenticate, getTransactionStats);

module.exports = router;
