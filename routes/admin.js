const express = require("express");

const router = express.Router();

const is_admin = require("../middleware/is_admin");

const admin_auth = require("../auth/admin_auth");
const admin_controller = require("../controller/admin");
const concernController = require("../controller/concern");
const { authRateLimiter } = require("../src/middleware/rateLimiter");

// Import validators from express-validator - ADD BODY HERE
const { body, param, query } = require("express-validator");

// --- Auth & OTP endpoints (strict rate limit) ------------------------
router.post(
  "/phoneVerification",
  authRateLimiter,
  admin_controller.admin_controller_verify_phoneNo,
);
router.post(
  "/phoneVerificationPasswordReset",
  authRateLimiter,
  admin_controller.admin_controller_verify_phoneNo_reset_password,
);
router.post("/otpVerification", authRateLimiter, admin_controller.admin_controller_otp);

router.post(
  "/otpVerificationResetPassword",
  authRateLimiter,
  admin_controller.admin_controller_otp_reset_password,
);

router.post("/signup", authRateLimiter, admin_auth.signup);
router.post("/login", authRateLimiter, admin_auth.login);

router.patch("/edit/password", authRateLimiter, admin_controller.admin_controller_patch_password);

/**
 * Admin Analytics Routes
 * Complete analytics API routes with validation
 * Enhanced with vendor analytics endpoints
 */
const adminAnalyticsController = require("../controller/analytics");

// ============================================
// MAIN DASHBOARD ROUTES
// ============================================

/**
 * GET /api/admin/dashboard
 * Main analytics dashboard
 */
router.get(
  "/dashboard",
  is_admin,
  [query("refresh").optional().isBoolean().withMessage("refresh must be a boolean").toBoolean()],
  (req, res, next) => {
    if (req.query.refresh) {
      return adminAnalyticsController.refresh_dashboard(req, res, next);
    }
    return adminAnalyticsController.get_dashboard(req, res, next);
  },
);

/**
 * POST /api/admin/dashboard/refresh
 * Force refresh cache
 */
router.post("/dashboard/refresh", is_admin, adminAnalyticsController.refresh_dashboard);

/**
 * DELETE /api/admin/dashboard/cache
 * Clear cache
 */
router.delete("/dashboard/cache", is_admin, adminAnalyticsController.clear_dashboard_cache);

// ============================================
// USER ANALYTICS ROUTES
// ============================================

/**
 * GET /api/admin/analytics/users
 * User analytics
 */
router.get(
  "/analytics/users",
  is_admin,
  [
    query("period")
      .optional()
      .isIn(["day", "week", "month", "year"])
      .withMessage("period must be day, week, month, or year")
      .default("month"),
    query("from").optional().isISO8601().withMessage("from must be a valid ISO date"),
    query("to").optional().isISO8601().withMessage("to must be a valid ISO date"),
    query("status")
      .optional()
      .isIn(["all", "active", "blocked"])
      .withMessage("status must be all, active, or blocked")
      .default("all"),
  ],
  adminAnalyticsController.getUserAnalytics,
);

/**
 * GET /api/admin/analytics/users/:userId
 * Detailed analytics for a specific user
 */
router.get(
  "/analytics/users/:userId",
  is_admin,
  [
    param("userId").isMongoId().withMessage("userId must be a valid MongoDB ID"),
    query("from").optional().isISO8601().withMessage("from must be a valid ISO date"),
    query("to").optional().isISO8601().withMessage("to must be a valid ISO date"),
  ],
  adminAnalyticsController.getUserDetailAnalytics,
);

// ============================================
// VENDOR ANALYTICS ROUTES
// ============================================

/**
 * GET /api/admin/analytics/vendors
 * Vendor analytics - list all vendors with analytics
 */
router.get(
  "/analytics/vendors",
  is_admin,
  [
    query("period")
      .optional()
      .isIn(["day", "week", "month", "year"])
      .withMessage("period must be day, week, month, or year")
      .default("month"),
    query("from").optional().isISO8601().withMessage("from must be a valid ISO date"),
    query("to").optional().isISO8601().withMessage("to must be a valid ISO date"),
    query("status")
      .optional()
      .isIn(["all", "active", "blocked"])
      .withMessage("status must be all, active, or blocked")
      .default("all"),
    query("sortBy")
      .optional()
      .isIn(["rating", "earnings", "bookings", "commission", "balance", "createdAt"])
      .withMessage("sortBy must be rating, earnings, bookings, commission, balance, or createdAt")
      .default("rating"),
  ],
  adminAnalyticsController.getVendorAnalytics,
);

