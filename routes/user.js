const express = require("express");

const router = express.Router();
const is_user = require("../middleware/is_user");
const is_vendor = require("../middleware/is_vendor");
const user_controller = require("../controller/user");

const user_auth = require("../auth/user_auth");
const { authRateLimiter } = require("../src/middleware/rateLimiter");

const authenticate = require("../middleware/authenticate");

/////////////////////
//// for user //////
////////////////////

// --- Auth & OTP endpoints (strict rate limit) ------------------------
router.post("/phoneVerification", authRateLimiter, user_controller.user_controller_verify_phoneNo);
router.post("/otpVerification", authRateLimiter, user_controller.user_controller_otp);

router.post(
  "/phoneVerificationPasswordReset",
  authRateLimiter,
  user_controller.user_controller_verify_phoneNo_reset_password,
);
router.post(
  "/otpVerificationResetPassword",
  authRateLimiter,
  user_controller.user_controller_otp_reset_password,
);

router.post("/signup", authRateLimiter, user_auth.signup);
router.post("/login", authRateLimiter, user_auth.login);

router.patch("/edit/password", authRateLimiter, user_controller.user_controller_patch_password);

// --- Authenticated endpoints ----------------------------------

router.patch("/edit/name", authenticate, is_user, user_controller.user_controller_patch_name);
router.patch(
  "/edit/fcmToken",
  authenticate,
  is_user,
  user_controller.user_controller_patch_fcmToken,
);

router.patch(
  "/update/address",
  authenticate,
  is_user,
  user_controller.user_controller_patch_address,
);

router.get(
  "/getOrders/:userId/:pageNo",
  authenticate,
  is_user,
  user_controller.user_controller_getOrders,
);
router.get(
  "/getShare/:userId/:skip",
  authenticate,
  is_user,
  user_controller.user_controller_getShare,
);
router.get(
  "/getUserByUser/:userId",
  authenticate,
  is_user,
  user_controller.user_controller_getUser,
);

///////////////////////
//// for vendor //////
/////////////////////

router.get("/getOne", authenticate, is_vendor, user_controller.user_controller_getOne);
router.get(
  "/getEarnings/:userId",
  authenticate,
  is_user,
  user_controller.user_controller_getEarnings,
);

router.get(
  "/getAttendance/:userId/:month/:year",
  authenticate,
  is_user,
  user_controller.user_controller_getAttendance,
);
router.post(
  "/postAttendance/:userId",
  authenticate,
  is_user,
  user_controller.user_controller_postAttendance,
);

module.exports = router;
