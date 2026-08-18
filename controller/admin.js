const { validationResult } = require("express-validator");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { performance } = require("perf_hooks");

const OtpAuth = require("../models/otpAuth");
const Admin = require("../models/admin");
const User = require("../models/user");
const Vendor = require("../models/vendor");
const Bookings = require("../models/bookings");
const ENV = require("../src/config/env");

// Import logger and services
const { AdminLogger } = require("../src/logger/index");
const AdminService = require("../src/services/AdminService");

const secretKey = ENV.JWT_ADMIN_SECRET;
const email_admin = process.env.ADMIN_EMAIL || "admin@aapkakaam.com";

const otp = () => Math.floor(Math.random() * (999999 - 100000 + 1)) + 100000;

/**
 * Send phone OTP for admin verification
 */
exports.admin_controller_verify_phoneNo = async (req, res, next) => {
  const startTime = performance.now();
  const requestId = req.headers["x-request-id"] || `otp-${Date.now()}`;
  const { phoneNo } = req.body;

  AdminLogger.info({
    event: "ADMIN_PHONE_OTP_STARTED",
    requestId,
    phone: phoneNo ? maskPhone(phoneNo) : null,
  });

  try {
    if (!phoneNo) {
      AdminLogger.warn({
        event: "ADMIN_PHONE_OTP_FAILED",
        reason: "phone_required",
        requestId,
        duration_ms: +(performance.now() - startTime).toFixed(2),
      });

      const error = new Error("Phone number is required");
      error.statusCode = 400;
      throw error;
    }

    const result = await AdminService.sendPhoneOTP(phoneNo);

    AdminLogger.info({
      event: "ADMIN_PHONE_OTP_SENT",
      requestId,
      phone: maskPhone(phoneNo),
      otpId: result.otpId,
      duration_ms: +(performance.now() - startTime).toFixed(2),
    });

    res.status(200).json({
      message: "OTP sent successfully",
      verified: true,
      otpId: result.otpId,
    });
  } catch (err) {
    AdminLogger.error({
      event: "ADMIN_PHONE_OTP_ERROR",
      requestId,
      phone: req.body?.phoneNo ? maskPhone(req.body.phoneNo) : null,
      err,
      duration_ms: +(performance.now() - startTime).toFixed(2),
    });

    if (!err.statusCode) {
      err.statusCode = 500;
    }
    next(err);
  }
};
exports.admin_controller_verify_phoneNo_reset_password = async (req, res, next) => {
  const startTime = performance.now();
  const requestId = req.headers["x-request-id"] || `otp-${Date.now()}`;
  const { phoneNo } = req.body;

  AdminLogger.info({
    event: "ADMIN_PHONE_OTP_STARTED",
    requestId,
    phone: phoneNo ? maskPhone(phoneNo) : null,
  });

  try {
    if (!phoneNo) {
      AdminLogger.warn({
        event: "ADMIN_PHONE_OTP_FAILED",
        reason: "phone_required",
        requestId,
        duration_ms: +(performance.now() - startTime).toFixed(2),
      });

      const error = new Error("Phone number is required");
      error.statusCode = 400;
      throw error;
    }

    const result = await AdminService.sendPasswordResetOTP(phoneNo);

    AdminLogger.info({
      event: "ADMIN_PHONE_OTP_SENT",
      requestId,
      phone: maskPhone(phoneNo),
      otpId: result.otpId,
      duration_ms: +(performance.now() - startTime).toFixed(2),
    });

    res.status(200).json({
      message: "OTP sent successfully",
      verified: true,
      otpId: result.otpId,
    });
  } catch (err) {
    AdminLogger.error({
      event: "ADMIN_PHONE_OTP_ERROR",
      requestId,
      phone: req.body?.phoneNo ? maskPhone(req.body.phoneNo) : null,
      err,
      duration_ms: +(performance.now() - startTime).toFixed(2),
    });

    if (!err.statusCode) {
      err.statusCode = 500;
    }
    next(err);
  }
};
/**
 * Verify OTP for admin
 */
exports.admin_controller_otp = async (req, res, next) => {
  const startTime = performance.now();
  const requestId = req.headers["x-request-id"] || `verify-${Date.now()}`;
  const { otp, otpId } = req.body;

  AdminLogger.info({
    event: "ADMIN_OTP_VERIFY_STARTED",
    requestId,
    otpId: otpId || null,
  });

  try {
    if (!otp || !otpId) {
      AdminLogger.warn({
        event: "ADMIN_OTP_VERIFY_FAILED",
        reason: "missing_fields",
        requestId,
        duration_ms: +(performance.now() - startTime).toFixed(2),
      });

      const error = new Error("OTP and OTP ID are required");
      error.statusCode = 400;
      throw error;
    }

    const result = await AdminService.verifyOTP(otpId, otp);

    AdminLogger.info({
      event: "ADMIN_OTP_VERIFY_SUCCESS",
      requestId,
      otpId,
      verified: result.verified,
      duration_ms: +(performance.now() - startTime).toFixed(2),
    });

    res.status(200).json(result);
  } catch (err) {
    AdminLogger.error({
      event: "ADMIN_OTP_VERIFY_ERROR",
      requestId,
      otpId: req.body?.otpId || null,
      err,
      duration_ms: +(performance.now() - startTime).toFixed(2),
    });

    if (!err.statusCode) {
      err.statusCode = 500;
    }
    next(err);
  }
};

