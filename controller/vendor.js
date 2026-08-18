/**
 * Vendor Controller
 *
 * This controller follows the Single Responsibility Principle.
 * It only handles:
 * 1. Request validation
 * 2. Calling VendorService
 * 3. Returning consistent responses
 *
 * All business logic is in VendorService
 */
const asyncHandler = require("../src/utils/asyncHandler");
const ApiResponse = require("../src/utils/ApiResponse");
const ApiError = require("../src/utils/ApiError");
const VendorService = require("../src/services/VendorService");
const VendorLeaveService = require("../src/services/VendorLeaveService");

// ==================== OTP & VERIFICATION ====================

exports.vendor_controller_verify_phoneNo = asyncHandler(async (req, res) => {
  const { phoneNo } = req.body;
  if (!phoneNo) {
    return res.status(400).json({ message: "Phone number is required" });
  }

  const result = await VendorService.sendPhoneOTP(phoneNo);
  res.status(200).json({
    message: "OTP sent successfully",
    verified: true,
    otpId: result.otpId,
  });
});

exports.vendor_controller_verify_phoneNo_reset_password = asyncHandler(async (req, res) => {
  const { phoneNo } = req.body;
  if (!phoneNo) {
    return res.status(400).json({ message: "Phone number is required" });
  }

  const result = await VendorService.sendPasswordResetOTP(phoneNo);
  res.status(200).json({
    message: "OTP sent successfully",
    verified: true,
    otpId: result.otpId,
  });
});

exports.vendor_controller_otp = asyncHandler(async (req, res) => {
  const { otp, otpId } = req.body;

  const result = await VendorService.verifyOTP(otpId, otp);

  res.status(200).json(result);
});

exports.vendor_controller_otp_reset_password = asyncHandler(async (req, res) => {
  const { otp, otpId } = req.body;

  const result = await VendorService.verifyOTPForPasswordReset(otpId, otp);

  res.status(200).json(result);
});

// ==================== PROFILE UPDATES ====================

exports.vendor_controller_patch_password = asyncHandler(async (req, res) => {
  const { password, phoneNo, otpId } = req.body;

  const result = await VendorService.updatePassword(phoneNo, password, otpId);

  res.status(200).json(result);
});

exports.vendor_controller_patch_address = asyncHandler(async (req, res) => {
  const vendorId = req.auth.id;
  const { vill, post, dist, state, pincode } = req.body;

  const result = await VendorService.updateAddress(vendorId, {
    vill,
    post,
    dist,
    state,
    pincode,
  });

  res.status(200).json(result);
});

exports.vendor_controller_patch_name = asyncHandler(async (req, res) => {
  const vendorId = req.auth.id;
  const { name } = req.body;

  const result = await VendorService.updateName(vendorId, name);

  res.status(200).json(result);
});

exports.vendor_controller_patch_fcmToken = asyncHandler(async (req, res) => {
  const vendorId = req.auth.id;
  const { fcmToken } = req.body;

  const result = await VendorService.updateFcmToken(vendorId, fcmToken);

  res.status(200).json(result);
});

exports.vendor_controller_patch_wageRate = asyncHandler(async (req, res) => {
  const vendorId = req.auth.id;
  const { wageRate, wageRateType } = req.body;

  const result = await VendorService.updateWageRate(vendorId, wageRate, wageRateType);

  res.status(200).json(result);
});

// ==================== DATA RETRIEVAL ====================

// ==================== PRIVATE VENDOR DATA ====================

exports.vendor_controller_getOrders = asyncHandler(async (req, res) => {
  const { vendorId } = req.params;

  if (String(req.auth.id) !== String(vendorId)) {
    throw ApiError.forbidden("You are not authorized to access this resource");
  }

  const result = await VendorService.getVendorOrders(req.auth.id);

  res.status(200).json(result);
});

exports.vendor_controller_getShare = asyncHandler(async (req, res) => {
  const { vendorId, skip } = req.params;

  if (String(req.auth.id) !== String(vendorId)) {
    throw ApiError.forbidden("You are not authorized to access these shares");
  }

  const result = await VendorService.getVendorShares(req.auth.id, skip);

  res.status(200).json(result);
});

exports.vendor_controller_getBookings = asyncHandler(async (req, res) => {
  const { vendorId, month, year } = req.params;

  if (String(req.auth.id) !== String(vendorId)) {
    throw ApiError.forbidden("You are not authorized to access this vendor's bookings");
  }

  const result = await VendorService.getVendorBookingsByMonth(req.auth.id, year, month);

  res.status(200).json(result);
});

