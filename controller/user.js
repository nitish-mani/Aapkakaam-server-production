/**
 * User Controller
 *
 * This controller follows the Single Responsibility Principle.
 * It only handles:
 * 1. Request validation
 * 2. Calling UserService
 * 3. Returning consistent responses
 *
 * All business logic is in UserService
 */
const asyncHandler = require("../src/utils/asyncHandler");
const ApiResponse = require("../src/utils/ApiResponse");
const ApiError = require("../src/utils/ApiError");
const UserService = require("../src/services/UserService");

// ==================== OTP & VERIFICATION ====================

exports.user_controller_verify_phoneNo = asyncHandler(async (req, res) => {
  const { phoneNo } = req.body;
  const result = await UserService.sendPhoneOTP(phoneNo);
  res.status(200).json({
    message: "OTP sent successfully",
    verified: true,
    otpId: result.otpId,
  });
});
exports.user_controller_verify_phoneNo_reset_password = asyncHandler(async (req, res) => {
  const { phoneNo } = req.body;
  const result = await UserService.sendPasswordResetOTP(phoneNo);
  res.status(200).json({
    message: "OTP sent successfully",
    verified: true,
    otpId: result.otpId,
  });
});

exports.user_controller_otp = asyncHandler(async (req, res) => {
  const { otp, otpId } = req.body;

  const result = await UserService.verifyOTP(otpId, otp);

  res.status(200).json(result);
});
exports.user_controller_otp_reset_password = asyncHandler(async (req, res) => {
  const { otp, otpId } = req.body;

  const result = await UserService.verifyOTPForPasswordReset(otpId, otp);

  res.status(200).json(result);
});

// ==================== PROFILE UPDATES ====================

exports.user_controller_patch_password = asyncHandler(async (req, res) => {
  const { password, phoneNo, otpId } = req.body;

  const result = await UserService.updatePassword(phoneNo, password, otpId);

  res.status(200).json(result);
});

function assertBodyIdentityMatchesAuth(req, fieldName = "userId") {
  const suppliedId = req.body?.[fieldName];

  if (suppliedId && String(suppliedId) !== String(req.auth.id)) {
    throw ApiError.forbidden("You are not authorized to modify another user's account");
  }
}

exports.user_controller_patch_name = asyncHandler(async (req, res) => {
  assertBodyIdentityMatchesAuth(req);

  const userId = req.auth.id;
  const { name } = req.body;

  const result = await UserService.updateName(userId, name);

  res.status(200).json(result);
});

exports.user_controller_patch_fcmToken = asyncHandler(async (req, res) => {
  assertBodyIdentityMatchesAuth(req);

  const userId = req.auth.id;
  const { fcmToken } = req.body;

  const result = await UserService.updateFcmToken(userId, fcmToken);

  res.status(200).json(result);
});

exports.user_controller_patch_address = asyncHandler(async (req, res) => {
  assertBodyIdentityMatchesAuth(req);

  const userId = req.auth.id;
  const { vill, post, dist, state, pincode } = req.body;

  const result = await UserService.updateAddress(userId, {
    vill,
    post,
    dist,
    state,
    pincode,
  });

  res.status(200).json(result);
});

// ==================== DATA RETRIEVAL ====================

exports.user_controller_getOrders = asyncHandler(async (req, res) => {
  const authenticatedId = String(req.auth.id);
  const requestedId = String(req.params.userId); // or vendorId

  if (authenticatedId !== requestedId) {
    throw ApiError.forbidden("You are not authorized to access this resource");
  }
  const { userId, pageNo } = req.params;
  const result = await UserService.getUserOrders(userId, pageNo);
  res.status(200).json(result);
});

exports.user_controller_getShare = asyncHandler(async (req, res) => {
  const { userId, skip } = req.params;

  if (!req.auth?.id) {
    throw ApiError.unauthorized("Authentication required.");
  }

  if (String(req.auth.id) !== String(userId)) {
    throw ApiError.forbidden("You are not authorized to access these shares");
  }

  const result = await UserService.getUserShares(req.auth.id, skip);

  res.status(200).json(result);
});

exports.user_controller_getUser = asyncHandler(async (req, res) => {
  const authenticatedId = String(req.auth.id);
  const requestedId = String(req.params.userId); // or vendorId

  if (authenticatedId !== requestedId) {
    throw ApiError.forbidden("You are not authorized to access this resource");
  }
  const { userId } = req.params;
  const result = await UserService.getUserDetails(userId);
  res.status(200).json(result);
});

exports.user_controller_getOne = asyncHandler(async (req, res) => {
  const authenticatedId = String(req.auth.id);
  const requestedId = String(req.params.userId); // or vendorId

  if (authenticatedId !== requestedId) {
    throw ApiError.forbidden("You are not authorized to access this resource");
  }
  const { userId } = req.params;
  const result = await UserService.getUser(userId);
  res.json(result);
});

exports.user_controller_getEarnings = asyncHandler(async (req, res) => {
  const authenticatedUserId = req.auth.id;
  const requestedUserId = req.params.userId;

  if (String(authenticatedUserId) !== String(requestedUserId)) {
    throw ApiError.forbidden("You are not authorized to access this resource");
  }

  const result = await UserService.getUserEarnings(authenticatedUserId);
  res.json(result);
});

// ==================== ATTENDANCE ====================

exports.user_controller_getAttendance = asyncHandler(async (req, res) => {
  const authenticatedId = String(req.auth.id);
  const requestedId = String(req.params.userId); // or vendorId

  if (authenticatedId !== requestedId) {
    throw ApiError.forbidden("You are not authorized to access this resource");
  }
  const { userId, month, year } = req.params;
  const result = await UserService.getAttendance(userId, month, year);
  res.json({
    message: "Attendance records retrieved successfully",
    ...result,
  });
});

exports.user_controller_postAttendance = asyncHandler(async (req, res) => {
  const authenticatedId = String(req.auth.id);
  const requestedId = String(req.params.userId); // or vendorId

  if (authenticatedId !== requestedId) {
    throw ApiError.forbidden("You are not authorized to access this resource");
  }
  const { userId } = req.params;
  const { attendanceData } = req.body;
  const result = await UserService.postAttendance(userId, attendanceData);
  res.json(result);
});
