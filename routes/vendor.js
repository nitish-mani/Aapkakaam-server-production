const express = require("express");

const router = express.Router();
const is_user = require("../middleware/is_user");
const is_vendor = require("../middleware/is_vendor");
const vendor_controller = require("../controller/vendor");

const authenticate = require("../middleware/authenticate");
const vendor_auth = require("../auth/vendor_auth");
const { authRateLimiter } = require("../src/middleware/rateLimiter");

/////////////////////
//// for vendor ////
////////////////////

// --- Auth & OTP endpoints (strict rate limit) ------------------------
router.post(
  "/phoneVerification",
  authRateLimiter,
  vendor_controller.vendor_controller_verify_phoneNo,
);
router.post("/otpVerification", authRateLimiter, vendor_controller.vendor_controller_otp);

router.post(
  "/phoneVerificationPasswordReset",
  authRateLimiter,
  vendor_controller.vendor_controller_verify_phoneNo_reset_password,
);
router.post(
  "/otpVerificationResetPassword",
  authRateLimiter,
  vendor_controller.vendor_controller_otp_reset_password,
);

router.post("/signup", authRateLimiter, vendor_auth.signup);
router.post("/login", authRateLimiter, vendor_auth.login);

router.patch("/edit/password", authRateLimiter, vendor_controller.vendor_controller_patch_password);

// --- Authenticated endpoints ----------------------------------------

router.patch(
  "/update/address",
  authenticate,
  is_vendor,
  vendor_controller.vendor_controller_patch_address,
);
router.patch("/edit/name", authenticate, vendor_controller.vendor_controller_patch_name);
router.patch(
  "/edit/fcmToken",
  authenticate,
  is_vendor,
  vendor_controller.vendor_controller_patch_fcmToken,
);

router.patch(
  "/wageRate",
  authenticate,
  is_vendor,
  vendor_controller.vendor_controller_patch_wageRate,
);

router.get(
  "/getBookings/:vendorId/:month/:year",
  authenticate,
  is_vendor,
  vendor_controller.vendor_controller_getBookings,
);
router.get(
  "/getOrders/:vendorId/:pageNo",
  authenticate,
  is_vendor,
  vendor_controller.vendor_controller_getOrders,
);
router.get(
  "/getShare/:vendorId/:skip",
  is_vendor,
  authenticate,
  vendor_controller.vendor_controller_getShare,
);
router.get(
  "/getVendorByVendor/:vendorId",
  authenticate,
  is_vendor,
  vendor_controller.vendor_controller_getVendor,
);

/////////////////////
//// for user ///////
////////////////////

router.get(
  "/getAll/:type/:pincode/:bookingDate/:page/:minRating/:minWageRate",
  authenticate,
  is_user,
  vendor_controller.vendor_controller_getAvailableVendor,
);
router.get(
  "/getAllV/:type/:pincode/:bookingDate/:page/:minRating/:minWageRate",
  authenticate,
  is_vendor,
  vendor_controller.vendor_controller_getAvailableVendor,
);
router.get("/getOne/:vendorId", authenticate, is_user, vendor_controller.vendor_controller_getOne);

router.get(
  "/getEarnings/:vendorId",
  authenticate,
  is_vendor,
  vendor_controller.vendor_controller_getEarnings,
);
router.get(
  "/getAttendance/:vendorId/:month/:year",
  authenticate,
  is_vendor,
  vendor_controller.vendor_controller_getAttendance,
);
router.post(
  "/postAttendance/:vendorId",
  authenticate,
  is_vendor,
  vendor_controller.vendor_controller_postAttendance,
);

// Leave Management Routes
router
  .get("/getLeaveStats", is_vendor, authenticate, vendor_controller.getLeaves)
  .post("/createLeave", is_vendor, authenticate, vendor_controller.createLeave);

router
  .route("/cancelLeave/:leaveId")
  .delete(is_vendor, authenticate, vendor_controller.cancelLeave);

router.get("/availability", authenticate, vendor_controller.checkAvailability);

module.exports = router;