/**
 * GET /api/admin/analytics/vendors/:vendorId
 * Detailed analytics for a specific vendor
 */
router.get(
  "/analytics/vendors/:vendorId",
  is_admin,
  [
    param("vendorId").isMongoId().withMessage("vendorId must be a valid MongoDB ID"),
    query("from").optional().isISO8601().withMessage("from must be a valid ISO date"),
    query("to").optional().isISO8601().withMessage("to must be a valid ISO date"),
  ],
  adminAnalyticsController.getVendorDetailAnalytics,
);

// ============================================
// BOOKING ANALYTICS ROUTES
// ============================================

/**
 * GET /api/admin/analytics/bookings
 * Booking analytics
 */
router.get(
  "/analytics/bookings",
  is_admin,
  [
    query("status")
      .optional()
      .isIn(["all", "completed", "cancelled", "active"])
      .withMessage("status must be all, completed, cancelled, or active")
      .default("all"),
    query("from").optional().isISO8601().withMessage("from must be a valid ISO date"),
    query("to").optional().isISO8601().withMessage("to must be a valid ISO date"),
    query("vendorId").optional().isMongoId().withMessage("vendorId must be a valid MongoDB ID"),
    query("groupBy")
      .optional()
      .isIn(["day", "week", "month", "year"])
      .withMessage("groupBy must be day, week, month, or year")
      .default("day"),
  ],
  adminAnalyticsController.getBookingAnalytics,
);

/**
 * GET /api/admin/analytics/bookings/:bookingId
 * Detailed analytics for a specific booking
 */
router.get(
  "/analytics/bookings/:bookingId",
  is_admin,
  [param("bookingId").isMongoId().withMessage("bookingId must be a valid MongoDB ID")],
  adminAnalyticsController.getBookingDetailAnalytics,
);

// ============================================
// REVENUE ANALYTICS ROUTES
// ============================================

/**
 * GET /api/admin/analytics/revenue
 * Revenue analytics
 */
router.get(
  "/analytics/revenue",
  is_admin,
  [
    query("period")
      .optional()
      .isIn(["day", "week", "month", "year"])
      .withMessage("period must be day, week, month, or year")
      .default("month"),
    query("from").optional().isISO8601().withMessage("from must be a valid ISO date"),
    query("to").optional().isISO8601().withMessage("to must be a valid ISO date"),
    query("gateway")
      .optional()
      .isIn(["razorpay", "cashfree", "stripe", "phonepe", "all"])
      .withMessage("gateway must be razorpay, cashfree, stripe, phonepe, or all")
      .default("all"),
  ],
  adminAnalyticsController.getRevenueAnalytics,
);

// ============================================
// REFERRAL ANALYTICS ROUTES
// ============================================

/**
 * GET /api/admin/analytics/referrals
 * Referral analytics
 */
router.get(
  "/analytics/referrals",
  is_admin,
  [
    query("period")
      .optional()
      .isIn(["day", "week", "month", "year"])
      .withMessage("period must be day, week, month, or year")
      .default("month"),
    query("from").optional().isISO8601().withMessage("from must be a valid ISO date"),
    query("to").optional().isISO8601().withMessage("to must be a valid ISO date"),
    query("status")
      .optional()
      .isIn(["all", "active", "completed"])
      .withMessage("status must be all, active, or completed")
      .default("all"),
  ],
  adminAnalyticsController.getReferralAnalytics,
);

// ============================================
// EXPORT ANALYTICS ROUTES
// ============================================

/**
 * GET /api/admin/analytics/export
 * Export analytics data
 * Supports: users, vendors, bookings, revenue, referrals
 */
router.get(
  "/analytics/export",
  is_admin,
  [
    query("format")
      .optional()
      .isIn(["csv", "json"])
      .withMessage("format must be csv or json")
      .default("json"),
    query("type")
      .isIn(["users", "vendors", "bookings", "revenue", "referrals"])
      .withMessage("type must be users, vendors, bookings, revenue, or referrals"),
    query("from").optional().isISO8601().withMessage("from must be a valid ISO date"),
    query("to").optional().isISO8601().withMessage("to must be a valid ISO date"),
  ],
  adminAnalyticsController.exportAnalytics,
);

// ============================================
// HEALTH CHECK ROUTE
// ============================================

/**
 * GET /api/admin/analytics/health
 * Health check for analytics system
 */
router.get("/analytics/health", is_admin, adminAnalyticsController.healthCheck);

// ============================================
// BULK ANALYTICS ROUTES
// ============================================

