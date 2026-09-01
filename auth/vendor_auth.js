const { validationResult } = require("express-validator");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

const Employee = require("../models/employee");
const Vendor = require("../models/vendor");
const User = require("../models/user");
const Share = require("../models/share");
const ENV = require("../src/config/env");
const { VendorLogger } = require("../src/logger/index");

const secretKey = ENV.JWT_VENDOR_SECRET;

////////////////////////////////
//// for vendor signup /////////
////////////////////////////////

// // exports.signup = async (req, res, next) => {
// //   const startTime = Date.now();

// //   try {
// //     const errors = validationResult(req);

// //     if (!errors.isEmpty()) {
// //       VendorLogger.warn(
// //         {
// //           event: "VENDOR_SIGNUP_VALIDATION_FAILED",
// //           errors: errors.array(),
// //           requestId: req.requestId,
// //           ip: req.ip,
// //         },
// //         "Vendor signup validation failed",
// //       );

// //       return res.status(422).json({
// //         message: "Validation failed.",
// //         errors: errors.array(),
// //       });
// //     }

// //     const {
// //       name,
// //       phoneNo,
// //       email,
// //       password,
// //       type,
// //       experience,
// //       gender,
// //       sharedBy,
// //       cd,
// //       fcmToken,
// //       validPhoneNoId,
// //       agreedToTnCnP,
// //     } = req.body;

// //     // Normalize phone
// //     const normalizedPhone = String(phoneNo || "")
// //       .trim()
// //       .replace(/\s+/g, "");

// //     // Basic required-field validation
// //     if (!name || !normalizedPhone || !password || !Array.isArray(type)) {
// //       VendorLogger.warn({
// //         event: "VENDOR_SIGNUP_REQUIRED_FIELDS_MISSING",
// //         requestId: req.requestId,
// //         ip: req.ip,
// //       });

// //       return res.status(400).json({
// //         message: "Name, phone number, password, and job types are required",
// //       });
// //     }

// //     // --------------------------------------------------
// //     // Vendor can select maximum 5 jobs
// //     // --------------------------------------------------

// //     if (type.length < 1 || type.length > 5) {
// //       return res.status(400).json({
// //         message: "A vendor can select between 1 and 5 jobs",
// //       });
// //     }

// //     // Normalize jobs and remove duplicates
// //     const normalizedTypes = [
// //       ...new Set(type.map((job) => String(job).trim().toLowerCase()).filter(Boolean)),
// //     ];

// //     // Validate after normalization
// //     if (
// //       normalizedTypes.length < 1 ||
// //       normalizedTypes.length > 5 ||
// //       normalizedTypes.length !== type.length
// //     ) {
// //       return res.status(400).json({
// //         message: "Jobs must be unique and between 1 and 5",
// //       });
// //     }

// //     // --------------------------------------------------
// //     // Password validation
// //     // --------------------------------------------------

// //     if (password.length < 6) {
// //       VendorLogger.warn({
// //         event: "VENDOR_SIGNUP_PASSWORD_POLICY_FAILED",
// //         requestId: req.requestId,
// //         ip: req.ip,
// //       });

// //       return res.status(400).json({
// //         message: "Password must be at least 6 characters long",
// //       });
// //     }

// //     // --------------------------------------------------
// //     // Check duplicate phone
// //     // Run both DB queries in parallel
// //     // --------------------------------------------------

// //     const [existingUser, existingVendor] = await Promise.all([
// //       User.exists({
// //         phoneNo: normalizedPhone,
// //       }),

// //       Vendor.exists({
// //         phoneNo: normalizedPhone,
// //       }),
// //     ]);

// //     if (existingVendor || existingUser) {
// //       VendorLogger.warn(
// //         {
// //           event: "VENDOR_SIGNUP_DUPLICATE_PHONE",
// //           phoneNo: maskPhone(normalizedPhone),
// //           requestId: req.requestId,
// //           ip: req.ip,
// //         },
// //         "Vendor signup blocked: duplicate phone number",
// //       );

// //       return res.status(409).json({
// //         message: "Mobile number already exists!",
// //       });
// //     }

// //     // --------------------------------------------------
// //     // Fixed commission
// //     // Every vendor = ₹50 commission
// //     // --------------------------------------------------

