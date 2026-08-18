// services/AdminService.js
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { performance } = require("perf_hooks");

const Admin = require("../../models/admin");
const OtpAuth = require("../../models/otpAuth");
const ApiError = require("../utils/ApiError");
const { AdminLogger } = require("../logger/index");
const ENV = require("../config/env");

const axios = require("axios");
class AdminService {
  /**
   * Mask phone number for logging
   */
  static maskPhone(phone) {
    if (!phone) return null;
    const str = String(phone).replace(/\s+/g, "");
    if (str.length < 10) return "invalid";
    return str.slice(0, 2) + "******" + str.slice(-2);
  }

  /**
   * Mask email for logging
   */
  static maskEmail(email) {
    if (!email) return null;
    const parts = email.split("@");
    if (parts.length !== 2) return "invalid";
    const local = parts[0];
    if (local.length <= 2) return `${local}@${parts[1]}`;
    return `${local.slice(0, 2)}***@${parts[1]}`;
  }

  /**
   * Generate OTP
   */
  static generateOTP() {
    return Math.floor(Math.random() * (999999 - 100000 + 1)) + 100000;
  }

  /**
   * ============================================
   * OTP & VERIFICATION
   * ============================================
   */

  /**
   * Send phone OTP
   */
  static async sendPhoneOTP(phoneNo) {
    const admin_phoneNo = ENV.ADMIN_PHONENO;
    const startTime = performance.now();

    const normalizedPhone = String(phoneNo).trim().replace(/\s+/g, "");

    if (normalizedPhone != admin_phoneNo) {
      AdminLogger.warn({
        event: "ADMIN_SEND_OTP_SERVICE_FAILED",
        reason: "not_admin_phoneNo",
        phone: this.maskPhone(normalizedPhone),
      });
      throw ApiError.conflict("Not Admin's Phone number");
    }

    const otpM = String(this.generateOTP());

    // Check if admin exists with this phone
    const existingAdmin = await Admin.findOne({ phoneNo: normalizedPhone })
      .select("_id")
      .lean()
      .maxTimeMS(10000);

    if (existingAdmin) {
      AdminLogger.warn({
        event: "ADMIN_SEND_OTP_SERVICE_FAILED",
        reason: "phone_already_registered",
        phone: this.maskPhone(normalizedPhone),
      });
      throw ApiError.conflict("Phone number already registered!");
    }

    const otpRecord = await OtpAuth.create({
      otp: otpM,
      purpose: "verify_phone",
      accountType: "admin",
      accountId: null,
      target: normalizedPhone,
      verified: false,
      consumedAt: null,
    });

    try {
      // Send SMS via FAST2SMS
      await axios.get(
        `${ENV.FAST2SMS}variables_values=${otpM}&flash=0&numbers=${normalizedPhone}&schedule_time=`,
      );
    } catch (error) {
      await OtpAuth.deleteOne({
        _id: otpRecord._id,
        verified: false,
        consumedAt: null,
      }).catch(() => {});

      AdminLogger.error({
        event: "ADMIN_SEND_OTP_SERVICE_FAILED",
        reason: "sms_gateway_error",
        phone: this.maskPhone(normalizedPhone),
        err: error,
        duration_ms: +(performance.now() - startTime).toFixed(2),
      });

      throw ApiError.internal("Unable to send verification code");
    }

    AdminLogger.info({
      event: "ADMIN_SEND_OTP_SERVICE_SUCCESS",
      phone: this.maskPhone(normalizedPhone),
      otpId: otpRecord._id,
      duration_ms: +(performance.now() - startTime).toFixed(2),
    });

    return {
      otpId: otpRecord._id,
    };
  }

