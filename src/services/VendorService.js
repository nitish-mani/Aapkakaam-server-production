/**
const OtpAuthorizationService = require("./OtpAuthorizationService");
 * VendorService - Core business logic for all vendor operations
 * Follows Single Responsibility Principle
 * All operations are atomic using MongoDB transactions where needed
 */
const User = require("../../models/user");
const Vendor = require("../../models/vendor");
const Bookings = require("../../models/bookings");
const Share = require("../../models/share");
const Attendance = require("../../models/attendance");
const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");
const { default: axios } = require("axios");
const ApiError = require("../utils/ApiError");

const ENV = require("../config/env");
const redisKeys = require("../utils/redisKeys");
const CacheService = require("./CacheService");
const OtpAuth = require("../../models/otpAuth");
const VendorLeaveService = require("./VendorLeaveService");
const OtpAuthorizationService = require("./OtpAuthorizationService");
const { normalizeDateIST } = require("../utils/dateUtils");
const { VendorLogger } = require("../logger/index");

const JOB_COMMISSION = {
  labour: 30,
  mason: 50,
  electrician: 50,
  plumber: 50,
  "ac mechanic": 50,
  "fridge mechanic": 50,
  driver: 50,
  "home tutor": 50,
  "milk man": 50,
  parlour: 50,
  "menhandi maker": 50,
  "pundit ji": 50,
  carpenter: 50,
  "laptop repaire": 50,
  "washer man": 50,
  cook: 50,
  painter: 50,
  "car repaire": 50,
  "bike repaire": 30,
  "tiles fitter": 50,
  "four wheeler": 100,
  lights: 100,
  bus: 200,
  "tent house": 200,
  generator: 100,
  auto: 50,
  dj: 50,
  dhankutti: 50,
  "aata chakki": 50,
  "latrine tank cleaner": 100,
  "marriage hall": 500,
  shuttering: 100,
  waiter: 100,
  "marble fitter": 100,
  "e-riksha": 50,
  "pual cutter": 50,
  ro: 100,
  chaat: 100,
  "dulha rath": 100,
  "kirtan mandli": 100,
  "mini truck": 50,
  "fruit seller": 100,
  "paan wala": 100,
  "bhoonsa pual seller": 100,
};

class VendorService {
  /**
   * ============================================
   * PRIVATE HELPERS
   * ============================================
   */

  /**
   * Mask phone number for logging (PII protection)
   */
  static maskPhone(phone) {
    if (!phone) return null;
    const str = String(phone).replace(/\s+/g, "");
    if (str.length < 10) return "invalid";
    return str.slice(0, 2) + "******" + str.slice(-2);
  }

  /**
   * ============================================
   * OTP & VERIFICATION METHODS
   * ============================================
   */

  /**
   * Generate OTP
   */
  static generateOTP() {
    return Math.floor(Math.random() * (999999 - 100000 + 1)) + 100000;
  }

  /**
   * Send phone OTP via SMS
   */
  static async sendPhoneOTP(phoneNo) {
    const startTime = Date.now();

    if (!phoneNo) {
      VendorLogger.warn({
        event: "OTP_SEND_FAILED",
        reason: "phone_required",
        duration_ms: Date.now() - startTime,
      });
      throw ApiError.badRequest("Phone number is required");
    }

    const normalizedPhone = String(phoneNo).trim().replace(/\s+/g, "");

    if (!normalizedPhone) {
      VendorLogger.warn({
        event: "OTP_SEND_FAILED",
        reason: "phone_required_after_normalization",
        duration_ms: Date.now() - startTime,
      });
      throw ApiError.badRequest("Phone number is required");
    }

    const [existingUser, existingVendor] = await Promise.all([
      User.exists({ phoneNo: normalizedPhone }),
      Vendor.exists({ phoneNo: normalizedPhone }),
    ]);

    if (existingUser || existingVendor) {
      VendorLogger.warn({
        event: "OTP_SEND_FAILED",
        reason: "phone_already_exists",
        phone: this.maskPhone(normalizedPhone),
        existingUser: !!existingUser,
        existingVendor: !!existingVendor,
        duration_ms: Date.now() - startTime,
      });
      throw ApiError.conflict("Mobile number already exists!");
    }

    const otpM = String(this.generateOTP());

    const otpRecord = await OtpAuth.create({
      otp: otpM,
      purpose: "verify_phone",
      accountType: "vendor",
      accountId: null,
      target: normalizedPhone,
      verified: false,
      consumedAt: null,
    });

    try {
      await axios.get(
        `${ENV.FAST2SMS}variables_values=${otpM}&flash=0&numbers=${normalizedPhone}&schedule_time=`,
      );
    } catch (error) {
      await OtpAuth.deleteOne({
        _id: otpRecord._id,
        verified: false,
        consumedAt: null,
      }).catch(() => {});

      VendorLogger.error({
        event: "OTP_SEND_FAILED",
        reason: "sms_gateway_error",
        phone: this.maskPhone(normalizedPhone),
        err: error,
        duration_ms: Date.now() - startTime,
      });

      throw ApiError.internal("Unable to send verification code");
    }

    VendorLogger.info({
      event: "OTP_SENT",
      purpose: "verify_phone",
      accountType: "vendor",
      phone: this.maskPhone(normalizedPhone),
      duration_ms: Date.now() - startTime,
    });

    return {
      otpId: otpRecord._id,
    };
  }