// //     const commission = 50;

// //     // 5x commission = ₹250
// //     const initialBalance = commission * 5;

// //     // --------------------------------------------------
// //     // Hash password
// //     // --------------------------------------------------

// //     const hashedPw = await bcrypt.hash(password, ENV.BCRYPT_ROUNDS || 12);

// //     // --------------------------------------------------
// //     // Create vendor
// //     // --------------------------------------------------

// //     const vendor = new Vendor({
// //       name,
// //       phoneNo: normalizedPhone,

// //       email: email || "",

// //       password: hashedPw,

// //       // IMPORTANT:
// //       // Multiple jobs
// //       type: normalizedTypes,

// //       gender,

// //       experience,

// //       // Fixed commission
// //       commission,

// //       wageRate: 0,

// //       wageRateType: "",

// //       // ₹250 + existing ₹50 bonus
// //       balance: initialBalance + 50,

// //       shareBy: sharedBy,

// //       cd,

// //       fcmToken,

// //       verifyPhoneNo: true,

// //       agreedToTnCnP: Boolean(agreedToTnCnP),

// //       accountCreatedOn: new Date(),
// //     });

// //     // --------------------------------------------------
// //     // Save vendor
// //     // --------------------------------------------------

// //     const result = await vendor.save();

// //     // --------------------------------------------------
// //     // Success log
// //     // --------------------------------------------------

// //     VendorLogger.info(
// //       {
// //         event: "VENDOR_SIGNUP_SUCCESS",

// //         vendorId: result._id,

// //         phoneNo: maskPhone(normalizedPhone),

// //         type: normalizedTypes,

// //         requestId: req.requestId,

// //         ip: req.ip,

// //         duration: Date.now() - startTime,
// //       },

// //       "Vendor signup successful",
// //     );

// //     // --------------------------------------------------
// //     // Referral processing
// //     //
// //     // Do NOT make signup wait for referral processing.
// //     // This improves response time under load.
// //     // --------------------------------------------------

// //     if (sharedBy && cd) {
// //       handleVendorReferral(sharedBy, cd, vendor, name, normalizedPhone).catch((error) => {
// //         VendorLogger.error({
// //           event: "VENDOR_REFERRAL_UNHANDLED_ERROR",
// //           vendorId: vendor._id,
// //           sharedBy,
// //           sharedByType: cd,
// //           error: error.message,
// //         });
// //       });
// //     }

// //     // --------------------------------------------------
// //     // Response
// //     // --------------------------------------------------

// //     return res.status(201).json({
// //       message: "Vendor created successfully!",

// //       vendorId: result._id,

// //       // Always ₹50
// //       commission,

// //       initialBalance,
// //     });
// //   } catch (err) {
// //     VendorLogger.error(
// //       {
// //         event: "VENDOR_SIGNUP_ERROR",

// //         requestId: req.requestId,

// //         ip: req.ip,

// //         error: err.message,

// //         stack: err.stack,
// //       },

// //       "Vendor signup failed",
// //     );

// //     if (!err.statusCode) {
// //       err.statusCode = 500;
// //     }

// //     next(err);
// //   }
// // };

// ////////////////////////////////////////
// //// Vendor referral handling /////////
// ////////////////////////////////////////

// async function handleVendorReferral(sharedBy, cd, newVendor, name, phoneNo) {
//   try {
//     let referrerModel;

//     let bonusUpdate = {};

//     switch (cd) {
//       case "user":
//         referrerModel = User;
//         break;

//       case "vendor":
//         referrerModel = Vendor;
//         break;

//       case "employee":
//         referrerModel = Employee;
//         break;

//       default:
//         return;
//     }

//     // --------------------------------------------------
//     // Update referrer's bonus
//     // --------------------------------------------------

//     await referrerModel.findByIdAndUpdate(sharedBy, bonusUpdate);

//     // --------------------------------------------------
//     // Create share record
//     // --------------------------------------------------

//     const shareRecord = new Share({
//       userId: cd === "user" ? sharedBy : undefined,

//       vendorId: cd === "vendor" ? sharedBy : undefined,

//       employeeId: cd === "employee" ? sharedBy : undefined,
//       name: newVendor.name,
//       phoneNo: newVendor.phoneNo,