  /**
   * Verify OTP
   */
  static async verifyOTP(otpId, userOtp) {
    const startTime = performance.now();

    if (!mongoose.Types.ObjectId.isValid(otpId)) {
      throw ApiError.badRequest("Invalid OTP ID");
    }

    const result = await OtpAuth.findById(otpId)
      .select("otp purpose accountType target verified consumedAt createdAt")
      .lean()
      .maxTimeMS(10000);

    if (!result) {
      AdminLogger.warn({
        event: "ADMIN_VERIFY_OTP_SERVICE_FAILED",
        reason: "otp_not_found",
        otpId,
      });
      throw ApiError.notFound("Invalid OTP request");
    }

    if (result.accountType !== "admin" || result.purpose !== "verify_phone") {
      AdminLogger.warn({
        event: "ADMIN_VERIFY_OTP_SERVICE_FAILED",
        reason: "invalid_purpose_or_account_type",
        otpId,
        accountType: result.accountType,
        purpose: result.purpose,
      });
      throw ApiError.forbidden("OTP is not valid for this operation");
    }

    if (result.consumedAt) {
      AdminLogger.warn({
        event: "ADMIN_VERIFY_OTP_SERVICE_FAILED",
        reason: "already_consumed",
        otpId,
      });
      throw ApiError.forbidden("OTP has already been used");
    }

    if (result.verified) {
      AdminLogger.warn({
        event: "ADMIN_VERIFY_OTP_SERVICE_FAILED",
        reason: "already_verified",
        otpId,
      });
      throw ApiError.forbidden("OTP has already been verified");
    }

    const isExpired = Date.now() - new Date(result.createdAt).getTime() > 10 * 60 * 1000;

    if (isExpired) {
      await OtpAuth.deleteOne({
        _id: otpId,
        consumedAt: null,
      }).catch(() => {});

      AdminLogger.warn({
        event: "ADMIN_VERIFY_OTP_SERVICE_FAILED",
        reason: "expired",
        otpId,
      });
      throw ApiError.gone("OTP has expired");
    }

    if (String(result.otp) !== String(userOtp)) {
      AdminLogger.warn({
        event: "ADMIN_VERIFY_OTP_SERVICE_FAILED",
        reason: "invalid_otp",
        otpId,
        phone: this.maskPhone(result.target),
      });
      throw ApiError.badRequest("Invalid OTP");
    }

    // Mark OTP as verified
    const verifiedOtp = await OtpAuth.findOneAndUpdate(
      {
        _id: otpId,
        accountType: "admin",
        purpose: "verify_phone",
        verified: false,
        consumedAt: null,
      },
      {
        $set: {
          verified: true,
          verifiedNumber: true,
        },
      },
      {
        new: true,
        maxTimeMS: 10000,
      },
    );

    if (!verifiedOtp) {
      AdminLogger.warn({
        event: "ADMIN_VERIFY_OTP_SERVICE_FAILED",
        reason: "verification_failed",
        otpId,
      });
      throw ApiError.forbidden("OTP cannot be verified");
    }

    AdminLogger.info({
      event: "ADMIN_VERIFY_OTP_SERVICE_SUCCESS",
      phone: this.maskPhone(result.target),
      otpId,
      duration_ms: +(performance.now() - startTime).toFixed(2),
    });

    return {
      verified: true,
      verify: true,
      message: "OTP verified",
    };
  }

