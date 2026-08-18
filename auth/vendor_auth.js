const { validationResult } = require("express-validator");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const Employee = require("../models/employee");
const Vendor = require("../models/vendor");
const User = require("../models/user");
const OtpAuthorizationService = require("../src/services/OtpAuthorizationService");
const Share = require("../models/share");
const ENV = require("../src/config/env");
const { VendorLogger } = require("../src/logger/index");
const secretKey = ENV.JWT_VENDOR_SECRET;

// Commission configuration - moved outside function for better performance
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

function getCommission(jobType) {
  return JOB_COMMISSION[jobType] || 50; // Default commission if not found
}

//////////////////////////////
//// for vendor signup //////
/////////////////////////////

exports.signup = async (req, res, next) => {
  const startTime = Date.now();
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      VendorLogger.warn(
        {
          event: "VENDOR_SIGNUP_VALIDATION_FAILED",
          errors: errors.array(),
          requestId: req.requestId,
          ip: req.ip,
        },
        "Vendor signup validation failed",
      );
      return res.status(422).json({
        message: "Validation failed.",
        errors: errors.array(),
      });
    }

    const {
      name,
      phoneNo,
      email,
      password,
      type,
      experience,
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

    if (!name || !normalizedPhone || !password || !type) {
      VendorLogger.warn({
        event: "VENDOR_SIGNUP_REQUIRED_FIELDS_MISSING",
        requestId: req.requestId,
        ip: req.ip,
      });
      return res.status(400).json({
        message: "Name, phone number, password, and type are required",
      });
    }

    // if (!validPhoneNoId) {
    //   return res.status(400).json({
    //     message: "Phone verification is required",
    //   });
    // }

    if (password.length < 6) {
      VendorLogger.warn({
        event: "VENDOR_SIGNUP_PASSWORD_POLICY_FAILED",
        requestId: req.requestId,
        ip: req.ip,
      });
      return res.status(400).json({
        message: "Password must be at least 6 characters long",
      });
    }

    // Validate required fields
    const existingUser = await User.exists({
      phoneNo: normalizedPhone,
    });

    const existingVendor = await Vendor.exists({
      phoneNo: normalizedPhone,
    });

    if (existingVendor || existingUser) {
      VendorLogger.warn(
        {
          event: "VENDOR_SIGNUP_DUPLICATE_PHONE",
          phoneNo: maskPhone(normalizedPhone),
          requestId: req.requestId,
          ip: req.ip,
        },
        "Vendor signup blocked: duplicate phone number",
      );
      return res.status(409).json({
        message: "Mobile number already exists!",
      });
    }

    // Check phone verification

    // Calculate commission and initial balance
    const commission = getCommission(type);
    const initialBalance = commission * 5; // 5x commission as initial balance

    // await OtpAuthorizationService.consume({
    //   otpId: validPhoneNoId,
    //   accountType: "vendor",
    //   accountId: null,
    //   purpose: "verify_phone",
    //   target: normalizedPhone,
    // });
    // Hash password and create vendor
    const hashedPw = await bcrypt.hash(password, 12);
    const vendor = new Vendor({
      name,
      phoneNo: normalizedPhone,
      email: email || "",
      password: hashedPw,
      type,
      gender,
      experience,
      commission,
      wageRate: 0, // Explicitly set default values
      wageRateType: "", // Set default wage rate type
      balance: initialBalance + 50,
      shareBy: sharedBy,
      cd,
      fcmToken,
      verifyPhoneNo: true, // Since phone is verified
      agreedToTnCnP: Boolean(agreedToTnCnP),
      accountCreatedOn: new Date(), // Use Date object instead of string
    });

    const result = await vendor.save();

    VendorLogger.info(
      {
        event: "VENDOR_SIGNUP_SUCCESS",
        vendorId: result._id,
        phoneNo: maskPhone(normalizedPhone),
        type,
        requestId: req.requestId,
        ip: req.ip,

        duration: Date.now() - startTime,
      },
      "Vendor signup successful",
    );
    // Handle referral/sharing logic
    if (sharedBy && cd) {
      await handleVendorReferral(sharedBy, cd, vendor, name, normalizedPhone);
    }

    res.status(201).json({
      message: "Vendor created successfully!",
      vendorId: result._id,
      commission,
      initialBalance,
    });
  } catch (err) {
    VendorLogger.error(
      {
        event: "VENDOR_SIGNUP_ERROR",
        requestId: req.requestId,
        ip: req.ip,
        error: err.message,
        stack: err.stack,
      },
      "Vendor signup failed",
    );
    if (!err.statusCode) {
      err.statusCode = 500;
    }
    next(err);
  }
};

