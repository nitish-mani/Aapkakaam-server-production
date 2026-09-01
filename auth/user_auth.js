const { validationResult } = require("express-validator");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const OtpAuthorizationService = require("../src/services/OtpAuthorizationService");
const User = require("../models/user");
const Vendor = require("../models/vendor");
const Employee = require("../models/employee");
const Share = require("../models/share"); // Import the Share model
const ENV = require("../src/config/env");
const { UserLogger } = require("../src/logger/index");
const secretKey = ENV.JWT_USER_SECRET;

////////////////////////////
//// for user signup //////
///////////////////////////

exports.signup = async (req, res, next) => {
  const startTime = Date.now();
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      UserLogger.warn(
        {
          event: "USER_SIGNUP_VALIDATION_FAILED",
          validationCount: errors.array().length,
          validationFields: errors.array().map((e) => e.path),
          requestId: req.requestId,
          ip: req.ip,
          userAgent: req.get("user-agent"),
        },
        "User signup validation failed",
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
      UserLogger.warn(
        {
          event: "USER_SIGNUP_REQUIRED_FIELDS_MISSING",
          requestId: req.requestId,
          ip: req.ip,
          userAgent: req.get("user-agent"),
        },
        "User signup rejected: required fields missing",
      );
      return res.status(400).json({
        message: "Name, phone number, and password are required",
      });
    }

    if (!validPhoneNoId) {
      return res.status(400).json({
        message: "Phone verification is required",
      });
    }

    if (password.length < 6) {
      UserLogger.warn({
        event: "USER_SIGNUP_PASSWORD_POLICY_FAILED",
        requestId: req.requestId,
        ip: req.ip,
        userAgent: req.get("user-agent"),
      });
      return res.status(400).json({
        message: "Password must be at least 6 characters long",
      });
    }

    // Check phone verification

    // Check if user already exists
    const [existingUser, existingVendor] = await Promise.all([
      User.exists({
        phoneNo: normalizedPhone,
      }),
      Vendor.exists({
        phoneNo: normalizedPhone,
      }),
    ]);
    if (existingUser || existingVendor) {
      UserLogger.warn(
        {
          event: "USER_SIGNUP_DUPLICATE_PHONE",
          phoneNo: maskPhone(normalizedPhone),
          requestId: req.requestId,
          ip: req.ip,
          userAgent: req.get("user-agent"),
        },
        "User signup blocked: duplicate phone",
      );
      return res.status(409).json({
        message: "Mobile number already exists!",
      });
    }
    await OtpAuthorizationService.consume({
      otpId: validPhoneNoId,
      accountType: "user",
      accountId: null,
      purpose: "verify_phone",
      target: normalizedPhone,
    });

    // Hash password and create user

    const hashedPw = await bcrypt.hash(password, ENV.BCRYPT_ROUNDS);

    const user = new User({
      name,
      phoneNo: normalizedPhone,
      email: email || "",
      password: hashedPw,
      gender,
      fcmToken,
      shareBy: sharedBy,
      cd,
      balance: 50,
      verifyPhoneNo: true, // Since phone is verified
      agreedToTnCnP: Boolean(agreedToTnCnP),
      accountCreatedOn: new Date(),
    });

    const result = await user.save();
    UserLogger.info(
      {
        event: "USER_SIGNUP_SUCCESS",
        userId: result._id,
        phoneNo: maskPhone(normalizedPhone),
        requestId: req.requestId,
        ip: req.ip,
        userAgent: req.get("user-agent"),
        duration: Date.now() - startTime,
      },
      "User signup successful",
    );

    // Handle referral/sharing logic using Share model
    if (sharedBy && cd) {
      await handleReferralBonus(sharedBy, cd, user, name, normalizedPhone);
    }

    res.status(201).json({
      message: "User created successfully!",
      userId: result._id,
    });
  } catch (err) {
    UserLogger.error(
      {
        event: "USER_SIGNUP_ERROR",
        requestId: req.requestId,
        ip: req.ip,
        userAgent: req.get("user-agent"),
        error: err.message,
        ...(err.statusCode >= 500 && { stack: err.stack }),
      },
      "User signup failed",
    );
    if (!err.statusCode) {
      err.statusCode = 500;
    }
    next(err);
  }
};

function maskPhone(phone) {
  return phone ? phone.toString().replace(/(\d{2})\d{6}(\d{2})/, "$1******$2") : "";
}
// Helper function for referral bonus handling
async function handleReferralBonus(sharedBy, cd, newUser, name, phoneNo) {
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
      name: newUser.name,
      phoneNo: newUser.phoneNo,
      status: "completed",
      shareDate: new Date(),
    });

    await shareRecord.save();

    // Update share count for referrer
    await referrerModel.findByIdAndUpdate(sharedBy, {
      $inc: { shareCount: 1 },
    });
    UserLogger.info(
      {
        event: "USER_REFERRAL_COMPLETED",
        userId: newUser._id,
        sharedBy,
        sharedByType: cd,
      },
      "Referral processed successfully",
    );
  } catch (error) {
    UserLogger.error(
      {
        event: "USER_REFERRAL_FAILED",
        userId: newUser?._id,
        sharedBy,
        sharedByType: cd,
        error: error.message,
      },
      "Referral processing failed",
    );
  }
}