  /**
   * Verify OTP
   */
  static async verifyOTP(otpId, vendorOTP) {
    const startTime = Date.now();

    if (!otpId || !vendorOTP) {
      VendorLogger.warn({
        event: "OTP_VERIFY_FAILED",
        reason: "missing_fields",
        otpId: otpId ? "provided" : "missing",
        otp: vendorOTP ? "provided" : "missing",
        duration_ms: Date.now() - startTime,
      });
      throw ApiError.badRequest("OTP and OTP ID are required");
    }

    if (!mongoose.Types.ObjectId.isValid(otpId)) {
      VendorLogger.warn({
        event: "OTP_VERIFY_FAILED",
        reason: "invalid_otp_id_format",
        otpId,
        duration_ms: Date.now() - startTime,
      });
      throw ApiError.badRequest("Invalid OTP ID");
    }

    const result = await OtpAuth.findById(otpId)
      .select("otp purpose accountType target verified consumedAt createdAt")
      .lean();

    if (!result) {
      VendorLogger.warn({
        event: "OTP_VERIFY_FAILED",
        reason: "otp_not_found",
        otpId,
        duration_ms: Date.now() - startTime,
      });
      throw ApiError.notFound("Invalid OTP request");
    }

    if (result.accountType !== "vendor" || result.purpose !== "verify_phone") {
      VendorLogger.warn({
        event: "OTP_VERIFY_FAILED",
        reason: "invalid_purpose_or_account_type",
        otpId,
        accountType: result.accountType,
        purpose: result.purpose,
        duration_ms: Date.now() - startTime,
      });
      throw ApiError.forbidden("OTP is not valid for this operation");
    }

    if (result.consumedAt) {
      VendorLogger.warn({
        event: "OTP_VERIFY_FAILED",
        reason: "already_consumed",
        otpId,
        consumedAt: result.consumedAt,
        duration_ms: Date.now() - startTime,
      });
      throw ApiError.forbidden("OTP has already been used");
    }

    if (result.verified) {
      VendorLogger.warn({
        event: "OTP_VERIFY_FAILED",
        reason: "already_verified",
        otpId,
        duration_ms: Date.now() - startTime,
      });
      throw ApiError.forbidden("OTP has already been verified");
    }

    const isExpired = Date.now() - new Date(result.createdAt).getTime() > 10 * 60 * 1000;

    if (isExpired) {
      await OtpAuth.deleteOne({
        _id: otpId,
        consumedAt: null,
      }).catch((err) => {
        VendorLogger.error({
          event: "OTP_DELETE_ERROR",
          otpId,
          err,
          duration_ms: Date.now() - startTime,
        });
      });

      VendorLogger.warn({
        event: "OTP_VERIFY_FAILED",
        reason: "expired",
        otpId,
        createdAt: result.createdAt,
        duration_ms: Date.now() - startTime,
      });
      throw ApiError.gone("OTP has expired");
    }

    if (String(result.otp) !== String(vendorOTP)) {
      VendorLogger.warn({
        event: "OTP_VERIFY_FAILED",
        reason: "invalid_otp",
        otpId,
        phone: this.maskPhone(result.target),
        duration_ms: Date.now() - startTime,
      });
      throw ApiError.badRequest("Invalid OTP");
    }

    const verifiedOtp = await OtpAuth.findOneAndUpdate(
      {
        _id: otpId,
        accountType: "vendor",
        purpose: "verify_phone",
        verified: false,
        consumedAt: null,
      },
      {
        $set: {
          verified: true,
        },
      },
      {
        new: true,
      },
    );

    if (!verifiedOtp) {
      VendorLogger.warn({
        event: "OTP_VERIFY_FAILED",
        reason: "verification_failed",
        otpId,
        duration_ms: Date.now() - startTime,
      });
      throw ApiError.forbidden("OTP cannot be verified");
    }

    VendorLogger.info({
      event: "OTP_VERIFIED",
      purpose: "verify_phone",
      accountType: "vendor",
      phone: this.maskPhone(result.target),
      duration_ms: Date.now() - startTime,
    });

    return {
      verified: true,
      otpId: verifiedOtp._id,
    };
  }

  static async sendPasswordResetOTP(phoneNo) {
    const startTime = Date.now();

    if (!phoneNo) {
      VendorLogger.warn({
        event: "RESET_OTP_SEND_FAILED",
        reason: "phone_required",
        duration_ms: Date.now() - startTime,
      });
      throw ApiError.badRequest("Phone number is required");
    }

    const normalizedPhone = String(phoneNo).trim().replace(/\s+/g, "");

    const vendor = await Vendor.findOne({
      phoneNo: normalizedPhone,
    })
      .select("_id phoneNo")
      .lean();

    if (!vendor) {
      VendorLogger.warn({
        event: "RESET_OTP_SEND_FAILED",
        reason: "vendor_not_found",
        phone: this.maskPhone(normalizedPhone),
        duration_ms: Date.now() - startTime,
      });
      throw ApiError.notFound("Vendor with this phone number not found");
    }

    const otpM = String(this.generateOTP());

    const otpRecord = await OtpAuth.create({
      otp: otpM,
      purpose: "reset_password",
      accountType: "vendor",
      accountId: vendor._id,
      target: normalizedPhone,
      verified: false,
      consumedAt: null,
    });

    try {
      await axios.get(
        `${ENV.FAST2SMS}variables_values=${otpM}&flash=0&numbers=${normalizedPhone}&schedule_time=`,
      );
    } catch (error) {
      await OtpAuth.deleteOne({
        _id: otpRecord._id,
        consumedAt: null,
      }).catch(() => {});

      VendorLogger.error({
        event: "RESET_OTP_SEND_FAILED",
        reason: "sms_gateway_error",
        phone: this.maskPhone(normalizedPhone),
        vendorId: vendor._id,
        err: error,
        duration_ms: Date.now() - startTime,
      });

      throw ApiError.internal("Unable to send verification code");
    }

    VendorLogger.info({
      event: "RESET_OTP_SENT",
      purpose: "reset_password",
      accountType: "vendor",
      vendorId: vendor._id,
      phone: this.maskPhone(normalizedPhone),
      duration_ms: Date.now() - startTime,
    });

    return {
      otpId: otpRecord._id,
    };
  }
  static async verifyOTPForPasswordReset(otpId, vendorOTP) {
    const startTime = Date.now();

    if (!otpId || !vendorOTP) {
      VendorLogger.warn({
        event: "OTP_VERIFY_FAILED",
        reason: "missing_fields",
        otpId: otpId ? "provided" : "missing",
        otp: vendorOTP ? "provided" : "missing",
        duration_ms: Date.now() - startTime,
      });
      throw ApiError.badRequest("OTP and OTP ID are required");
    }

    if (!mongoose.Types.ObjectId.isValid(otpId)) {
      VendorLogger.warn({
        event: "OTP_VERIFY_FAILED",
        reason: "invalid_otp_id_format",
        otpId,
        duration_ms: Date.now() - startTime,
      });
      throw ApiError.badRequest("Invalid OTP ID");
    }

    const result = await OtpAuth.findById(otpId)
      .select("otp purpose accountType target verified consumedAt createdAt")
      .lean();

    if (!result) {
      VendorLogger.warn({
        event: "OTP_VERIFY_FAILED",
        reason: "otp_not_found",
        otpId,
        duration_ms: Date.now() - startTime,
      });
      throw ApiError.notFound("Invalid OTP request");
    }

    if (result.accountType !== "vendor" || result.purpose !== "reset_password") {
      VendorLogger.warn({
        event: "OTP_VERIFY_FAILED",
        reason: "invalid_purpose_or_account_type",
        otpId,
        accountType: result.accountType,
        purpose: result.purpose,
        duration_ms: Date.now() - startTime,
      });
      throw ApiError.forbidden("OTP is not valid for this operation");
    }

    if (result.consumedAt) {
      VendorLogger.warn({
        event: "OTP_VERIFY_FAILED",
        reason: "already_consumed",
        otpId,
        consumedAt: result.consumedAt,
        duration_ms: Date.now() - startTime,
      });
      throw ApiError.forbidden("OTP has already been used");
    }

    if (result.verified) {
      VendorLogger.warn({
        event: "OTP_VERIFY_FAILED",
        reason: "already_verified",
        otpId,
        duration_ms: Date.now() - startTime,
      });
      throw ApiError.forbidden("OTP has already been verified");
    }

    const isExpired = Date.now() - new Date(result.createdAt).getTime() > 10 * 60 * 1000;

    if (isExpired) {
      await OtpAuth.deleteOne({
        _id: otpId,
        consumedAt: null,
      }).catch((err) => {
        VendorLogger.error({
          event: "OTP_DELETE_ERROR",
          otpId,
          err,
          duration_ms: Date.now() - startTime,
        });
      });

      VendorLogger.warn({
        event: "OTP_VERIFY_FAILED",
        reason: "expired",
        otpId,
        createdAt: result.createdAt,
        duration_ms: Date.now() - startTime,
      });
      throw ApiError.gone("OTP has expired");
    }

    if (String(result.otp) !== String(vendorOTP)) {
      VendorLogger.warn({
        event: "OTP_VERIFY_FAILED",
        reason: "invalid_otp",
        otpId,
        phone: this.maskPhone(result.target),
        duration_ms: Date.now() - startTime,
      });
      throw ApiError.badRequest("Invalid OTP");
    }

    const verifiedOtp = await OtpAuth.findOneAndUpdate(
      {
        _id: otpId,
        accountType: "vendor",
        purpose: "reset_password",
        verified: false,
        consumedAt: null,
      },
      {
        $set: {
          verified: true,
        },
      },
      {
        new: true,
      },
    );

    if (!verifiedOtp) {
      VendorLogger.warn({
        event: "OTP_VERIFY_FAILED",
        reason: "verification_failed",
        otpId,
        duration_ms: Date.now() - startTime,
      });
      throw ApiError.forbidden("OTP cannot be verified");
    }

    VendorLogger.info({
      event: "OTP_VERIFIED",
      purpose: "verify_phone",
      accountType: "vendor",
      phone: this.maskPhone(result.target),
      duration_ms: Date.now() - startTime,
    });

    return {
      verified: true,
      otpId: verifiedOtp._id,
    };
  }
  /**
   * ============================================
   * PROFILE UPDATE METHODS
   * ============================================
   */