  static async sendPasswordResetOTP(phoneNo) {
    const startTime = performance.now();
    const admin_phoneNo = ENV.ADMIN_PHONENO;
    if (!phoneNo) {
      AdminLogger.warn({
        event: "ADMIN_RESET_OTP_SEND_FAILED",
        reason: "phone_required",
        duration_ms: +(performance.now() - startTime).toFixed(2),
      });
      throw ApiError.badRequest("Phone number is required");
    }

    const normalizedPhone = String(phoneNo).trim().replace(/\s+/g, "");
    if (normalizedPhone != admin_phoneNo) {
      AdminLogger.warn({
        event: "ADMIN_SEND_OTP_SERVICE_FAILED",
        reason: "not_admin_phoneNo",
        phone: this.maskPhone(normalizedPhone),
      });
      throw ApiError.conflict("Not Admin's Phone number");
    }
    const admin = await Admin.findOne({
      phoneNo: normalizedPhone,
    })
      .select("_id phoneNo")
      .lean();

    if (!admin) {
      AdminLogger.warn({
        event: "ADMIN_RESET_OTP_SEND_FAILED",
        reason: "admin_not_found",
        phone: this.maskPhone(normalizedPhone),
        duration_ms: +(performance.now() - startTime).toFixed(2),
      });
      throw ApiError.notFound("Admin with this phone number not found");
    }

    const otpM = String(this.generateOTP());

    const otpRecord = await OtpAuth.create({
      otp: otpM,
      purpose: "reset_password",
      accountType: "admin",
      accountId: admin._id,
      target: normalizedPhone,
      verified: false,
      consumedAt: null,
    });

    AdminLogger.debug({
      event: "ADMIN_RESET_OTP_CREATED",
      adminId: admin._id,
      otpId: otpRecord._id,
      phone: this.maskPhone(normalizedPhone),
      duration_ms: +(performance.now() - startTime).toFixed(2),
    });

    try {
      await axios.get(
        `${ENV.FAST2SMS}variables_values=${otpM}&flash=0&numbers=${normalizedPhone}&schedule_time=`,
      );

      AdminLogger.info({
        event: "ADMIN_RESET_OTP_SENT",
        adminId: admin._id,
        phone: this.maskPhone(normalizedPhone),
        otpId: otpRecord._id,
        duration_ms: +(performance.now() - startTime).toFixed(2),
      });
    } catch (error) {
      await OtpAuth.deleteOne({
        _id: otpRecord._id,
        consumedAt: null,
      }).catch((deleteError) => {
        AdminLogger.error({
          event: "ADMIN_RESET_OTP_DELETE_ERROR",
          otpId: otpRecord._id,
          err: deleteError,
          duration_ms: +(performance.now() - startTime).toFixed(2),
        });
      });

      AdminLogger.error({
        event: "ADMIN_RESET_OTP_SEND_FAILED",
        reason: "sms_gateway_error",
        adminId: admin._id,
        phone: this.maskPhone(normalizedPhone),
        err: error,
        duration_ms: +(performance.now() - startTime).toFixed(2),
      });

      throw ApiError.internal("Unable to send verification code");
    }

    return {
      otpId: otpRecord._id,
    };
  }