/**
 * GET /api/admin/analytics/summary
 * Get a summary of all analytics in one request
 * Use with caution - can be heavy on the database
 */
router.get(
  "/analytics/summary",
  is_admin,
  [
    query("period")
      .optional()
      .isIn(["day", "week", "month", "year"])
      .withMessage("period must be day, week, month, or year")
      .default("month"),
    query("from").optional().isISO8601().withMessage("from must be a valid ISO date"),
    query("to").optional().isISO8601().withMessage("to must be a valid ISO date"),
  ],
  async (req, res, next) => {
    try {
      // Get all analytics data in parallel
      const [dashboardData, userData, vendorData, bookingData, revenueData, referralData] =
        await Promise.all([
          // Dashboard
          adminAnalyticsController._computeDashboard
            ? adminAnalyticsController._computeDashboard()
            : Promise.resolve(null),

          // User analytics
          new Promise((resolve) => {
            const reqCopy = { ...req, query: { ...req.query, status: "all" } };
            const resCopy = {
              status: () => ({
                json: (data) => resolve(data.data || data),
              }),
            };
            adminAnalyticsController.getUserAnalytics(reqCopy, resCopy, (err) => {
              if (err) resolve(null);
            });
          }),

          // Vendor analytics
          new Promise((resolve) => {
            const reqCopy = { ...req, query: { ...req.query, status: "all", sortBy: "rating" } };
            const resCopy = {
              status: () => ({
                json: (data) => resolve(data.data || data),
              }),
            };
            adminAnalyticsController.getVendorAnalytics(reqCopy, resCopy, (err) => {
              if (err) resolve(null);
            });
          }),

          // Booking analytics
          new Promise((resolve) => {
            const reqCopy = { ...req, query: { ...req.query, status: "all", groupBy: "day" } };
            const resCopy = {
              status: () => ({
                json: (data) => resolve(data.data || data),
              }),
            };
            adminAnalyticsController.getBookingAnalytics(reqCopy, resCopy, (err) => {
              if (err) resolve(null);
            });
          }),

          // Revenue analytics
          new Promise((resolve) => {
            const reqCopy = { ...req, query: { ...req.query, gateway: "all" } };
            const resCopy = {
              status: () => ({
                json: (data) => resolve(data.data || data),
              }),
            };
            adminAnalyticsController.getRevenueAnalytics(reqCopy, resCopy, (err) => {
              if (err) resolve(null);
            });
          }),

          // Referral analytics
          new Promise((resolve) => {
            const reqCopy = { ...req, query: { ...req.query, status: "all" } };
            const resCopy = {
              status: () => ({
                json: (data) => resolve(data.data || data),
              }),
            };
            adminAnalyticsController.getReferralAnalytics(reqCopy, resCopy, (err) => {
              if (err) resolve(null);
            });
          }),
        ]);

      return res.status(200).json({
        success: true,
        data: {
          dashboard: dashboardData,
          users: userData,
          vendors: vendorData,
          bookings: bookingData,
          revenue: revenueData,
          referrals: referralData,
          generatedAt: new Date().toISOString(),
        },
      });
    } catch (err) {
      logger.error({ err }, "Analytics summary failed");
      return next(err);
    }
  },
);

// ============================================
// ADMIN USER/VENDOR MANAGEMENT BY PHONE
// ============================================

/**
 * GET /api/admin/users/phone/:phoneNo
 * Get user by phone number
 */
router.get(
  "/users/phone/:phoneNo",

  is_admin,
  [
    param("phoneNo")
      .isNumeric()
      .withMessage("Phone number must be numeric")
      .isLength({ min: 10, max: 15 })
      .withMessage("Phone number must be between 10 and 15 digits"),
  ],
  adminAnalyticsController.getUserByPhone,
);

/**
 * GET /api/admin/vendors/phone/:phoneNo
 * Get vendor by phone number
 */
router.get(
  "/vendors/phone/:phoneNo",

  is_admin,
  [
    param("phoneNo")
      .isNumeric()
      .withMessage("Phone number must be numeric")
      .isLength({ min: 10, max: 15 })
      .withMessage("Phone number must be between 10 and 15 digits"),
  ],
  adminAnalyticsController.getVendorByPhone,
);

/**
 * PUT /api/admin/users/phone/:phoneNo
 * Update user by phone number
 */