///////////////////////////
//// for user login //////
//////////////////////////

////////////////////////////
//// for user login ////////
////////////////////////////

exports.login = async (req, res, next) => {
  const startTime = Date.now();

  try {
    const { phoneNo, password, fcmToken } = req.body;

    // --------------------------------------------------
    // 1. Validate required fields
    // --------------------------------------------------
    if (!phoneNo || !password) {
      UserLogger.warn(
        {
          event: "USER_LOGIN_REQUIRED_FIELDS_MISSING",
          requestId: req.requestId,
          ip: req.ip,
          userAgent: req.get("user-agent"),
        },
        "User login rejected: required fields missing",
      );

      return res.status(400).json({
        message: "Phone number and password are required",
      });
    }

    // --------------------------------------------------
    // 2. Normalize phone number
    // --------------------------------------------------
    const normalizedPhone = String(phoneNo).trim().replace(/\s+/g, "");

    // --------------------------------------------------
    // 3. Find user
    // --------------------------------------------------
    const user = await User.findOne({
      phoneNo: normalizedPhone,
    });

    // --------------------------------------------------
    // 4. Generic authentication failure
    //
    // IMPORTANT:
    // Do not tell the client whether the phone exists.
    // This prevents account enumeration.
    // --------------------------------------------------
    if (!user) {
      UserLogger.warn(
        {
          event: "USER_LOGIN_FAILED",
          reason: "INVALID_CREDENTIALS",
          phoneNo: maskPhone(normalizedPhone),
          requestId: req.requestId,
          ip: req.ip,
          userAgent: req.get("user-agent"),
          duration: Date.now() - startTime,
        },
        "User login failed: invalid credentials",
      );

      return res.status(401).json({
        message: "Invalid phone number or password",
      });
    }

    // --------------------------------------------------
    // 5. Compare password
    //
    // Native bcrypt remains CPU-expensive intentionally.
    // Keep login rate-limited.
    // --------------------------------------------------
    const isPasswordValid = await bcrypt.compare(password, user.password);

    if (!isPasswordValid) {
      UserLogger.warn(
        {
          event: "USER_LOGIN_FAILED",
          reason: "INVALID_CREDENTIALS",
          userId: user._id,
          phoneNo: maskPhone(normalizedPhone),
          requestId: req.requestId,
          ip: req.ip,
          userAgent: req.get("user-agent"),
          duration: Date.now() - startTime,
        },
        "User login failed: invalid credentials",
      );

      return res.status(401).json({
        message: "Invalid phone number or password",
      });
    }

    // --------------------------------------------------
    // 6. Update FCM token asynchronously
    //
    // Do NOT make successful login wait for this DB write.
    // --------------------------------------------------
    if (fcmToken && fcmToken !== user.fcmToken) {
      User.updateOne(
        { _id: user._id },
        {
          $set: {
            fcmToken,
          },
        },
      ).catch((error) => {
        UserLogger.error(
          {
            event: "USER_FCM_UPDATE_FAILED",
            userId: user._id,
            requestId: req.requestId,
            error: error.message,
          },
          "Failed to update user FCM token",
        );
      });
    }

    // --------------------------------------------------
    // 7. Generate JWT
    // --------------------------------------------------
    const token = jwt.sign(
      {
        userId: user._id.toString(),
        phoneNo: user.phoneNo,
      },
      ENV.JWT_USER_SECRET,
      {
        expiresIn: ENV.JWT_EXPIRES_IN,
        issuer: "aapkakaam-api",
        audience: "user",
      },
    );

    // --------------------------------------------------
    // 8. Prepare response
    // --------------------------------------------------
    const userData = {
      token,
      userId: user._id,
      name: user.name,
      email: user.email,
      verifyEmail: user.verifyEmail,
      phoneNo: user.phoneNo,
      verifyPhoneNo: user.verifyPhoneNo,
      balance: user.balance,
      transactionCount: user.transactionCount,
      totalDiscount: user.totalDiscount,
      totalOriginalAmount: user.totalOriginalAmount,
      address: user.address,
      gender: user.gender,
      imgURL: user.imgURL,
      pending: user.pending,
      completed: user.completed,
      canceled: user.canceled,
      pincode: user.pincode,
      earning: user.earning,
      message: "Login successful",
    };

    // --------------------------------------------------
    // 9. Success logging
    // --------------------------------------------------
    UserLogger.info(
      {
        event: "USER_LOGIN_SUCCESS",
        userId: user._id,
        phoneNo: maskPhone(user.phoneNo),
        authMethod: "password",
        requestId: req.requestId,
        ip: req.ip,
        userAgent: req.get("user-agent"),
        duration: Date.now() - startTime,
      },
      "User login successful",
    );

    return res.status(200).json(userData);
  } catch (err) {
    // --------------------------------------------------
    // 10. Error handling
    // --------------------------------------------------
    UserLogger.error(
      {
        event: "USER_LOGIN_ERROR",
        requestId: req.requestId,
        ip: req.ip,
        userAgent: req.get("user-agent"),
        error: err.message,
        ...(err.statusCode >= 500 && {
          stack: err.stack,
        }),
      },
      "User login failed",
    );

    if (!err.statusCode) {
      err.statusCode = 500;
    }

    next(err);
  }
};