  /**
   * Update vendor password
   */
  static async updatePassword(phoneNo, password, otpId) {
    const startTime = Date.now();

    if (!phoneNo || !password || !otpId) {
      VendorLogger.warn({
        event: "PASSWORD_UPDATE_FAILED",
        reason: "missing_fields",
        phone: this.maskPhone(phoneNo),
        otpId: otpId ? "provided" : "missing",
        duration_ms: Date.now() - startTime,
      });
      throw ApiError.badRequest("Phone number, password, and OTP ID are required");
    }

    if (password.length < 6) {
      VendorLogger.warn({
        event: "PASSWORD_UPDATE_FAILED",
        reason: "password_too_short",
        phone: this.maskPhone(phoneNo),
        duration_ms: Date.now() - startTime,
      });
      throw ApiError.badRequest("Password must be at least 6 characters long");
    }

    const normalizedPhone = String(phoneNo).trim().replace(/\s+/g, "");

    const vendor = await Vendor.findOne({
      phoneNo: normalizedPhone,
    }).select("_id");

    if (!vendor) {
      VendorLogger.warn({
        event: "PASSWORD_UPDATE_FAILED",
        reason: "vendor_not_found",
        phone: this.maskPhone(normalizedPhone),
        duration_ms: Date.now() - startTime,
      });
      throw ApiError.forbidden("Invalid, expired, already used, or mismatched verification");
    }

    await OtpAuthorizationService.consume({
      otpId,
      accountType: "vendor",
      accountId: vendor._id,
      purpose: "reset_password",
      target: normalizedPhone,
    });

    const hashPass = await bcrypt.hash(password, 12);

    await Vendor.updateOne(
      { _id: vendor._id },
      {
        $set: {
          password: hashPass,
        },
      },
    );

    VendorLogger.info({
      event: "PASSWORD_UPDATED",
      vendorId: vendor._id,
      phone: this.maskPhone(normalizedPhone),
      duration_ms: Date.now() - startTime,
    });

    return {
      message: "Password changed successfully",
    };
  }

  /**
   * Update vendor address
   */
  static async updateAddress(vendorId, addressData) {
    const startTime = Date.now();
    const { vill, post, dist, state, pincode } = addressData;

    if (!vendorId) {
      VendorLogger.warn({
        event: "ADDRESS_UPDATE_FAILED",
        reason: "vendor_id_required",
        duration_ms: Date.now() - startTime,
      });
      throw ApiError.badRequest("Vendor ID is required");
    }

    const address = { vill, post, dist, state, pincode };
    const loadedVendor = await Vendor.findByIdAndUpdate(
      vendorId,
      { address: [address], pincode },
      { new: true },
    );

    if (!loadedVendor) {
      VendorLogger.warn({
        event: "ADDRESS_UPDATE_FAILED",
        reason: "vendor_not_found",
        vendorId,
        duration_ms: Date.now() - startTime,
      });
      throw ApiError.notFound("Could not find Vendor.");
    }

    VendorLogger.info({
      event: "ADDRESS_UPDATED",
      vendorId,
      pincode,
      duration_ms: Date.now() - startTime,
    });

    return {
      address: loadedVendor.address,
      message: "Address Updated Successfully",
    };
  }

  /**
   * Update vendor name
   */
  static async updateName(vendorId, name) {
    const startTime = Date.now();

    if (!vendorId) {
      VendorLogger.warn({
        event: "NAME_UPDATE_FAILED",
        reason: "vendor_id_required",
        duration_ms: Date.now() - startTime,
      });
      throw ApiError.badRequest("Vendor ID is required");
    }

    const loadedVendor = await Vendor.findByIdAndUpdate(vendorId, { name }, { new: true });

    if (!loadedVendor) {
      VendorLogger.warn({
        event: "NAME_UPDATE_FAILED",
        reason: "vendor_not_found",
        vendorId,
        duration_ms: Date.now() - startTime,
      });
      throw ApiError.notFound("Could not find Vendor.");
    }

    VendorLogger.info({
      event: "NAME_UPDATED",
      vendorId,
      duration_ms: Date.now() - startTime,
    });

    return {
      name: loadedVendor.name,
      message: "Name Updated Successfully",
    };
  }