router.put(
  "/users/phone/:phoneNo",

  is_admin,
  [
    param("phoneNo")
      .isNumeric()
      .withMessage("Phone number must be numeric")
      .isLength({ min: 10, max: 15 })
      .withMessage("Phone number must be between 10 and 15 digits"),
    body("name").optional().isString().withMessage("Name must be a string"),
    body("email").optional().isEmail().withMessage("Invalid email format"),
    body("status")
      .optional()
      .isIn(["active", "blocked"])
      .withMessage("Status must be active or blocked"),
    body("gender").optional().isString().withMessage("Gender must be a string"),
    body("pincode").optional().isString().withMessage("Pincode must be a string"),
    body("balance").optional().isNumeric().withMessage("Balance must be a number"),
    body("password")
      .optional()
      .isLength({ min: 6 })
      .withMessage("Password must be at least 6 characters"),
    body("verifyPhoneNo").optional().isBoolean().withMessage("verifyPhoneNo must be boolean"),
    body("verifyEmail").optional().isBoolean().withMessage("verifyEmail must be boolean"),
  ],
  adminAnalyticsController.updateUserByPhone,
);

/**
 * PUT /api/admin/vendors/phone/:phoneNo
 * Update vendor by phone number
 */
router.put(
  "/vendors/phone/:phoneNo",

  is_admin,
  [
    param("phoneNo")
      .isNumeric()
      .withMessage("Phone number must be numeric")
      .isLength({ min: 10, max: 15 })
      .withMessage("Phone number must be between 10 and 15 digits"),
    body("name").optional().isString().withMessage("Name must be a string"),
    body("email").optional().isEmail().withMessage("Invalid email format"),
    body("status")
      .optional()
      .isIn(["active", "blocked"])
      .withMessage("Status must be active or blocked"),
    body("type").optional().isString().withMessage("Type must be a string"),
    body("gender").optional().isString().withMessage("Gender must be a string"),
    body("pincode").optional().isString().withMessage("Pincode must be a string"),
    body("balance").optional().isNumeric().withMessage("Balance must be a number"),
    body("password")
      .optional()
      .isLength({ min: 6 })
      .withMessage("Password must be at least 6 characters"),
    body("isVerified").optional().isBoolean().withMessage("isVerified must be boolean"),
    body("verifyPhoneNo").optional().isBoolean().withMessage("verifyPhoneNo must be boolean"),
    body("verifyEmail").optional().isBoolean().withMessage("verifyEmail must be boolean"),
    body("wageRate").optional().isNumeric().withMessage("wageRate must be a number"),
    body("experience").optional().isNumeric().withMessage("Experience must be a number"),
    body("commission").optional().isNumeric().withMessage("Commission must be a number"),
  ],
  adminAnalyticsController.updateVendorByPhone,
);

/**
 * POST /api/admin/users/phone/:phoneNo/block
 * Block user by phone number
 */
router.post(
  "/users/phone/:phoneNo/block",

  is_admin,
  [
    param("phoneNo")
      .isNumeric()
      .withMessage("Phone number must be numeric")
      .isLength({ min: 10, max: 15 })
      .withMessage("Phone number must be between 10 and 15 digits"),
  ],
  adminAnalyticsController.blockUserByPhone,
);

/**
 * POST /api/admin/users/phone/:phoneNo/unblock
 * Unblock user by phone number
 */
router.post(
  "/users/phone/:phoneNo/unblock",

  is_admin,
  [
    param("phoneNo")
      .isNumeric()
      .withMessage("Phone number must be numeric")
      .isLength({ min: 10, max: 15 })
      .withMessage("Phone number must be between 10 and 15 digits"),
  ],
  adminAnalyticsController.unblockUserByPhone,
);

/**
 * POST /api/admin/vendors/phone/:phoneNo/block
 * Block vendor by phone number
 */
router.post(
  "/vendors/phone/:phoneNo/block",

  is_admin,
  [
    param("phoneNo")
      .isNumeric()
      .withMessage("Phone number must be numeric")
      .isLength({ min: 10, max: 15 })
      .withMessage("Phone number must be between 10 and 15 digits"),
  ],
  adminAnalyticsController.blockVendorByPhone,
);

/**
 * POST /api/admin/vendors/phone/:phoneNo/unblock
 * Unblock vendor by phone number
 */
router.post(
  "/vendors/phone/:phoneNo/unblock",

  is_admin,
  [
    param("phoneNo")
      .isNumeric()
      .withMessage("Phone number must be numeric")
      .isLength({ min: 10, max: 15 })
      .withMessage("Phone number must be between 10 and 15 digits"),
  ],
  adminAnalyticsController.unblockVendorByPhone,
);

/**
 * GET /api/admin/search/users
 * Search users by phone number (partial match)
 */