  static async verifyOTPForPasswordReset(otpId, userOtp) {
    const startTime = performance.now();

    if (!mongoose.Types.ObjectId.isValid(otpId)) {
      throw ApiError.badRequest("Invalid OTP ID");
    }

    const result = await OtpAuth.findById(otpId)
      .select("otp purpose accountType target verified consumedAt createdAt")
      .lean()
      .maxTimeMS(10000);

    if (!result) {
      AdminLogger.warn({
        event: "ADMIN_VERIFY_OTP_SERVICE_FAILED",
        reason: "otp_not_found",
        otpId,
      });
      throw ApiError.notFound("Invalid OTP request");
    }

    if (result.accountType !== "admin" || result.purpose !== "reset_password") {
      AdminLogger.warn({
        event: "ADMIN_VERIFY_OTP_SERVICE_FAILED",
        reason: "invalid_purpose_or_account_type",
        otpId,
        accountType: result.accountType,
        purpose: result.purpose,
      });
      throw ApiError.forbidden("OTP is not valid for this operation");
    }

    if (result.consumedAt) {
      AdminLogger.warn({
        event: "ADMIN_VERIFY_OTP_SERVICE_FAILED",
        reason: "already_consumed",
        otpId,
      });
      throw ApiError.forbidden("OTP has already been used");
    }

    if (result.verified) {
      AdminLogger.warn({
        event: "ADMIN_VERIFY_OTP_SERVICE_FAILED",
        reason: "already_verified",
        otpId,
      });
      throw ApiError.forbidden("OTP has already been verified");
    }

    const isExpired = Date.now() - new Date(result.createdAt).getTime() > 10 * 60 * 1000;

    if (isExpired) {
      await OtpAuth.deleteOne({
        _id: otpId,
        consumedAt: null,
      }).catch(() => {});

      AdminLogger.warn({
        event: "ADMIN_VERIFY_OTP_SERVICE_FAILED",
        reason: "expired",
        otpId,
      });
      throw ApiError.gone("OTP has expired");
    }

    if (String(result.otp) !== String(userOtp)) {
      AdminLogger.warn({
        event: "ADMIN_VERIFY_OTP_SERVICE_FAILED",
        reason: "invalid_otp",
        otpId,
        phone: this.maskPhone(result.target),
      });
      throw ApiError.badRequest("Invalid OTP");
    }

    // Mark OTP as verified
    const verifiedOtp = await OtpAuth.findOneAndUpdate(
      {
        _id: otpId,
        accountType: "admin",
        purpose: "reset_password",
        verified: false,
        consumedAt: null,
      },
      {
        $set: {
          verified: true,
          verifiedNumber: true,
        },
      },
      {
        new: true,
        maxTimeMS: 10000,
      },
    );

    if (!verifiedOtp) {
      AdminLogger.warn({
        event: "ADMIN_VERIFY_OTP_SERVICE_FAILED",
        reason: "verification_failed",
        otpId,
      });
      throw ApiError.forbidden("OTP cannot be verified");
    }

    AdminLogger.info({
      event: "ADMIN_VERIFY_OTP_SERVICE_SUCCESS",
      phone: this.maskPhone(result.target),
      otpId,
      duration_ms: +(performance.now() - startTime).toFixed(2),
    });

    return {
      verified: true,
      verify: true,
      message: "OTP verified",
    };
  }
  /**
   * ============================================
   * PASSWORD UPDATE
   * ============================================
   */
  static async updatePassword({ phoneNo, password, otpId }) {
    const startTime = performance.now();

    // Validate OTP
    if (!mongoose.Types.ObjectId.isValid(otpId)) {
      throw ApiError.badRequest("Invalid OTP ID");
    }

    const otpRecord = await OtpAuth.findById(otpId)
      .select("verified purpose accountType")
      .lean()
      .maxTimeMS(10000);

    if (!otpRecord) {
      AdminLogger.warn({
        event: "ADMIN_PASSWORD_UPDATE_SERVICE_FAILED",
        reason: "otp_not_found",
        otpId,
        phoneNo: this.maskPhone(phoneNo),
      });
      throw ApiError.unauthorized("Not Authorized");
    }

    if (!otpRecord.verified) {
      AdminLogger.warn({
        event: "ADMIN_PASSWORD_UPDATE_SERVICE_FAILED",
        reason: "phoneNo_not_verified",
        otpId,
        phoneNo: this.maskPhone(phoneNo),
      });
      throw ApiError.unauthorized("Not verified Admin");
    }

    if (otpRecord.accountType !== "admin" || otpRecord.purpose !== "reset_password") {
      AdminLogger.warn({
        event: "ADMIN_PASSWORD_UPDATE_SERVICE_FAILED",
        reason: "invalid_purpose",
        otpId,
        purpose: otpRecord.purpose,
      });
      throw ApiError.unauthorized("Not Authorized");
    }

    // Find admin
    const admin = await Admin.findOne({ phoneNo }).select("_id phoneNo").lean().maxTimeMS(10000);

    if (!admin) {
      AdminLogger.warn({
        event: "ADMIN_PASSWORD_UPDATE_SERVICE_FAILED",
        reason: "admin_not_found",
        phoneNo: this.maskPhone(phoneNo),
      });
      throw ApiError.notFound("Admin with this phoneNo not found");
    }

    // Hash new password
    const hashedPassword = await bcrypt.hash(password, 12);

    // Update password
    await Admin.findOneAndUpdate({ phoneNo }, { password: hashedPassword }, { maxTimeMS: 10000 });

    // Consume OTP
    await OtpAuth.findByIdAndUpdate(otpId, { consumedAt: new Date() }, { maxTimeMS: 10000 });

    AdminLogger.info({
      event: "ADMIN_PASSWORD_UPDATE_SERVICE_SUCCESS",
      adminId: admin._id,
      phoneNo: this.maskPhone(phoneNo),
      duration_ms: +(performance.now() - startTime).toFixed(2),
    });

    return {
      message: "Password changed successfully",
    };
  }
}

module.exports = AdminService;