// Helper function for vendor referral handling
async function handleVendorReferral(sharedBy, cd, newVendor, name, phoneNo) {
  try {
    let referrerModel;
    let bonusUpdate = {};

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
    await referrerModel.findByIdAndUpdate(sharedBy, bonusUpdate);

    // Create share record
    const shareRecord = new Share({
      userId: cd === "user" ? sharedBy : undefined,
      vendorId: cd === "vendor" ? sharedBy : undefined,
      employeeId: cd === "employee" ? sharedBy : undefined,
      phoneNo: newVendor.phoneNo,
      status: "completed",
      shareDate: new Date(),
    });

    await shareRecord.save();
    VendorLogger.info({
      event: "VENDOR_REFERRAL_COMPLETED",
      vendorId: newVendor._id,
      sharedBy,
      sharedByType: cd,
    });
    // Update share count for referrer
    await referrerModel.findByIdAndUpdate(sharedBy, {
      $inc: { shareCount: 1 },
    });
  } catch (error) {
    VendorLogger.error({
      event: "VENDOR_REFERRAL_FAILED",
      vendorId: newVendor?._id,
      sharedBy,
      sharedByType: cd,
      error: error.message,
    });
  }
}

function maskPhone(phone) {
  return phone ? phone.toString().replace(/(\d{2})\d{6}(\d{2})/, "$1******$2") : "";
}

//////////////////////////////
//// for vendor login //////
/////////////////////////////

exports.login = async (req, res, next) => {
  const startTime = Date.now();
  try {
    const { phoneNo, password, fcmToken } = req.body;

    if (!phoneNo || !password) {
      VendorLogger.warn({
        event: "VENDOR_LOGIN_REQUIRED_FIELDS_MISSING",
        requestId: req.requestId,
        ip: req.ip,
      });
      return res.status(400).json({
        message: "Phone number and password are required",
      });
    }

    const vendor = await Vendor.findOne({ phoneNo });
    if (!vendor) {
      VendorLogger.warn(
        {
          event: "VENDOR_LOGIN_VENDOR_NOT_FOUND",
          phoneNo: maskPhone(phoneNo),
          requestId: req.requestId,
          ip: req.ip,
        },
        "Vendor login failed: vendor not found",
      );
      return res.status(401).json({
        message: "Vendor with this phone number not found",
      });
    }

    const isPasswordValid = await bcrypt.compare(password, vendor.password);
    if (!isPasswordValid) {
      VendorLogger.warn(
        {
          event: "VENDOR_LOGIN_INVALID_PASSWORD",
          vendorId: vendor._id,
          phoneNo: maskPhone(phoneNo),
          requestId: req.requestId,
          ip: req.ip,
        },
        "Vendor login failed: invalid password",
      );
      return res.status(401).json({
        message: "Invalid password",
      });
    }

    // Update FCM token if provided
    if (fcmToken && vendor.fcmToken !== fcmToken) {
      await Vendor.findByIdAndUpdate(vendor._id, { fcmToken });

      VendorLogger.info({
        event: "VENDOR_FCM_UPDATED",
        vendorId: vendor._id,
      });
    }

    // Generate JWT token
    const token = jwt.sign(
      {
        phoneNo: vendor.phoneNo,
        vendorId: vendor._id.toString(),
        type: vendor.type, // Include vendor type in token for authorization
      },
      secretKey,
      { expiresIn: "72h" },
    );

    // Prepare vendor data for response
    const vendorData = {
      token,
      vendorId: vendor._id,
      name: vendor.name,
      email: vendor.email,
      verifyEmail: vendor.verifyEmail,
      phoneNo: vendor.phoneNo,
      verifyPhoneNo: vendor.verifyPhoneNo,
      type: vendor.type,
      gender: vendor.gender,
      rating: vendor.rating,
      ratingCount: vendor.ratingCount,
      wageRate: vendor.wageRate,
      wageRateType: vendor.wageRateType,
      commission: vendor.commission,
      address: vendor.address,
      balance: vendor.balance,
      transactionCount: vendor.transactionCount,
      totalDiscount: vendor.totalDiscount,
      totalOriginalAmount: vendor.totalOriginalAmount,
      imgURL: vendor.imgURL,
      pending: vendor.pending,
      completed: vendor.completed,
      canceled: vendor.canceled,
      earning: vendor.earning,
      pincode: vendor.pincode,
      message: "Vendor login successful",
    };
    VendorLogger.info(
      {
        event: "VENDOR_LOGIN_SUCCESS",
        vendorId: vendor._id,
        phoneNo: maskPhone(vendor.phoneNo),
        requestId: req.requestId,
        ip: req.ip,
        duration: Date.now() - startTime,
      },
      "Vendor login successful",
    );
    res.status(200).json(vendorData);
  } catch (err) {
    VendorLogger.error({
      event: "VENDOR_LOGIN_ERROR",
      requestId: req.requestId,
      ip: req.ip,
      error: err.message,
      ...(err.statusCode >= 500 && {
        stack: err.stack,
      }),
    });
    if (!err.statusCode) {
      err.statusCode = 500;
    }
    next(err);
  }
};