/**
 * Verify OTP for admin
 */
exports.admin_controller_otp_reset_password = async (req, res, next) => {
  const startTime = performance.now();
  const requestId = req.headers["x-request-id"] || `verify-${Date.now()}`;
  const { otp, otpId } = req.body;

  AdminLogger.info({
    event: "ADMIN_OTP_VERIFY_STARTED",
    requestId,
    otpId: otpId || null,
  });

  try {
    if (!otp || !otpId) {
      AdminLogger.warn({
        event: "ADMIN_OTP_VERIFY_FAILED",
        reason: "missing_fields",
        requestId,
        duration_ms: +(performance.now() - startTime).toFixed(2),
      });

      const error = new Error("OTP and OTP ID are required");
      error.statusCode = 400;
      throw error;
    }

    const result = await AdminService.verifyOTPForPasswordReset(otpId, otp);

    AdminLogger.info({
      event: "ADMIN_OTP_VERIFY_SUCCESS",
      requestId,
      otpId,
      verified: result.verified,
      duration_ms: +(performance.now() - startTime).toFixed(2),
    });

    res.status(200).json(result);
  } catch (err) {
    AdminLogger.error({
      event: "ADMIN_OTP_VERIFY_ERROR",
      requestId,
      otpId: req.body?.otpId || null,
      err,
      duration_ms: +(performance.now() - startTime).toFixed(2),
    });

    if (!err.statusCode) {
      err.statusCode = 500;
    }
    next(err);
  }
};

/**
 * Update admin password
 */
exports.admin_controller_patch_password = async (req, res, next) => {
  const startTime = performance.now();
  const requestId = req.headers["x-request-id"] || `password-${Date.now()}`;
  const { password, phoneNo, otpId } = req.body;

  AdminLogger.info({
    event: "ADMIN_PASSWORD_UPDATE_STARTED",
    requestId,
    phoneNo: maskPhone(phoneNo),
    otpId: otpId || null,
  });

  try {
    if (!password || !phoneNo || !otpId) {
      AdminLogger.warn({
        event: "ADMIN_PASSWORD_UPDATE_FAILED",
        reason: "missing_fields",
        requestId,
        duration_ms: +(performance.now() - startTime).toFixed(2),
      });

      const error = new Error("Password, phoneNo, and OTP ID are required");
      error.statusCode = 400;
      throw error;
    }

    // Validate password strength
    const regexPass = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&#])[A-Za-z\d@$!%*?&#]{8,}$/;
    if (!regexPass.test(password)) {
      AdminLogger.warn({
        event: "ADMIN_PASSWORD_UPDATE_FAILED",
        reason: "password_requirements_not_met",
        requestId,
        phoneNo: maskPhone(phoneNo),
        duration_ms: +(performance.now() - startTime).toFixed(2),
      });

      const error = new Error(
        "Password must be at least 8 characters long and contain at least one uppercase letter, one lowercase letter, one number, and one special character",
      );
      error.statusCode = 400;
      throw error;
    }

    const result = await AdminService.updatePassword({
      phoneNo,
      password,
      otpId,
    });

    AdminLogger.info({
      event: "ADMIN_PASSWORD_UPDATED",
      requestId,
      phoneNo: maskPhone(phoneNo),
      duration_ms: +(performance.now() - startTime).toFixed(2),
    });

    res.status(200).json({
      message: "Password changed successfully",
    });
  } catch (err) {
    AdminLogger.error({
      event: "ADMIN_PASSWORD_UPDATE_ERROR",
      requestId,
      phoneNo: maskPhone(phoneNo) || null,
      err,
      duration_ms: +(performance.now() - startTime).toFixed(2),
    });

    if (!err.statusCode) {
      err.statusCode = 500;
    }
    next(err);
  }
};

/**
 * Helper: Mask phone number for logging (PII protection)
 */
const maskPhone = (phone) => {
  if (!phone) return null;
  const str = String(phone).replace(/\s+/g, "");
  if (str.length < 10) return "invalid";
  return str.slice(0, 2) + "******" + str.slice(-2);
};