  /**
   * Update vendor FCM token
   */
  static async updateFcmToken(vendorId, fcmToken) {
    const startTime = Date.now();

    if (!vendorId) {
      VendorLogger.warn({
        event: "FCM_UPDATE_FAILED",
        reason: "vendor_id_required",
        duration_ms: Date.now() - startTime,
      });
      throw ApiError.badRequest("Vendor ID is required");
    }

    const loadedVendor = await Vendor.findByIdAndUpdate(vendorId, { fcmToken }, { new: true });

    if (!loadedVendor) {
      VendorLogger.warn({
        event: "FCM_UPDATE_FAILED",
        reason: "vendor_not_found",
        vendorId,
        duration_ms: Date.now() - startTime,
      });
      throw ApiError.notFound("Could not find Vendor.");
    }

    VendorLogger.info({
      event: "FCM_UPDATED",
      vendorId,
      hasToken: !!fcmToken,
      duration_ms: Date.now() - startTime,
    });

    return {
      fcmToken: loadedVendor.fcmToken,
      message: "fcmToken Updated Successfully",
    };
  }

  /**
   * Update vendor wage rate
   */
  static async updateWageRate(vendorId, wageRate, wageRateType) {
    const startTime = Date.now();

    if (!vendorId) {
      VendorLogger.warn({
        event: "WAGE_RATE_UPDATE_FAILED",
        reason: "vendor_id_required",
        duration_ms: Date.now() - startTime,
      });
      throw ApiError.badRequest("Vendor ID is required");
    }

    const loadedVendor = await Vendor.findByIdAndUpdate(
      vendorId,
      { wageRate, wageRateType },
      { new: true },
    );

    if (!loadedVendor) {
      VendorLogger.warn({
        event: "WAGE_RATE_UPDATE_FAILED",
        reason: "vendor_not_found",
        vendorId,
        duration_ms: Date.now() - startTime,
      });
      throw ApiError.notFound("Could not find Vendor.");
    }

    VendorLogger.info({
      event: "WAGE_RATE_UPDATED",
      vendorId,
      wageRate,
      wageRateType,
      duration_ms: Date.now() - startTime,
    });

    return {
      wageRate: loadedVendor.wageRate,
      wageRateType: loadedVendor.wageRateType,
      message: "Wage Rate Updated Successfully",
    };
  }

  /**
   * ============================================
   * DATA RETRIEVAL METHODS
   * ============================================
   */

  /**
   * Get vendor orders
   */
  static async getVendorOrders(vendorId) {
    const startTime = Date.now();
    console.log(vendorId);
    if (!vendorId) {
      VendorLogger.warn({
        event: "VENDOR_ORDERS_FAILED",
        reason: "vendor_id_required",
        duration_ms: Date.now() - startTime,
      });
      throw ApiError.badRequest("Vendor ID is required");
    }

    const bookings = await Bookings.find({ vendorId }).sort({ bookedOn: -1 }).lean();

    VendorLogger.info({
      event: "VENDOR_ORDERS_RETRIEVED",
      vendorId,
      orderCount: bookings.length,
      duration_ms: Date.now() - startTime,
    });
    console.log(bookings);
    return { orders: bookings };
  }