exports.vendor_controller_getVendor = asyncHandler(async (req, res) => {
  const { vendorId } = req.params;

  if (String(req.auth.id) !== String(vendorId)) {
    throw ApiError.forbidden("You are not authorized to access this resource");
  }

  const result = await VendorService.getVendorDetails(req.auth.id);

  res.status(200).json(result);
});

exports.vendor_controller_getEarnings = asyncHandler(async (req, res) => {
  const { vendorId } = req.params;

  if (String(req.auth.id) !== String(vendorId)) {
    throw ApiError.forbidden("You are not authorized to access this resource");
  }

  const result = await VendorService.getVendorEarnings(req.auth.id);

  res.status(200).json(result);
});

exports.vendor_controller_getOne = asyncHandler(async (req, res) => {
  const { vendorId } = req.params;

  const result = await VendorService.getVendor(vendorId);

  res.status(200).json(result);
});

exports.vendor_controller_getAvailableVendor = asyncHandler(async (req, res) => {
  const { type, pincode, bookingDate, page, minRating, minWageRate } = req.params;

  const userIdentifier = req.auth?.id
    ? String(req.auth.id)
    : `${req.ip}-${req.headers["user-agent"]?.substring(0, 50)}`;

  const result = await VendorService.getAvailableVendors(
    type,
    pincode,
    bookingDate,
    parseInt(page, 10) || 1,
    parseFloat(minRating) || 0,
    parseFloat(minWageRate) || 0,
    userIdentifier,
  );

  res.status(200).json(result);
});

// ==================== ATTENDANCE ====================

exports.vendor_controller_getAttendance = asyncHandler(async (req, res) => {
  const { vendorId, month, year } = req.params;

  if (String(req.auth.id) !== String(vendorId)) {
    throw ApiError.forbidden("You are not authorized to access this resource");
  }

  const result = await VendorService.getAttendance(req.auth.id, month, year);

  res.status(200).json(result);
});

exports.vendor_controller_postAttendance = asyncHandler(async (req, res) => {
  const { vendorId } = req.params;

  if (!req.auth?.id) {
    throw ApiError.unauthorized("Authentication required.");
  }

  if (req.auth.role !== "vendor") {
    throw ApiError.forbidden("Vendor authentication required.");
  }

  if (String(req.auth.id) !== String(vendorId)) {
    throw ApiError.forbidden("You are not authorized to mark attendance for this vendor.");
  }

  const { attendanceData } = req.body;

  if (!attendanceData || typeof attendanceData !== "object") {
    throw ApiError.badRequest("Attendance data is required.");
  }

  const result = await VendorService.postAttendance(req.auth.id, attendanceData);

  res.status(200).json(result);
});

//======================== Leave ========================

exports.getLeaves = asyncHandler(async (req, res) => {
  const vendorId = req.auth.id;

  const leaves = await VendorLeaveService.getVendorLeaves(vendorId);

  res.status(200).json({
    success: true,
    data: leaves,
  });
});

exports.createLeave = asyncHandler(async (req, res) => {
  const vendorId = req.auth.id;
  const { from, to, reason } = req.body;

  if (!from || !to) {
    throw ApiError.badRequest("Leave start and end dates are required");
  }

  const newLeave = await VendorLeaveService.createLeave(vendorId, from, to, reason);

  res.status(201).json({
    success: true,
    message: "Leave created successfully",
    data: newLeave,
  });
});

exports.cancelLeave = asyncHandler(async (req, res) => {
  const vendorId = req.auth.id;
  const { leaveId } = req.params;

  if (!leaveId) {
    throw ApiError.badRequest("Leave ID is required");
  }

  const cancelledLeave = await VendorLeaveService.cancelLeave(vendorId, leaveId);

  res.status(200).json({
    success: true,
    message: "Leave cancelled successfully",
    data: cancelledLeave,
  });
});

exports.checkAvailability = asyncHandler(async (req, res) => {
  const { vendorId, date } = req.query;

  if (!vendorId || !date) {
    throw ApiError.badRequest("vendorId and date are required");
  }

  const hasLeave = await VendorLeaveService.hasLeaveOnDate(vendorId, date);

  res.status(200).json({
    success: true,
    data: {
      vendorId,
      date,
      available: !hasLeave,
    },
  });
});
