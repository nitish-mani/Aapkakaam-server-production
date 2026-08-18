const { validationResult } = require("express-validator");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { performance } = require("perf_hooks");

const OtpAuth = require("../models/otpAuth");
const Admin = require("../models/admin");
const User = require("../models/user");
const Vendor = require("../models/vendor");
const Employee = require("../models/employee");
const Bookings = require("../models/bookings");
const ENV = require("../src/config/env");
const OtpAuthorizationService = require("../src/services/OtpAuthorizationService");

// Import logger
const { AdminLogger } = require("../src/logger/index");

const secretKey = ENV.JWT_ADMIN_SECRET;
const email_admin = ENV.ADMIN_EMAIL;
const phoneNo_admin = ENV.ADMIN_PHONENO;

// Query timeout constants
const QUERY_TIMEOUT_MS = {
  DEFAULT: 10000,
  COUNT: 5000,
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

/**
 * Helper: Mask email for logging (PII protection)
 */
const maskEmail = (email) => {
  if (!email) return null;
  const parts = email.split("@");
  if (parts.length !== 2) return "invalid";
  const local = parts[0];
  if (local.length <= 2) return `${local}@${parts[1]}`;
  return `${local.slice(0, 2)}***@${parts[1]}`;
};

/**
 * Helper: Get total count with error handling
 */
async function getTotalCount(Model, modelName) {
  const startTime = performance.now();
  try {
    const count = await Model.countDocuments().maxTimeMS(QUERY_TIMEOUT_MS.COUNT);

    AdminLogger.debug({
      event: "COUNT_RETRIEVED",
      model: modelName,
      count,
      duration_ms: +(performance.now() - startTime).toFixed(2),
    });

    return count;
  } catch (err) {
    AdminLogger.error({
      event: "COUNT_ERROR",
      model: modelName,
      err,
      duration_ms: +(performance.now() - startTime).toFixed(2),
    });
    return 0;
  }
}

/**
 * Helper: Handle referral bonus
 */
async function handleReferralBonus(sharedBy, cd, newAdmin, name, phoneNo) {
  try {
    let referrerModel;
    switch (cd) {
      case "user":
        referrerModel = User;
        break;
      case "vendor":
        referrerModel = Vendor;
        break;
      case "employee":
        referrerModel = Employee;
        break;
      default:
        return;
    }

    // Update referrer's bonus
    await referrerModel.findByIdAndUpdate(sharedBy, {
      $inc: { pending: 1 },
    });

    AdminLogger.info({
      event: "ADMIN_REFERRAL_COMPLETED",
      adminId: newAdmin._id,
      sharedBy,
      sharedByType: cd,
    });
  } catch (error) {
    AdminLogger.error({
      event: "ADMIN_REFERRAL_FAILED",
      adminId: newAdmin?._id,
      sharedBy,
      sharedByType: cd,
      err: error,
    });
  }
}

//////////////////////////////
//// for admin signup //////
/////////////////////////////

exports.signup = async (req, res, next) => {
  const startTime = performance.now();
  const requestId = req.headers["x-request-id"] || `signup-${Date.now()}`;

  AdminLogger.info({
    event: "ADMIN_SIGNUP_STARTED",
    requestId,
    email: req.body.email ? maskEmail(req.body.email) : null,
    ip: req.ip,
    userAgent: req.get("user-agent"),
  });

  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      AdminLogger.warn({
        event: "ADMIN_SIGNUP_VALIDATION_FAILED",
        reason: "validation_failed",
        requestId,
        validationCount: errors.array().length,
        validationFields: errors.array().map((e) => e.path),
        ip: req.ip,
        userAgent: req.get("user-agent"),
        duration_ms: +(performance.now() - startTime).toFixed(2),
      });

      return res.status(422).json({
        message: "Validation failed.",
        errors: errors.array(),
      });
    }

    const {
      name,
      email,
      phoneNo,
      password,
      gender,
      sharedBy,
      cd,
      fcmToken,
      validPhoneNoId,
      agreedToTnCnP,
    } = req.body;
    const normalizedPhone = String(phoneNo || "")
      .trim()
      .replace(/\s+/g, "");

    if (!name || !normalizedPhone || !password) {
      AdminLogger.warn({
        event: "ADMIN_SIGNUP_REQUIRED_FIELDS_MISSING",
        requestId,
        ip: req.ip,
        userAgent: req.get("user-agent"),
        duration_ms: +(performance.now() - startTime).toFixed(2),
      });
      return res.status(400).json({
        message: "Name, phone number, and password are required",
      });
    }

    const regexEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!regexEmail.test(email)) {
      AdminLogger.warn({
        event: "ADMIN_SIGNUP_INVALID_EMAIL_FORMAT",
        requestId,
        email: maskEmail(email),
        ip: req.ip,
        userAgent: req.get("user-agent"),
        duration_ms: +(performance.now() - startTime).toFixed(2),
      });
      return res.status(401).json({ message: "Invalid Email" });
    }

    const regexPass = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&#])[A-Za-z\d@$!%*?&#]{8,}$/;
    if (!regexPass.test(password)) {
      AdminLogger.warn({
        event: "ADMIN_SIGNUP_PASSWORD_POLICY_FAILED",
        requestId,
        email: maskEmail(email),
        ip: req.ip,
        userAgent: req.get("user-agent"),
        duration_ms: +(performance.now() - startTime).toFixed(2),
      });
      return res.status(401).json({
        message:
          "Password must be at least 8 characters long and contain at least one uppercase letter, one lowercase letter, one number, and one special character",
      });
    }

    // Check phone verification
    if (!validPhoneNoId) {
      AdminLogger.warn({
        event: "ADMIN_SIGNUP_PHONE_VERIFICATION_REQUIRED",
        requestId,
        phone: maskPhone(normalizedPhone),
        ip: req.ip,
        userAgent: req.get("user-agent"),
        duration_ms: +(performance.now() - startTime).toFixed(2),
      });
      return res.status(400).json({
        message: "Phone verification is required",
      });
    }

    // Verify phone via OTP service
    await OtpAuthorizationService.consume({
      otpId: validPhoneNoId,
      accountType: "admin",
      accountId: null,
      purpose: "verify_phone",
      target: normalizedPhone,
    });

    // Check if admin already exists
    const existingAdmin = await Admin.findOne({
      $or: [{ email: email }, { phoneNo: normalizedPhone }],
    })
      .select("email phoneNo")
      .maxTimeMS(QUERY_TIMEOUT_MS.DEFAULT);

    if (existingAdmin) {
      AdminLogger.warn({
        event: "ADMIN_SIGNUP_DUPLICATE",
        requestId,
        email: maskEmail(email),
        phone: maskPhone(normalizedPhone),
        ip: req.ip,
        userAgent: req.get("user-agent"),
        duration_ms: +(performance.now() - startTime).toFixed(2),
      });
      return res.status(409).json({
        message: "Admin with this email or phone already exists!",
      });
    }

    // Check if authorized email and phone
    if (email !== email_admin || normalizedPhone !== phoneNo_admin) {
      AdminLogger.warn({
        event: "ADMIN_SIGNUP_UNAUTHORIZED",
        reason: "unauthorized_email_or_phone",
        requestId,
        email: maskEmail(email),
        allowedEmail: maskEmail(email_admin),
        phone: maskPhone(normalizedPhone),
        allowedPhone: maskPhone(phoneNo_admin),
        ip: req.ip,
        userAgent: req.get("user-agent"),
        duration_ms: +(performance.now() - startTime).toFixed(2),
      });
      return res.status(404).json({ message: "Not Authorized...Thanks..." });
    }

    // Hash password and create admin
    const hashedPw = await bcrypt.hash(password, 12);

    const admin = new Admin({
      name,
      phoneNo: normalizedPhone,
      email,
      password: hashedPw,
      gender: gender || "",
      fcmToken: fcmToken || "",
      verifyPhoneNo: true,
      verifyEmail: true,
      agreedToTnCnP: Boolean(agreedToTnCnP),
      accountCreatedOn: new Date(),
    });

    const result = await admin.save();

    AdminLogger.info({
      event: "ADMIN_SIGNUP_SUCCESS",
      requestId,
      adminId: result._id,
      email: maskEmail(email),
      phone: maskPhone(normalizedPhone),
      ip: req.ip,
      userAgent: req.get("user-agent"),
      duration_ms: +(performance.now() - startTime).toFixed(2),
    });

    // Handle referral/sharing logic
    if (sharedBy && cd) {
      await handleReferralBonus(sharedBy, cd, admin, name, normalizedPhone);
    }

    res.status(201).json({
      message: "Admin created successfully!",
      adminId: result._id,
    });
  } catch (err) {
    AdminLogger.error({
      event: "ADMIN_SIGNUP_ERROR",
      requestId,
      email: req.body?.email ? maskEmail(req.body.email) : null,
      ip: req.ip,
      userAgent: req.get("user-agent"),
      err,
      duration_ms: +(performance.now() - startTime).toFixed(2),
    });

    if (!err.statusCode) {
      err.statusCode = 500;
    }
    next(err);
  }
};