//       status: "completed",

//       shareDate: new Date(),
//     });

//     await shareRecord.save();

//     VendorLogger.info({
//       event: "VENDOR_REFERRAL_COMPLETED",

//       vendorId: newVendor._id,

//       sharedBy,

//       sharedByType: cd,
//     });

//     // --------------------------------------------------
//     // Update share count
//     // --------------------------------------------------

//     await referrerModel.findByIdAndUpdate(sharedBy, {
//       $inc: {
//         shareCount: 1,
//       },
//     });
//   } catch (error) {
//     VendorLogger.error({
//       event: "VENDOR_REFERRAL_FAILED",

//       vendorId: newVendor?._id,

//       sharedBy,

//       sharedByType: cd,

//       error: error.message,
//     });
//   }
// }

////////////////////////////////
//// Phone masking ////////////
////////////////////////////////

function maskPhone(phone) {
  return phone ? phone.toString().replace(/(\d{2})\d{6}(\d{2})/, "$1******$2") : "";
}

////////////////////////////////
//// Vendor login //////////////
////////////////////////////////

exports.login = async (req, res, next) => {
  const startTime = Date.now();

  try {
    const { phoneNo, password, fcmToken } = req.body;

    // --------------------------------------------------
    // Required fields
    // --------------------------------------------------

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

    // --------------------------------------------------
    // Normalize phone
    // --------------------------------------------------

    const normalizedPhone = String(phoneNo).trim().replace(/\s+/g, "");

    // --------------------------------------------------
    // Find vendor
    //
    // lean() reduces Mongoose document overhead.
    // --------------------------------------------------

    const vendor = await Vendor.findOne({
      phoneNo: normalizedPhone,
    }).lean();

    if (!vendor) {
      VendorLogger.warn(
        {
          event: "VENDOR_LOGIN_VENDOR_NOT_FOUND",

          phoneNo: maskPhone(normalizedPhone),

          requestId: req.requestId,

          ip: req.ip,
        },

        "Vendor login failed: vendor not found",
      );

      return res.status(401).json({
        message: "Vendor with this phone number not found",
      });
    }

    // --------------------------------------------------
    // Password comparison
    // --------------------------------------------------

    const isPasswordValid = await bcrypt.compare(password, vendor.password);

    if (!isPasswordValid) {
      VendorLogger.warn(
        {
          event: "VENDOR_LOGIN_INVALID_PASSWORD",

          vendorId: vendor._id,

          phoneNo: maskPhone(normalizedPhone),

          requestId: req.requestId,

          ip: req.ip,
        },

        "Vendor login failed: invalid password",
      );

      return res.status(401).json({
        message: "Invalid password",
      });
    }

    // --------------------------------------------------
    // Update FCM asynchronously
    //
    // Login response doesn't wait for DB write.
    // --------------------------------------------------

    if (fcmToken && fcmToken !== vendor.fcmToken) {
      Vendor.updateOne(
        {
          _id: vendor._id,
        },

        {
          $set: {
            fcmToken,
          },
        },
      ).catch((error) => {
        VendorLogger.error({
          event: "VENDOR_FCM_UPDATE_FAILED",

          vendorId: vendor._id,

          requestId: req.requestId,

          error: error.message,
        });
      });
    }

    // --------------------------------------------------
    // Generate JWT
    // --------------------------------------------------

    const token = jwt.sign(
      {
        phoneNo: vendor.phoneNo,

        vendorId: vendor._id.toString(),

        // IMPORTANT:
        // This is now an array
        //
        // [
        //   "electrician",
        //   "plumber"
        // ]
        //
        type: vendor.type,
      },

      secretKey,

      {
        expiresIn: "72h",
      },
    );

    // --------------------------------------------------
    // Vendor response
    // --------------------------------------------------

    const vendorData = {
      token,

      vendorId: vendor._id,

      name: vendor.name,

      email: vendor.email,

      verifyEmail: vendor.verifyEmail,

      phoneNo: vendor.phoneNo,

      verifyPhoneNo: vendor.verifyPhoneNo,

      // Array of jobs
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

    // --------------------------------------------------
    // Success logging
    // --------------------------------------------------

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

    return res.status(200).json(vendorData);
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