  /**
   * Get vendor shares with pagination
   */
  static async getVendorShares(vendorId, skipParam) {
    const startTime = Date.now();

    if (!vendorId) {
      VendorLogger.warn({
        event: "VENDOR_SHARES_FAILED",
        reason: "vendor_id_required",
        duration_ms: Date.now() - startTime,
      });

      throw ApiError.badRequest("Vendor ID is required");
    }

    const limit = 12;

    let skip = Number.parseInt(skipParam, 10);

    if (!Number.isFinite(skip) || skip < 0) {
      skip = 0;
    }

    // Get total first so we can validate skip.
    const total = await Share.countDocuments({ vendorId });

    // No records
    if (total === 0) {
      VendorLogger.info({
        event: "VENDOR_SHARES_RETRIEVED",
        vendorId,
        shareCount: 0,
        total: 0,
        skip: 0,
        duration_ms: Date.now() - startTime,
      });

      return {
        share: [],
        total: 0,
      };
    }

    // If requested page is beyond the available data,
    // move to the last valid page.
    if (skip >= total) {
      skip = Math.max(0, Math.floor((total - 1) / limit) * limit);
    }

    const shares = await Share.find({ vendorId })
      .sort({ shareDate: -1, _id: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    VendorLogger.info({
      event: "VENDOR_SHARES_RETRIEVED",
      vendorId,
      shareCount: shares.length,
      total,
      skip,
      limit,
      duration_ms: Date.now() - startTime,
    });
    return {
      share: shares,
      total,
    };
  }

  /**
   * Get vendor bookings by month/year
   */
  static async getVendorBookingsByMonth(vendorId, year, month) {
    const startTime = Date.now();

    if (!vendorId) {
      VendorLogger.warn({
        event: "VENDOR_BOOKINGS_BY_MONTH_FAILED",
        reason: "vendor_id_required",
        duration_ms: Date.now() - startTime,
      });
      throw ApiError.badRequest("Vendor ID is required");
    }

    const parsedYear = Number(year);
    const parsedMonth = Number(month);

    if (
      Number.isNaN(parsedYear) ||
      Number.isNaN(parsedMonth) ||
      parsedMonth < 0 ||
      parsedMonth > 11
    ) {
      VendorLogger.warn({
        event: "VENDOR_BOOKINGS_BY_MONTH_FAILED",
        reason: "invalid_date_parameters",
        vendorId,
        year,
        month,
        duration_ms: Date.now() - startTime,
      });
      throw ApiError.badRequest("Invalid year or month. Month must be between 0 and 11.");
    }

    const startDate = new Date(parsedYear, parsedMonth, 1);
    startDate.setHours(0, 0, 0, 0);

    const endDate = new Date(parsedYear, parsedMonth + 1, 1);
    endDate.setHours(0, 0, 0, 0);

    const bookings = await Bookings.find({
      vendorId,
      bookingDate: {
        $gte: startDate,
        $lt: endDate,
      },
    })
      .populate("bookedById", "name phoneNo address")
      .sort({ bookingDate: 1 })
      .lean();

    VendorLogger.info({
      event: "VENDOR_BOOKINGS_BY_MONTH_RETRIEVED",
      vendorId,
      year: parsedYear,
      month: parsedMonth,
      bookingCount: bookings.length,
      duration_ms: Date.now() - startTime,
    });
    return bookings;
  }

  /**
   * Get vendor details
   */
  static async getVendorDetails(vendorId) {
    const startTime = Date.now();

    if (!vendorId) {
      VendorLogger.warn({
        event: "VENDOR_DETAILS_FAILED",
        reason: "vendor_id_required",
        duration_ms: Date.now() - startTime,
      });
      throw ApiError.badRequest("Vendor ID is required");
    }

    const loadedVendor = await Vendor.findOne({ _id: vendorId })
      .select("rating ratingCount balance earning pending completed canceled")
      .lean();

    if (!loadedVendor) {
      VendorLogger.warn({
        event: "VENDOR_DETAILS_FAILED",
        reason: "vendor_not_found",
        vendorId,
        duration_ms: Date.now() - startTime,
      });
      throw ApiError.notFound("Could not find Vendor.");
    }

    VendorLogger.info({
      event: "VENDOR_DETAILS_RETRIEVED",
      vendorId,
      rating: loadedVendor.rating,
      balance: loadedVendor.balance,
      earning: loadedVendor.earning,
      duration_ms: Date.now() - startTime,
    });

    return {
      rating: loadedVendor.rating,
      ratingCount: loadedVendor.ratingCount,
      balance: loadedVendor.balance,
      earning: loadedVendor.earning,
      stats: {
        pending: loadedVendor.pending,
        completed: loadedVendor.completed,
        canceled: loadedVendor.canceled,
      },
    };
  }

  /**
   * Get single vendor
   */
  static async getVendor(vendorId) {
    const startTime = Date.now();

    if (!vendorId) {
      VendorLogger.warn({
        event: "GET_VENDOR_FAILED",
        reason: "vendor_id_required",
        duration_ms: Date.now() - startTime,
      });
      throw ApiError.badRequest("Vendor ID is required");
    }

    const result = await Vendor.findOne({ _id: vendorId }).lean();

    if (!result) {
      VendorLogger.warn({
        event: "GET_VENDOR_FAILED",
        reason: "vendor_not_found",
        vendorId,
        duration_ms: Date.now() - startTime,
      });
      throw ApiError.notFound("Could not find Vendor.");
    }

    VendorLogger.info({
      event: "GET_VENDOR_SUCCESS",
      vendorId,
      type: result.type,
      duration_ms: Date.now() - startTime,
    });

    return result;
  }

  /**
   * Get vendor earnings
   */
  static async getVendorEarnings(vendorId) {
    const startTime = Date.now();

    if (!vendorId) {
      VendorLogger.warn({
        event: "VENDOR_EARNINGS_FAILED",
        reason: "vendor_id_required",
        duration_ms: Date.now() - startTime,
      });
      throw ApiError.badRequest("Vendor ID is required");
    }

    const result = await Vendor.findOne({ _id: vendorId })
      .select("earning pendingShareBy completedShareBy canceledShareBy shareCount")
      .lean();

    if (!result) {
      VendorLogger.warn({
        event: "VENDOR_EARNINGS_FAILED",
        reason: "vendor_not_found",
        vendorId,
        duration_ms: Date.now() - startTime,
      });
      throw ApiError.notFound("Could not find Vendor.");
    }

    VendorLogger.info({
      event: "VENDOR_EARNINGS_RETRIEVED",
      vendorId,
      earning: result.earning,
      shareCount: result.shareCount,
      duration_ms: Date.now() - startTime,
    });

    return result;
  }

  /**
   * Get available vendors with smart pagination
   */

  static async getAvailableVendors(type, pincode, bookingDate1, page, minRating, minWageRate) {
    const startTime = Date.now();

    // ============================================================
    // NORMALIZE INPUT
    // ============================================================

    const normalizedType = String(type || "").trim();
    const normalizedPincode = String(pincode || "").trim();

    const currentPage = Math.max(Number.parseInt(page, 10) || 1, 1);

    const normalizedMinRating = Number.isFinite(Number(minRating)) ? Number(minRating) : 0;

    const normalizedMinWageRate = Number.isFinite(Number(minWageRate)) ? Number(minWageRate) : 0;

    // ============================================================
    // NORMALIZE DATE
    // ============================================================

    const bookingDate = normalizeDateIST(bookingDate1);

    if (!normalizedType || !normalizedPincode || !bookingDate) {
      throw ApiError.badRequest("Type, pincode, and booking date are required");
    }

    const cacheDate = bookingDate.toISOString().slice(0, 10);

    // ============================================================
    // PAGINATION
    // ============================================================

    const limit = 12;

    const skip = (currentPage - 1) * limit;

    // ============================================================
    // COMMISSION
    // ============================================================

    const commission = this.getCommission(normalizedType);

    // ============================================================
    // FINAL RESULT CACHE
    //
    // This prevents MongoDB from being hit repeatedly for
    // identical searches.
    //
    // Short TTL keeps availability reasonably fresh.
    // ============================================================

    const resultCacheKey = [
      "vendor-search",
      normalizedType,
      normalizedPincode,
      cacheDate,
      currentPage,
      normalizedMinRating,
      normalizedMinWageRate,
    ].join(":");

    // ============================================================
    // COMPLETE SEARCH CACHE
    // ============================================================

    const result = await CacheService.remember(
      resultCacheKey,
      15,

      async () => {
        // ======================================================
        // UNAVAILABLE VENDORS
        // ======================================================

        const unavailableCacheKey = redisKeys.UNAVAILABLE_VENDOR_IDS(
          normalizedType,
          normalizedPincode,
          cacheDate,
        );

        const unavailableVendorIds = await CacheService.remember(
          unavailableCacheKey,
          30,

          async () => {
            const [bookedVendorIds, leaveVendorIds] = await Promise.all([
              // ------------------------------------------------
              // ACTIVE BOOKINGS
              // ------------------------------------------------

              Bookings.distinct("vendorId", {
                // type: normalizedType,

                pincode: normalizedPincode,

                bookingDate,

                cancelOrder: {
                  $ne: true,
                },

                orderCompleted: {
                  $ne: true,
                },
              }),

              // ------------------------------------------------
              // LEAVE
              // ------------------------------------------------

              VendorLeaveService.getUnavailableVendorIds(bookingDate),
            ]);

            return [
              ...new Set([
                ...bookedVendorIds.map((id) => id.toString()),

                ...leaveVendorIds.map((id) => id.toString()),
              ]),
            ];
          },

          {
            tags: ["vendors", "availability"],
          },
        );

        // ======================================================
        // CONVERT IDS
        // ======================================================

        const excludedObjectIds = unavailableVendorIds
          .filter((id) => mongoose.Types.ObjectId.isValid(id))
          .map((id) => new mongoose.Types.ObjectId(id));

        // ======================================================
        // BASE VENDOR FILTER
        // ======================================================
        //
        // IMPORTANT:
        //
        // wageRate is now an array.
        //
        // Therefore we CANNOT do:
        //
        // wageRate: { $gte: minWageRate }
        //
        // because that does not guarantee that the wage belongs
        // to the requested job.
        //
        // We filter the requested job using type first and then
        // match its corresponding wageRate in Node.
        //
        // ======================================================

        const baseMatchStage = {
          type: normalizedType,

          pincode: normalizedPincode,

          status: "active",

          balance: {
            $gte: commission,
          },

          rating: {
            $gte: normalizedMinRating,
          },
        };

        // --------------------------------------------------------
        // Exclude unavailable vendors
        // --------------------------------------------------------

        if (excludedObjectIds.length > 0) {
          baseMatchStage._id = {
            $nin: excludedObjectIds,
          };
        }

        // ======================================================
        // FETCH CANDIDATES
        // ======================================================
        //
        // Keep this deliberately small.
        //
        // We don't need 100+ documents for a 12-item response.
        //
        // ======================================================

        const candidates = await Vendor.find(baseMatchStage)
          .select({
            _id: 1,
            name: 1,
            type: 1,
            gender: 1,
            phoneNo: 1,
            rating: 1,
            ratingCount: 1,
            wageRate: 1,
            wageRateType: 1,
            imgURL: 1,
            completedVendor: 1,
            experience: 1,
            isVerified: 1,
            status: 1,
          })
          .sort({
            isVerified: -1,
            rating: -1,
            completedVendor: -1,
            _id: 1,
          })
          .limit(60)
          .lean();

        // ======================================================
        // MATCH CORRECT JOB + WAGE
        // ======================================================

        const matchingCandidates = candidates.filter((vendor) => {
          const jobs = Array.isArray(vendor.type) ? vendor.type : [];

          const rates = Array.isArray(vendor.wageRate) ? vendor.wageRate : [];

          const rateTypes = Array.isArray(vendor.wageRateType) ? vendor.wageRateType : [];

          // ------------------------------------------------
          // Find requested job index
          // ------------------------------------------------

          const jobIndex = jobs.indexOf(normalizedType);

          if (jobIndex === -1) {
            return false;
          }

          // ------------------------------------------------
          // Get rate for THIS job
          // ------------------------------------------------

          const rate = Number(rates[jobIndex] ?? 0);

          // ------------------------------------------------
          // Wage filter
          // ------------------------------------------------

          if (rate < normalizedMinWageRate) {
            return false;
          }

          // ------------------------------------------------
          // Keep arrays temporarily for formatting
          // ------------------------------------------------

          vendor._matchedJobIndex = jobIndex;

          vendor._matchedRate = rate;

          vendor._matchedRateType = rateTypes[jobIndex] ?? "";

          return true;
        });

        // ======================================================
        // PAGINATION
        // ======================================================

        const vendors = matchingCandidates.slice(skip, skip + limit);

        // ======================================================
        // FORMAT RESPONSE
        // ======================================================

        const formattedVendors = vendors.map((vendor) => {
          const jobIndex = vendor._matchedJobIndex;

          return {
            _id: vendor._id,

            name: vendor.name,

            // Return ONLY requested job.
            type: normalizedType,

            gender: vendor.gender || "",

            phoneNo: vendor.phoneNo
              ? vendor.phoneNo.toString().replace(/(\d{2})\d{6}(\d{2})/, "$1******$2")
              : "",

            rating: vendor.rating || 0,

            ratingCount: vendor.ratingCount || 0,

            // ------------------------------------------------
            // Selected job's wage
            // ------------------------------------------------

            wageRate: vendor._matchedRate ?? 0,

            wageRateType: vendor._matchedRateType || "",

            imgURL: vendor.imgURL || null,

            completedVendor: vendor.completedVendor || 0,

            experience: vendor.experience || 0,

            isVerified: !!vendor.isVerified,

            status: vendor.status || "active",
          };
        });

        // ======================================================
        // REMOVE INTERNAL FIELDS
        // ======================================================

        for (const vendor of matchingCandidates) {
          delete vendor._matchedJobIndex;
          delete vendor._matchedRate;
          delete vendor._matchedRateType;
        }

        // ======================================================
        // TOTAL
        // ======================================================
        //
        // We intentionally DON'T run countDocuments().
        //
        // For a high-RPS search API, an additional count query
        // for every cache miss is unnecessary load.
        //
        // We use the candidate pool as the search window.
        //
        // ======================================================

        const total = matchingCandidates.length;

        return {
          total,

          vendors: formattedVendors,

          freshData: formattedVendors.length > 0,

          currentPage,

          totalPages: Math.ceil(total / limit),

          hasNextPage: skip + formattedVendors.length < total,
        };
      },

      {
        tags: ["vendors", "search", normalizedType, normalizedPincode],
      },
    );

    // ============================================================
    // DEVELOPMENT LOGGING ONLY
    // ============================================================

    if (process.env.NODE_ENV !== "production") {
      VendorLogger.info({
        event: "AVAILABLE_VENDORS_RETRIEVED",

        type: normalizedType,

        pincode: normalizedPincode,

        bookingDate: cacheDate,

        returnedCount: result.vendors.length,

        currentPage,

        duration_ms: Date.now() - startTime,
      });
    }

    return result;
  }

  /**
   * ============================================
   * ATTENDANCE METHODS
   * ============================================
   */

  /**
   * Get attendance records
   */
  static async getAttendance(vendorId, month, year) {
    const startTime = Date.now();

    if (!vendorId || !mongoose.Types.ObjectId.isValid(vendorId)) {
      VendorLogger.warn({
        event: "ATTENDANCE_GET_FAILED",
        reason: "invalid_vendor_id",
        vendorId,
        duration_ms: Date.now() - startTime,
      });
      throw ApiError.badRequest("Valid Vendor ID is required");
    }

    const monthNum = parseInt(month);
    const yearNum = parseInt(year);

    if (isNaN(monthNum) || monthNum < 1 || monthNum > 12) {
      VendorLogger.warn({
        event: "ATTENDANCE_GET_FAILED",
        reason: "invalid_month",
        vendorId,
        month,
        duration_ms: Date.now() - startTime,
      });
      throw ApiError.badRequest("Month must be between 1 and 12");
    }

    if (isNaN(yearNum) || yearNum < 2000 || yearNum > 2100) {
      VendorLogger.warn({
        event: "ATTENDANCE_GET_FAILED",
        reason: "invalid_year",
        vendorId,
        year,
        duration_ms: Date.now() - startTime,
      });
      throw ApiError.badRequest("Year must be between 2000 and 2100");
    }

    const vendor = await Vendor.findById(vendorId).select("accountCreatedOn").lean();
    if (!vendor) {
      VendorLogger.warn({
        event: "ATTENDANCE_GET_FAILED",
        reason: "vendor_not_found",
        vendorId,
        duration_ms: Date.now() - startTime,
      });
      throw ApiError.notFound("Vendor not found");
    }

    const accountCreatedOn = new Date(vendor.accountCreatedOn);
    accountCreatedOn.setHours(0, 0, 0, 0);

    const startDate = new Date(yearNum, monthNum - 1, 1);
    const endDate = new Date(yearNum, monthNum, 0, 23, 59, 59, 999);
    const currentDate = new Date();
    currentDate.setHours(0, 0, 0, 0);

    const effectiveStartDate = new Date(Math.max(startDate.getTime(), accountCreatedOn.getTime()));
    const effectiveEndDate = new Date(Math.min(endDate.getTime(), currentDate.getTime()));
    effectiveStartDate.setHours(0, 0, 0, 0);
    effectiveEndDate.setHours(23, 59, 59, 999);

    const totalValidDays = this.calculateDaysBetween(effectiveStartDate, effectiveEndDate);

    const attendanceRecords = await Attendance.find({
      vendorId: new mongoose.Types.ObjectId(vendorId),
      $or: [
        {
          presentDate: {
            $gte: startDate.toISOString().split("T")[0],
            $lte: endDate.toISOString().split("T")[0],
          },
        },
        { presentDate: { $gte: startDate.getTime(), $lte: endDate.getTime() } },
        { presentDate: { $gte: startDate, $lte: endDate } },
      ],
    })
      .populate("userId", "name")
      .populate("vendorId", "name")
      .sort({ presentDate: 1 })
      .lean()
      .maxTimeMS(30000);

    const processedRecords = attendanceRecords.map((record) => {
      const date = normalizeDateIST(record.presentDate);
      const status = this.determineAttendanceStatus(record);
      return {
        ...record,
        presentDate: date ? date.toISOString() : record.presentDate,
        date: date ? date.toISOString().split("T")[0] : null,
        day: date ? date.getDate() : null,
        dayOfWeek: date ? date.getDay() : null,
        status,
        markedAbsent: record.markedAbsent || false,
        isWithinValidPeriod: date
          ? this.isDateInRange(date, effectiveStartDate, effectiveEndDate)
          : false,
      };
    });

    const validRecords = processedRecords.filter((record) => record.isWithinValidPeriod);
    const presentRecords = validRecords.filter((record) => record.status === "present");
    const absentRecords = validRecords.filter((record) => record.status === "absent");

    const totalTime = presentRecords.reduce((total, record) => total + (record.totalTime || 0), 0);
    const pageNo1Completed = validRecords.filter((record) => record.pageNo1 === true).length;
    const pageNo2Completed = validRecords.filter((record) => record.pageNo2 === true).length;
    const pageNo3Completed = validRecords.filter((record) => record.pageNo3 === true).length;

    const recordedDates = new Set();
    validRecords.forEach((record) => {
      if (record.date) recordedDates.add(record.date);
    });
    const trueAbsentDays = Math.max(0, totalValidDays - recordedDates.size);

    const monthlyCalendar = this.generateMonthlyCalendar(
      yearNum,
      monthNum,
      processedRecords,
      accountCreatedOn,
      currentDate,
      effectiveStartDate,
      effectiveEndDate,
    );

    const summary = this.buildSummary(
      new Date(yearNum, monthNum, 0).getDate(),
      totalValidDays,
      validRecords.length,
      presentRecords.length,
      absentRecords.length,
      trueAbsentDays,
      totalTime,
      presentRecords.length > 0 ? Math.round(totalTime / presentRecords.length) : 0,
      pageNo1Completed,
      pageNo2Completed,
      pageNo3Completed,
      monthNum,
      yearNum,
      validRecords.length > 0
        ? Math.round(
            ((pageNo1Completed + pageNo2Completed + pageNo3Completed) / validRecords.length) * 100,
          ) / 100
        : 0,
      totalValidDays > 0 ? Math.round((presentRecords.length / totalValidDays) * 100) : 0,
      totalValidDays > 0
        ? Math.round(((absentRecords.length + trueAbsentDays) / totalValidDays) * 100)
        : 0,
      pageNo1Completed + pageNo2Completed + pageNo3Completed,
      accountCreatedOn,
      effectiveStartDate,
      effectiveEndDate,
      startDate,
      endDate,
    );

    VendorLogger.info({
      event: "ATTENDANCE_RETRIEVED",
      vendorId,
      month: monthNum,
      year: yearNum,
      validRecords: validRecords.length,
      presentDays: presentRecords.length,
      absentDays: absentRecords.length,
      trueAbsentDays,
      attendanceRate: summary.attendanceRate,
      duration_ms: Date.now() - startTime,
    });

    return {
      data: processedRecords,
      monthlyCalendar,
      summary,
      metadata: {
        vendorId,
        recordsCount: validRecords.length,
        queryPeriod: `${monthNum}/${yearNum}`,
        generatedAt: new Date().toISOString(),
        totalValidDays,
        statusBreakdown: {
          present: presentRecords.length,
          markedAbsent: absentRecords.length,
          noRecordAbsent: trueAbsentDays,
          future: monthlyCalendar.filter((day) => day.status === "future").length,
          beforeAccount: monthlyCalendar.filter((day) => day.status === "before-account").length,
        },
      },
    };
  }

  /**
   * Post attendance
   */
  static async postAttendance(vendorId, attendanceData = {}) {
    const startTime = Date.now();

    if (!vendorId) {
      VendorLogger.warn({
        event: "ATTENDANCE_MARK_FAILED",
        reason: "vendor_id_required",
        duration_ms: Date.now() - startTime,
      });
      throw ApiError.badRequest("Vendor ID is required");
    }

    const vendorRecord = await Vendor.findById(vendorId).select("presentDate").lean();

    if (!vendorRecord) {
      VendorLogger.warn({
        event: "ATTENDANCE_MARK_FAILED",
        reason: "vendor_not_found",
        vendorId,
        duration_ms: Date.now() - startTime,
      });
      throw ApiError.notFound("Vendor not found");
    }

    const parseTime = (value) => {
      if (value === undefined || value === null || value === "") {
        return 0;
      }

      const parsed = Number(value);

      if (!Number.isFinite(parsed) || parsed < 0) {
        VendorLogger.warn({
          event: "ATTENDANCE_MARK_FAILED",
          reason: "invalid_time_value",
          vendorId,
          value,
          duration_ms: Date.now() - startTime,
        });
        throw ApiError.badRequest("Attendance time values must be valid non-negative numbers");
      }

      return parsed;
    };

    const time1 = parseTime(attendanceData.time1);
    const time2 = parseTime(attendanceData.time2);
    const time3 = parseTime(attendanceData.time3);

    const totalTime = time1 + time2 + time3;

    const targetDate = new Date();

    const storedDate = vendorRecord.presentDate ? new Date(vendorRecord.presentDate) : null;

    if (
      storedDate &&
      !Number.isNaN(storedDate.getTime()) &&
      storedDate.getDate() === targetDate.getDate() &&
      storedDate.getMonth() === targetDate.getMonth() &&
      storedDate.getFullYear() === targetDate.getFullYear()
    ) {
      VendorLogger.warn({
        event: "ATTENDANCE_ALREADY_MARKED",
        vendorId,
        presentDate: vendorRecord.presentDate,
        duration_ms: Date.now() - startTime,
      });
      return {
        message: "Attendance already marked today",
      };
    }

    const attendance = new Attendance({
      vendorId,
      attendance: true,
      totalTime,
      presentDate: Date.now(),
      pageNo1: true,
      pageNo2: true,
      pageNo3: true,
      attendanceData,
    });

    await attendance.save();

    await Vendor.findByIdAndUpdate(vendorId, {
      presentDate: Date.now(),
    });

    VendorLogger.info({
      event: "ATTENDANCE_MARKED",
      vendorId,
      totalTime,
      attendanceId: attendance._id,
      duration_ms: Date.now() - startTime,
    });

    return {
      message: "Attendance saved successfully.",
    };
  }

  /**
   * ============================================
   * PRIVATE HELPER METHODS
   * ============================================
   */

  /**
   * Get commission for job type
   */
  static getCommission(jobType) {
    return JOB_COMMISSION[jobType] || 50;
  }

  /**
   * Update referral
   */
  static async updateReferral(entity, entityType, session = null) {
    if (entity.shareBy && entity.cd) {
      let referrerModel;
      switch (entity.cd) {
        case "user":
          referrerModel = User;
          break;
        case "vendor":
          referrerModel = Vendor;
          break;
        default:
          return;
      }

      const opts = session ? { session } : {};
      await referrerModel.findByIdAndUpdate(entity.shareBy, { $inc: { pending: 1 } }, opts);
    }
  }

  /**
   * Determine attendance status
   */
  static determineAttendanceStatus(record) {
    if (record.attendance === true) return "present";
    if (record.attendance === false || record.markedAbsent === true) return "absent";
    return record.totalTime && record.totalTime > 0 ? "present" : "absent";
  }

  /**
   * Check if date is in range
   */
  static isDateInRange(date, startDate, endDate) {
    return date >= startDate && date <= endDate;
  }

  /**
   * Calculate days between dates
   */
  static calculateDaysBetween(startDate, endDate) {
    const start = new Date(startDate);
    const end = new Date(endDate);
    start.setHours(0, 0, 0, 0);
    end.setHours(0, 0, 0, 0);
    const timeDiff = end.getTime() - start.getTime();
    return Math.max(0, Math.ceil(timeDiff / (1000 * 3600 * 24)) + 1);
  }

  /**
   * Generate monthly calendar for attendance
   */
  static generateMonthlyCalendar(
    year,
    month,
    records,
    accountCreatedOn,
    currentDate,
    effectiveStartDate,
    effectiveEndDate,
  ) {
    const totalDays = new Date(year, month, 0).getDate();
    const calendar = [];

    for (let day = 1; day <= totalDays; day++) {
      const date = new Date(year, month - 1, day);
      date.setHours(0, 0, 0, 0);

      const existingRecord = records.find((record) => {
        const recordDate = normalizeDateIST(record.presentDate);
        return recordDate && recordDate.getTime() === date.getTime();
      });

      let status = "no-record";
      let category = "active";

      if (date < accountCreatedOn) {
        status = "before-account";
        category = "inactive";
      } else if (date > currentDate) {
        status = "future";
        category = "inactive";
      } else if (date < effectiveStartDate || date > effectiveEndDate) {
        status = "outside-range";
        category = "inactive";
      } else if (existingRecord) {
        status = existingRecord.status;
        category = "active";
      } else {
        status = "absent";
        category = "active";
      }

      calendar.push({
        day,
        date: date.toISOString().split("T")[0],
        dayOfWeek: date.getDay(),
        status,
        category,
        record: existingRecord || null,
        isActivePeriod: category === "active",
      });
    }

    return calendar;
  }

  /**
   * Build attendance summary
   */
  static buildSummary(
    totalDaysInMonth,
    totalValidDays,
    totalRecords,
    presentDays,
    absentDays,
    trueAbsentDays,
    totalTime,
    averageTimePerDay,
    pageNo1Completed,
    pageNo2Completed,
    pageNo3Completed,
    month,
    year,
    averagePagesPerDay,
    attendanceRate,
    absenceRate,
    totalPagesCompleted,
    accountCreatedOn,
    effectiveStartDate,
    effectiveEndDate,
    startDate,
    endDate,
  ) {
    return {
      totalDaysInMonth,
      totalValidDays,
      totalRecords,
      presentDays,
      recordedAbsentDays: absentDays,
      trueAbsentDays,
      totalAbsentDays: absentDays + trueAbsentDays,
      totalTime,
      averageTimePerDay,
      pageNo1Completed,
      pageNo2Completed,
      pageNo3Completed,
      totalPagesCompleted,
      averagePagesPerDay,
      attendanceRate,
      absenceRate,
      workingDaysRatio: `${presentDays}/${totalValidDays}`,
      month,
      year,
      period: `${year}-${month.toString().padStart(2, "0")}`,
      accountCreatedOn: accountCreatedOn.toISOString(),
      effectiveStartDate: effectiveStartDate.toISOString(),
      effectiveEndDate: effectiveEndDate.toISOString(),
      dateRange: { start: startDate.toISOString(), end: endDate.toISOString() },
      absenceBreakdown: {
        markedAbsent: absentDays,
        noRecordAbsent: trueAbsentDays,
      },
    };
  }
}
function getVendorWageByType(vendor, requestedType) {
  if (!vendor || !requestedType) {
    return {
      wageRate: 0,
      wageRateType: "",
    };
  }

  const normalizedType = String(requestedType).trim().toLowerCase();

  const jobs = Array.isArray(vendor.type) ? vendor.type : [];
  const wageRates = Array.isArray(vendor.wageRate) ? vendor.wageRate : [];
  const wageRateTypes = Array.isArray(vendor.wageRateType) ? vendor.wageRateType : [];

  // Find the requested job index safely
  const jobIndex = jobs.findIndex(
    (job) =>
      String(job || "")
        .trim()
        .toLowerCase() === normalizedType,
  );

  if (jobIndex === -1) {
    return {
      wageRate: 0,
      wageRateType: "",
    };
  }

  return {
    wageRate: Number(wageRates[jobIndex] || 0),
    wageRateType: String(wageRateTypes[jobIndex] || ""),
  };
}
module.exports = VendorService;