///////////////////////////////
//// for admin login //////
/////////////////////////////

exports.login = async (req, res, next) => {
  const startTime = performance.now();
  const requestId = req.headers["x-request-id"] || `login-${Date.now()}`;
  const { email, password, fcmToken } = req.body;

  AdminLogger.info({
    event: "ADMIN_LOGIN_STARTED",
    requestId,
    email: email ? maskEmail(email) : null,
    ip: req.ip,
    userAgent: req.get("user-agent"),
  });

  try {
    if (!email || !password) {
      AdminLogger.warn({
        event: "ADMIN_LOGIN_REQUIRED_FIELDS_MISSING",
        requestId,
        ip: req.ip,
        userAgent: req.get("user-agent"),
        duration_ms: +(performance.now() - startTime).toFixed(2),
      });
      return res.status(400).json({
        message: "Email and password are required",
      });
    }

    const loadedAdmin = await Admin.findOne({ email }).maxTimeMS(QUERY_TIMEOUT_MS.DEFAULT);

    if (!loadedAdmin) {
      AdminLogger.warn({
        event: "ADMIN_LOGIN_ADMIN_NOT_FOUND",
        email: maskEmail(email),
        requestId,
        ip: req.ip,
        userAgent: req.get("user-agent"),
        duration_ms: +(performance.now() - startTime).toFixed(2),
      });
      return res.status(401).json({
        message: "Admin with this email could not be found",
      });
    }

    const isPasswordValid = await bcrypt.compare(password, loadedAdmin.password);
    if (!isPasswordValid) {
      AdminLogger.warn({
        event: "ADMIN_LOGIN_INVALID_PASSWORD",
        adminId: loadedAdmin._id,
        email: maskEmail(email),
        requestId,
        ip: req.ip,
        userAgent: req.get("user-agent"),
        duration_ms: +(performance.now() - startTime).toFixed(2),
      });
      return res.status(401).json({
        message: "Invalid password",
      });
    }

    // Update FCM token if provided
    if (fcmToken && fcmToken !== loadedAdmin.fcmToken) {
      await Admin.findByIdAndUpdate(loadedAdmin._id, { fcmToken });
      AdminLogger.debug({
        event: "ADMIN_FCM_UPDATED",
        adminId: loadedAdmin._id,
        requestId,
      });
    }

    // Generate JWT token
    const token = jwt.sign(
      {
        email: loadedAdmin.email,
        adminId: loadedAdmin._id.toString(),
      },
      secretKey,
      { expiresIn: "1h" },
    );

    // Get counts in parallel
    const countStartTime = performance.now();
    const [totalUser, totalVendor, totalEmployee, totalBookings] = await Promise.all([
      getTotalCount(User, "User"),
      getTotalCount(Vendor, "Vendor"),
      getTotalCount(Employee, "Employee"),
      getTotalCount(Bookings, "Bookings"),
    ]);

    AdminLogger.debug({
      event: "ADMIN_COUNTS_RETRIEVED",
      requestId,
      adminId: loadedAdmin._id,
      totalUser,
      totalVendor,
      totalEmployee,
      totalBookings,
      duration_ms: +(performance.now() - countStartTime).toFixed(2),
    });

    AdminLogger.info({
      event: "ADMIN_LOGIN_SUCCESS",
      requestId,
      adminId: loadedAdmin._id.toString(),
      email: maskEmail(email),
      name: loadedAdmin.name,
      ip: req.ip,
      userAgent: req.get("user-agent"),
      duration_ms: +(performance.now() - startTime).toFixed(2),
    });

    res.status(200).json({
      token: token,
      adminId: loadedAdmin._id.toString(),
      name: loadedAdmin.name,
      email: loadedAdmin.email,
      verifyEmail: loadedAdmin.verifyEmail,
      phoneNo: loadedAdmin.phoneNo,
      verifyPhoneNo: loadedAdmin.verifyPhoneNo,
      gender: loadedAdmin.gender,
      totalBookings,
      totalEmployee,
      totalUser,
      totalVendor,
      message: "Admin logged in successfully",
    });
  } catch (err) {
    AdminLogger.error({
      event: "ADMIN_LOGIN_ERROR",
      requestId,
      email: req.body?.email ? maskEmail(req.body.email) : null,
      ip: req.ip,
      userAgent: req.get("user-agent"),
      err,
      duration_ms: +(performance.now() - startTime).toFixed(2),
    });

    if (!err.statusCode) {
      err.statusCode = 500;
    }
    next(err);
  }
};