router.get(
  "/search/users",

  is_admin,
  [
    query("phoneNo")
      .notEmpty()
      .withMessage("Phone number is required")
      .isNumeric()
      .withMessage("Phone number must be numeric")
      .isLength({ min: 3, max: 15 })
      .withMessage("Phone number must be between 3 and 15 digits"),
  ],
  adminAnalyticsController.searchUsersByPhone,
);

/**
 * GET /api/admin/search/vendors
 * Search vendors by phone number (partial match)
 */
router.get(
  "/search/vendors",

  is_admin,
  [
    query("phoneNo")
      .notEmpty()
      .withMessage("Phone number is required")
      .isNumeric()
      .withMessage("Phone number must be numeric")
      .isLength({ min: 3, max: 15 })
      .withMessage("Phone number must be between 3 and 15 digits"),
  ],
  adminAnalyticsController.searchVendorsByPhone,
);

// ============================================
// COMPLETE USER/VENDOR DETAILS BY PHONE
// ============================================

/**
 * GET /api/admin/users/complete/:phoneNo
 * Get complete user details including bookings, transactions, wallet ledger, referrals
 */
router.get(
  "/users/complete/:phoneNo",
  is_admin,
  [
    param("phoneNo").isNumeric().withMessage("Phone number must be numeric"),
    query("limit")
      .optional()
      .isInt({ min: 1, max: 100 })
      .withMessage("Limit must be between 1 and 100"),
    query("page").optional().isInt({ min: 1 }).withMessage("Page must be a positive integer"),
  ],
  adminAnalyticsController.getUserCompleteByPhone,
);

/**
 * GET /api/admin/vendors/complete/:phoneNo
 * Get complete vendor details including bookings, transactions, wallet ledger, referrals, leaves
 */
router.get(
  "/vendors/complete/:phoneNo",
  is_admin,
  [
    param("phoneNo").isNumeric().withMessage("Phone number must be numeric"),
    query("limit")
      .optional()
      .isInt({ min: 1, max: 100 })
      .withMessage("Limit must be between 1 and 100"),
    query("page").optional().isInt({ min: 1 }).withMessage("Page must be a positive integer"),
  ],
  adminAnalyticsController.getVendorCompleteByPhone,
);

// ============================================
// VENDOR LEAVE MANAGEMENT BY PHONE
// ============================================

/**
 * GET /api/admin/vendors/:phoneNo/leaves
 * Get vendor leaves by phone number
 */
router.get(
  "/vendors/:phoneNo/leaves",
  is_admin,
  [
    param("phoneNo").isNumeric().withMessage("Phone number must be numeric"),
    query("status")
      .optional()
      .isIn(["active", "cancelled"])
      .withMessage("Status must be active or cancelled"),
    query("from").optional().isISO8601().withMessage("from must be a valid ISO date"),
    query("to").optional().isISO8601().withMessage("to must be a valid ISO date"),
    query("limit")
      .optional()
      .isInt({ min: 1, max: 100 })
      .withMessage("Limit must be between 1 and 100"),
    query("page").optional().isInt({ min: 1 }).withMessage("Page must be a positive integer"),
  ],
  adminAnalyticsController.getVendorLeavesByPhone,
);

/**
 * POST /api/admin/vendors/:phoneNo/leaves
 * Create vendor leave by phone number
 */
router.post(
  "/vendors/:phoneNo/leaves",
  is_admin,
  [
    param("phoneNo").isNumeric().withMessage("Phone number must be numeric"),
    body("from").isISO8601().withMessage("from must be a valid ISO date"),
    body("to").isISO8601().withMessage("to must be a valid ISO date"),
    body("reason").optional().isString().withMessage("reason must be a string"),
  ],
  adminAnalyticsController.createVendorLeaveByPhone,
);

/**
 * PUT /api/admin/vendors/leaves/:leaveId
 * Update vendor leave status
 */
router.put(
  "/vendors/leaves/:leaveId",
  is_admin,
  [
    param("leaveId").isMongoId().withMessage("Invalid leave ID"),
    body("status").isIn(["active", "cancelled"]).withMessage("Status must be active or cancelled"),
  ],
  adminAnalyticsController.updateVendorLeaveStatus,
);

/**
 * DELETE /api/admin/vendors/leaves/:leaveId
 * Delete vendor leave
 */
router.delete(
  "/vendors/leaves/:leaveId",
  is_admin,
  [param("leaveId").isMongoId().withMessage("Invalid leave ID")],
  adminAnalyticsController.deleteVendorLeave,
);

module.exports = router;
