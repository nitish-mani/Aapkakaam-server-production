const express = require("express");

const router = express.Router();
const is_user = require("../middleware/is_user");
const is_vendor = require("../middleware/is_vendor");
const vendor_controller = require("../controller/vendor");
const mongoose = require("mongoose");
const crypto = require("crypto");
const Razorpay = require("razorpay");

const { VendorLogger } = require("../src/logger/index");
const bcrypt = require("bcrypt");
const Vendor = require("../models/vendor");
const User = require("../models/user");
const Transaction = require("../models/transaction");
const VendorSignupPayment = require("../models/vendorSignupPayment");
const ENV = require("../src/config/env");

const OtpAuthorizationService = require("../src/services/OtpAuthorizationService");
const PaymentService = require("../src/services/paymentService");

const authenticate = require("../middleware/authenticate");
const vendor_auth = require("../auth/vendor_auth");
const { authRateLimiter } = require("../src/middleware/rateLimiter");

/////////////////////
//// for vendor ////
////////////////////

// --- Auth & OTP endpoints (strict rate limit) ------------------------
router.post(
  "/phoneVerification",
  authRateLimiter,
  vendor_controller.vendor_controller_verify_phoneNo,
);
router.post("/otpVerification", authRateLimiter, vendor_controller.vendor_controller_otp);

router.post(
  "/phoneVerificationPasswordReset",
  authRateLimiter,
  vendor_controller.vendor_controller_verify_phoneNo_reset_password,
);
router.post(
  "/otpVerificationResetPassword",
  authRateLimiter,
  vendor_controller.vendor_controller_otp_reset_password,
);

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// ============================================================
// VENDOR SIGNUP PAYMENT
// ₹50 mandatory payment
// ============================================================

const VENDOR_SIGNUP_AMOUNT = 50;
const VENDOR_SIGNUP_AMOUNT_PAISE = 5000;

// ------------------------------------------------------------
// CREATE RAZORPAY ORDER
// ------------------------------------------------------------

router.post("/signup/create-order", authRateLimiter, async (req, res) => {
  const requestId = req.requestId || crypto.randomUUID();

  try {
    const {
      name,
      phoneNo,
      password,
      gender,
      type,
      experience,
      sharedBy,
      cd,
      fcmToken,
      validPhoneNoId,
      agreedToTnCnP,
    } = req.body;

    // ======================================================
    // FCM TOKEN LOG
    // ======================================================

    VendorLogger.info(
      {
        requestId,
        phoneNo: phoneNo ? String(phoneNo).slice(-4) : null,
        hasFcmToken: Boolean(fcmToken),
        fcmTokenLength: fcmToken ? String(fcmToken).length : 0,
      },
      "Vendor signup create-order request received",
    );

    // ======================================================
    // VALIDATION
    // ======================================================

    const cleanName = String(name || "").trim();
    const cleanPhone = String(phoneNo || "").trim();
    const cleanPassword = String(password || "");

    if (!cleanName) {
      return res.status(400).json({
        success: false,
        message: "Name is required",
      });
    }

    if (!/^\d{10}$/.test(cleanPhone)) {
      return res.status(400).json({
        success: false,
        message: "Valid 10 digit phone number is required",
      });
    }

    const phoneNumber = Number(cleanPhone);

    if (cleanPassword.length < 6) {
      return res.status(400).json({
        success: false,
        message: "Password must be at least 6 characters",
      });
    }
    // if (!validPhoneNoId) {
    //   return res.status(400).json({
    //     message: "Phone verification is required",
    //   });
    // }
    // await OtpAuthorizationService.consume({
    //   otpId: validPhoneNoId,
    //   accountType: "vendor",
    //   accountId: null,
    //   purpose: "verify_phone",
    //   target: phoneNumber,
    // });
    // ======================================================
    // JOBS
    // ======================================================

    if (!Array.isArray(type) || type.length < 1 || type.length > 5) {
      return res.status(400).json({
        success: false,
        message: "Select between 1 and 5 jobs",
      });
    }

    const jobs = [...new Set(type.map((job) => String(job || "").trim()).filter(Boolean))];

    if (jobs.length < 1 || jobs.length > 5) {
      return res.status(400).json({
        success: false,
        message: "Select between 1 and 5 jobs",
      });
    }

    // ======================================================
    // TERMS
    // ======================================================

    if (!agreedToTnCnP) {
      return res.status(400).json({
        success: false,
        message: "Terms and conditions are required",
      });
    }

    // ======================================================
    // CHECK EXISTING VENDOR
    // ======================================================

    const [existingUser, existingVendor] = await Promise.all([
      User.exists({
        phoneNo: phoneNumber,
      }),
      Vendor.exists({
        phoneNo: phoneNumber,
      }),
    ]);

    if (existingVendor || existingUser) {
      VendorLogger.warn(
        {
          requestId,
          phoneNo: cleanPhone.slice(-4),
        },
        "Vendor signup blocked because number already exists",
      );

      return res.status(409).json({
        success: false,
        message: "Mobile number already exists!",
      });
    }

    // ======================================================
    // SIGNUP TOKEN
    // ======================================================

    const signupToken = crypto.randomBytes(32).toString("hex");

    // ======================================================
    // HASH PASSWORD
    // ======================================================

    const hashedPw = await bcrypt.hash(cleanPassword, ENV.BCRYPT_ROUNDS || 10);

    // ======================================================
    // CREATE TEMPORARY SIGNUP
    // ======================================================

    const signupPayment = await VendorSignupPayment.create({
      signupToken,

      name: cleanName,

      phoneNo: phoneNumber,

      password: hashedPw,

      gender: String(gender || ""),

      type: jobs,

      experience: Number(experience) || 0,

      sharedBy: String(sharedBy || ""),

      cd: String(cd || ""),

      validPhoneNoId: String(validPhoneNoId || ""),

      agreedToTnCnP: true,

      amount: VENDOR_SIGNUP_AMOUNT,

      status: "created",

      // ==================================================
      // FCM TOKEN
      // ==================================================

      fcmToken: String(fcmToken || "").trim(),

      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    });

    VendorLogger.info(
      {
        requestId,

        signupId: signupPayment._id?.toString(),

        hasFcmToken: Boolean(signupPayment.fcmToken),

        fcmTokenLength: signupPayment.fcmToken?.length || 0,

        phoneNo: cleanPhone.slice(-4),
      },
      "Vendor signup payment session created",
    );

    // ======================================================
    // RAZORPAY ORDER
    // ======================================================

    const shortReceipt = `vs_${Date.now()}_${Math.floor(Math.random() * 10000)}`;

    const order = await razorpay.orders.create({
      amount: 5000,
      currency: "INR",
      receipt: shortReceipt,

      notes: {
        purpose: "vendor_signup",
        signupToken,
      },
    });

    VendorLogger.info(
      {
        requestId,

        signupId: signupPayment._id?.toString(),

        razorpayOrderId: order.id,

        amount: order.amount,

        currency: order.currency,
      },
      "Vendor signup Razorpay order created",
    );

    // ======================================================
    // TRANSACTION
    // ======================================================

    const transaction = await Transaction.create({
      amount: 50,

      finalAmount: 50,

      currency: "INR",

      paymentGateway: "razorpay",

      razorpayOrderId: order.id,

      gatewayOrderId: order.id,

      status: "initiated",

      paymentStatus: "pending",

      category: "vendor_signup",

      requestId,

      metadata: {
        orderId: order.id,

        requestedAmount: 50,

        currency: "INR",

        gateway: "razorpay",

        signupToken,

        signupPayment: true,
      },
    });

    VendorLogger.info(
      {
        requestId,

        transactionId: transaction._id?.toString(),

        razorpayOrderId: order.id,

        amount: transaction.finalAmount,

        category: transaction.category,
      },
      "Vendor signup transaction created",
    );

    // ======================================================
    // SAVE ORDER ID
    // ======================================================

    await VendorSignupPayment.updateOne(
      {
        signupToken,
      },
      {
        $set: {
          razorpayOrderId: order.id,
        },
      },
    );

    VendorLogger.info(
      {
        requestId,

        signupId: signupPayment._id?.toString(),

        razorpayOrderId: order.id,
      },
      "Vendor signup Razorpay order linked to signup",
    );

    // ======================================================
    // RESPONSE
    // ======================================================

    return res.status(200).json({
      success: true,

      signupToken,

      order: {
        id: order.id,

        amount: order.amount,

        currency: order.currency,

        key: process.env.RAZORPAY_KEY_ID,
      },
    });
  } catch (error) {
    VendorLogger.error(
      {
        requestId,

        error: error.message,

        code: error.code || null,

        stack: error.stack,
      },
      "Vendor signup create-order failed",
    );

    return res.status(500).json({
      success: false,
      message: "Unable to create signup payment",
    });
  }
});

// ============================================================
// VERIFY VENDOR SIGNUP PAYMENT
// ============================================================

router.post("/signup/verify-payment", authRateLimiter, async (req, res) => {
  const session = await mongoose.startSession();

  const requestId = req.requestId || crypto.randomUUID();

  try {
    const { signupToken, razorpay_payment_id, razorpay_order_id, razorpay_signature } = req.body;

    // ======================================================
    // VERIFY REQUEST RECEIVED
    // ======================================================

    VendorLogger.info(
      {
        requestId,

        signupToken: signupToken ? `${signupToken.substring(0, 10)}...` : null,

        razorpayPaymentId: razorpay_payment_id || null,

        razorpayOrderId: razorpay_order_id || null,

        hasSignature: Boolean(razorpay_signature),
      },
      "Vendor signup payment verification started",
    );

    // ======================================================
    // BASIC VALIDATION
    // ======================================================

    if (!signupToken || !razorpay_payment_id || !razorpay_order_id || !razorpay_signature) {
      VendorLogger.warn(
        {
          requestId,
        },
        "Vendor signup payment verification validation failed",
      );

      return res.status(400).json({
        success: false,
        message: "Invalid payment information",
      });
    }

    // ======================================================
    // FIND SIGNUP
    // ======================================================

    const signup = await VendorSignupPayment.findOne({
      signupToken,
    });

    if (!signup) {
      VendorLogger.warn(
        {
          requestId,

          signupToken: `${signupToken.substring(0, 10)}...`,
        },
        "Vendor signup payment session not found",
      );

      return res.status(404).json({
        success: false,
        message: "Signup payment session not found",
      });
    }

    // ======================================================
    // SIGNUP / FCM LOG
    // ======================================================

    VendorLogger.info(
      {
        requestId,

        signupId: signup._id?.toString(),

        status: signup.status,

        vendorId: signup.vendorId?.toString() || null,

        hasFcmToken: Boolean(signup.fcmToken),

        fcmTokenLength: signup.fcmToken?.length || 0,

        phoneNo: signup.phoneNo ? String(signup.phoneNo).slice(-4) : null,
      },
      "Vendor signup payment session loaded",
    );

    // ======================================================
    // IDEMPOTENCY
    // ======================================================

    if (signup.status === "paid" && signup.vendorId) {
      const vendor = await Vendor.findById(signup.vendorId).select("_id balance fcmToken").lean();

      VendorLogger.info(
        {
          requestId,

          signupId: signup._id?.toString(),

          vendorId: signup.vendorId?.toString(),

          balance: vendor?.balance ?? null,

          hasFcmToken: Boolean(vendor?.fcmToken),
        },
        "Vendor signup payment already completed",
      );

      return res.status(200).json({
        success: true,

        message: "Vendor account already created",

        vendorId: signup.vendorId,

        balance: vendor?.balance ?? 300,

        idempotent: true,
      });
    }

    // ======================================================
    // EXPIRY
    // ======================================================

    if (signup.expiresAt && signup.expiresAt < new Date()) {
      await VendorSignupPayment.updateOne(
        {
          _id: signup._id,
          status: "created",
        },
        {
          $set: {
            status: "expired",
          },
        },
      );

      VendorLogger.warn(
        {
          requestId,

          signupId: signup._id?.toString(),
        },
        "Vendor signup payment session expired",
      );

      return res.status(400).json({
        success: false,
        message: "Signup payment session expired. Please try again.",
      });
    }

    // ======================================================
    // ORDER MATCH
    // ======================================================

    if (signup.razorpayOrderId !== razorpay_order_id) {
      VendorLogger.warn(
        {
          requestId,

          signupId: signup._id?.toString(),

          expectedOrderId: signup.razorpayOrderId,

          receivedOrderId: razorpay_order_id,
        },
        "Vendor signup Razorpay order mismatch",
      );

      return res.status(400).json({
        success: false,
        message: "Invalid Razorpay order",
        code: "ORDER_ID_MISMATCH",
      });
    }

    // ======================================================
    // SIGNATURE
    // ======================================================

    try {
      PaymentService.verifySignature(razorpay_order_id, razorpay_payment_id, razorpay_signature);
    } catch (error) {
      VendorLogger.warn(
        {
          requestId,

          signupId: signup._id?.toString(),

          razorpayPaymentId: razorpay_payment_id,

          error: error.message,
        },
        "Vendor signup Razorpay signature verification failed",
      );

      return res.status(400).json({
        success: false,

        message: error.message || "Payment signature verification failed",

        code: error.code || "SIGNATURE_VERIFICATION_FAILED",
      });
    }

    // ======================================================
    // FETCH PAYMENT
    // ======================================================

    let payment;

    try {
      payment = await razorpay.payments.fetch(razorpay_payment_id);
    } catch (error) {
      VendorLogger.error(
        {
          requestId,

          signupId: signup._id?.toString(),

          razorpayPaymentId: razorpay_payment_id,

          error: error.message,

          stack: error.stack,
        },
        "Razorpay payment fetch failed",
      );

      return res.status(502).json({
        success: false,

        message: "Unable to verify payment with Razorpay",

        code: "RAZORPAY_API_ERROR",
      });
    }

    // ======================================================
    // PAYMENT STATUS
    // ======================================================

    if (payment.status !== "captured" || payment.captured !== true) {
      VendorLogger.warn(
        {
          requestId,

          signupId: signup._id?.toString(),

          razorpayPaymentId: razorpay_payment_id,

          paymentStatus: payment.status,

          captured: payment.captured,
        },
        "Vendor signup payment not captured",
      );

      return res.status(400).json({
        success: false,

        message: "Payment has not been captured",

        code: "PAYMENT_NOT_CAPTURED",
      });
    }

    // ======================================================
    // DATABASE TRANSACTION
    // ======================================================

    let createdVendor = null;
    let completedTransaction = null;
    let paymentResult = null;

    await session.withTransaction(async () => {
      // ==================================================
      // FIND TRANSACTION
      // ==================================================

      let transaction = await Transaction.findOne({
        razorpayOrderId: signup.razorpayOrderId,

        category: "vendor_signup",

        paymentGateway: "razorpay",
      }).session(session);

      if (!transaction) {
        const error = new Error("Signup payment transaction not found");

        error.code = "TRANSACTION_NOT_FOUND";

        throw error;
      }

      VendorLogger.info(
        {
          requestId,

          transactionId: transaction._id?.toString(),

          status: transaction.status,

          vendorId: transaction.vendorId?.toString() || null,

          amount: transaction.finalAmount,
        },
        "Vendor signup transaction loaded",
      );

      // ==================================================
      // ALREADY COMPLETED
      // ==================================================

      if (transaction.status === "completed" && transaction.vendorId) {
        createdVendor = await Vendor.findById(transaction.vendorId).session(session);

        completedTransaction = transaction;

        VendorLogger.info(
          {
            requestId,

            transactionId: transaction._id?.toString(),

            vendorId: transaction.vendorId?.toString(),
          },
          "Vendor signup transaction already completed",
        );

        return;
      }

      // ==================================================
      // LOCK
      // ==================================================

      const lockResult = await PaymentService.acquireProcessingLock(
        razorpay_order_id,
        razorpay_payment_id,
        razorpay_signature,
        session,
      );

      if (lockResult.alreadyCompleted) {
        transaction = lockResult.transaction;

        completedTransaction = transaction;

        if (transaction.vendorId) {
          createdVendor = await Vendor.findById(transaction.vendorId).session(session);
        }

        VendorLogger.info(
          {
            requestId,

            transactionId: transaction._id?.toString(),

            vendorId: transaction.vendorId?.toString() || null,
          },
          "Vendor signup payment already processed by another request",
        );

        return;
      }

      if (!lockResult.locked) {
        const error = new Error("Unable to acquire payment processing lock");

        error.code = "LOCK_ACQUISITION_FAILED";

        throw error;
      }

      transaction = lockResult.transaction;

      // ==================================================
      // EXISTING VENDOR
      // ==================================================

      const existingVendor = await Vendor.findOne({
        phoneNo: signup.phoneNo,
      })
        .select("_id")
        .session(session);

      if (existingVendor) {
        const error = new Error("Vendor with this mobile number already exists");

        error.code = "VENDOR_ALREADY_EXISTS";

        throw error;
      }

      // ==================================================
      // CREATE VENDOR
      // ₹250 FREE
      // ==================================================

      const [vendor] = await Vendor.create(
        [
          {
            name: signup.name,

            phoneNo: signup.phoneNo,

            verifyPhoneNo: true,

            email: "",

            verifyEmail: false,

            password: signup.password,

            type: signup.type,

            experience: signup.experience,

            gender: signup.gender,

            shareBy: signup.sharedBy,

            cd: signup.cd,

            validPhoneNoId: signup.validPhoneNoId,

            agreedToTnCnP: signup.agreedToTnCnP,

            // ======================================
            // ₹250 FREE
            // ======================================

            balance: 250,

            commission: 50,

            fcmToken: String(signup.fcmToken || "").trim(),

            status: "active",
          },
        ],
        {
          session,
        },
      );

      if (!vendor?._id) {
        const error = new Error("Vendor creation failed");

        error.code = "VENDOR_CREATION_FAILED";

        throw error;
      }

      createdVendor = vendor;

      VendorLogger.info(
        {
          requestId,

          vendorId: vendor._id?.toString(),

          balance: vendor.balance,

          hasFcmToken: Boolean(vendor.fcmToken),

          fcmTokenLength: vendor.fcmToken?.length || 0,
        },
        "Vendor created successfully with signup",
      );

      // ==================================================
      // LINK VENDOR TO TRANSACTION
      // ==================================================

      transaction.vendorId = vendor._id;

      transaction.category = "vendor_signup";

      await transaction.save({
        session,
      });

      VendorLogger.info(
        {
          requestId,

          transactionId: transaction._id?.toString(),

          vendorId: transaction.vendorId?.toString(),

          balanceBeforePayment: vendor.balance,

          paymentAmount: transaction.finalAmount,
        },
        "Vendor linked to signup transaction",
      );

      // ==================================================
      // PROCESS ₹50
      // ₹250 + ₹50 = ₹300
      // ==================================================

      paymentResult = await PaymentService.processSuccessfulPayment({
        transaction,

        paymentId: razorpay_payment_id,

        paymentMethod: payment.method || "razorpay",

        source: "api",

        requestId: transaction.requestId || requestId,

        ipAddress: req.ip || null,

        session,

        existingPayment: payment,
      });

      VendorLogger.info(
        {
          requestId,

          transactionId: paymentResult?.updatedTransaction?._id?.toString() || null,

          vendorId: paymentResult?.creditedEntity?._id?.toString() || null,

          finalAmount: paymentResult?.updatedTransaction?.finalAmount ?? null,

          balance: paymentResult?.creditedEntity?.balance ?? null,

          hasFcmToken: Boolean(paymentResult?.creditedEntity?.fcmToken),

          fcmTokenLength: paymentResult?.creditedEntity?.fcmToken?.length || 0,
        },
        "Vendor signup ₹50 payment processed",
      );

      if (!paymentResult || !paymentResult.updatedTransaction) {
        const error = new Error("Payment transaction could not be completed");

        error.code = "PAYMENT_PROCESSING_FAILED";

        throw error;
      }

      completedTransaction = paymentResult.updatedTransaction;

      // ==================================================
      // LINK SIGNUP PAYMENT
      // ==================================================

      await VendorSignupPayment.updateOne(
        {
          _id: signup._id,
        },
        {
          $set: {
            vendorId: vendor._id,

            razorpayPaymentId: razorpay_payment_id,

            status: "paid",

            paidAt: new Date(),
          },
        },
        {
          session,
        },
      );

      VendorLogger.info(
        {
          requestId,

          signupId: signup._id?.toString(),

          vendorId: vendor._id?.toString(),

          transactionId: completedTransaction?._id?.toString(),

          status: "paid",
        },
        "Vendor signup payment session marked paid",
      );
    });

    // ======================================================
    // FINAL VENDOR
    // ======================================================

    const finalVendor = await Vendor.findById(createdVendor?._id || completedTransaction?.vendorId)
      .select("_id balance fcmToken")
      .lean();

    if (!finalVendor) {
      VendorLogger.error(
        {
          requestId,

          vendorId:
            createdVendor?._id?.toString() || completedTransaction?.vendorId?.toString() || null,
        },
        "Vendor created but could not be loaded after payment",
      );

      return res.status(500).json({
        success: false,

        message: "Vendor was created but could not be loaded",

        code: "VENDOR_FETCH_FAILED",
      });
    }

    // ======================================================
    // SUCCESS NOTIFICATION
    // ======================================================

    const { creditedEntity, updatedTransaction } = paymentResult || {};

    VendorLogger.info(
      {
        requestId,

        vendorId: creditedEntity?._id?.toString() || finalVendor._id?.toString() || null,

        transactionId:
          updatedTransaction?._id?.toString() || completedTransaction?._id?.toString() || null,

        amount: updatedTransaction?.finalAmount ?? completedTransaction?.finalAmount ?? null,

        balance: finalVendor.balance,

        hasCreditedEntity: Boolean(creditedEntity),

        hasUpdatedTransaction: Boolean(updatedTransaction),

        hasFcmToken: Boolean(creditedEntity?.fcmToken || finalVendor.fcmToken),

        fcmTokenLength: creditedEntity?.fcmToken?.length || finalVendor.fcmToken?.length || 0,
      },
      "Preparing vendor payment success notification",
    );

    if (creditedEntity && updatedTransaction) {
      try {
        await PaymentService.sendSuccessNotification(
          creditedEntity,
          updatedTransaction.finalAmount,
          updatedTransaction,
          requestId,
        );

        VendorLogger.info(
          {
            requestId,

            vendorId: creditedEntity._id?.toString(),

            transactionId: updatedTransaction._id?.toString(),

            amount: updatedTransaction.finalAmount,
          },
          "Vendor payment success notification sent",
        );
      } catch (notificationError) {
        VendorLogger.error(
          {
            requestId,

            vendorId: creditedEntity?._id?.toString() || null,

            transactionId: updatedTransaction?._id?.toString() || null,

            error: notificationError.message,

            stack: notificationError.stack,
          },
          "Vendor payment success notification failed",
        );

        // Payment has already succeeded.
        // Notification failure must NOT
        // make the signup fail.
      }
    } else {
      VendorLogger.warn(
        {
          requestId,

          hasCreditedEntity: Boolean(creditedEntity),

          hasUpdatedTransaction: Boolean(updatedTransaction),
        },
        "Vendor payment success notification skipped",
      );
    }

    // ======================================================
    // SUCCESS
    // ======================================================

    VendorLogger.info(
      {
        requestId,

        vendorId: finalVendor._id?.toString(),

        balance: finalVendor.balance,

        transactionId: completedTransaction?._id?.toString(),

        transactionStatus: completedTransaction?.status,

        paymentStatus: completedTransaction?.paymentStatus,

        paymentId: razorpay_payment_id,

        amount: completedTransaction?.finalAmount,

        hasFcmToken: Boolean(finalVendor.fcmToken),
      },
      "Vendor signup completed successfully",
    );

    return res.status(200).json({
      success: true,

      message: "Vendor signup successful",

      vendorId: finalVendor._id,

      balance: finalVendor.balance,

      payment: {
        paymentId: razorpay_payment_id,

        orderId: razorpay_order_id,

        amount: payment.amount,

        currency: payment.currency,

        status: payment.status,
      },

      transaction: {
        id: completedTransaction?._id,

        status: completedTransaction?.status,

        paymentStatus: completedTransaction?.paymentStatus,

        amount: completedTransaction?.finalAmount,

        vendorId: completedTransaction?.vendorId,
      },

      idempotent: false,
    });
  } catch (error) {
    VendorLogger.error(
      {
        requestId,

        error: error.message,

        code: error.code || null,

        stack: error.stack,

        signupToken: req.body?.signupToken ? `${req.body.signupToken.substring(0, 10)}...` : null,

        razorpayPaymentId: req.body?.razorpay_payment_id || null,

        razorpayOrderId: req.body?.razorpay_order_id || null,
      },
      "Vendor signup payment verification failed",
    );

    // ====================================================
    // EXISTING VENDOR
    // ====================================================

    if (error.code === "VENDOR_ALREADY_EXISTS") {
      return res.status(409).json({
        success: false,

        message: "Vendor with this mobile number already exists",

        code: error.code,
      });
    }

    // ====================================================
    // TRANSACTION NOT FOUND
    // ====================================================

    if (error.code === "TRANSACTION_NOT_FOUND") {
      return res.status(404).json({
        success: false,

        message: "Signup payment transaction not found",

        code: error.code,
      });
    }

    // ====================================================
    // PAYMENT ALREADY PROCESSING
    // ====================================================

    if (error.code === "PAYMENT_ALREADY_PROCESSING") {
      return res.status(409).json({
        success: false,

        message: "Payment is already being processed. Please wait.",

        code: error.code,
      });
    }

    // ====================================================
    // DUPLICATE KEY
    // ====================================================

    if (error.code === 11000) {
      return res.status(409).json({
        success: false,

        message: "Vendor or payment record already exists",

        code: "DUPLICATE_RECORD",
      });
    }

    // ====================================================
    // DEFAULT
    // ====================================================

    return res.status(500).json({
      success: false,

      message: error.message || "Unable to complete vendor signup",

      code: error.code || "VENDOR_SIGNUP_VERIFICATION_FAILED",
    });
  } finally {
    await session.endSession();
  }
});

//-----------------------------------------------------------
//
//----------------------------------------------
router.post("/login", authRateLimiter, vendor_auth.login);

router.patch("/edit/password", authRateLimiter, vendor_controller.vendor_controller_patch_password);

// --- Authenticated endpoints ----------------------------------------

router.patch(
  "/update/address",
  authenticate,
  is_vendor,
  vendor_controller.vendor_controller_patch_address,
);
router.patch("/edit/name", authenticate, vendor_controller.vendor_controller_patch_name);
router.patch(
  "/edit/fcmToken",
  authenticate,
  is_vendor,
  vendor_controller.vendor_controller_patch_fcmToken,
);

router.patch(
  "/wageRate",
  authenticate,
  is_vendor,
  vendor_controller.vendor_controller_patch_wageRate,
);

router.get(
  "/getBookings/:vendorId/:month/:year",
  authenticate,
  is_vendor,
  vendor_controller.vendor_controller_getBookings,
);
router.get(
  "/getOrders/:vendorId/:pageNo",
  authenticate,
  is_vendor,
  vendor_controller.vendor_controller_getOrders,
);
router.get(
  "/getShare/:vendorId/:skip",
  is_vendor,
  authenticate,
  vendor_controller.vendor_controller_getShare,
);
router.get(
  "/getVendorByVendor/:vendorId",
  authenticate,
  is_vendor,
  vendor_controller.vendor_controller_getVendor,
);

/////////////////////
//// for user ///////
////////////////////

router.get(
  "/getAll/:type/:pincode/:bookingDate/:page/:minRating/:minWageRate",
  authenticate,
  is_user,
  vendor_controller.vendor_controller_getAvailableVendor,
);
router.get(
  "/getAllV/:type/:pincode/:bookingDate/:page/:minRating/:minWageRate",
  authenticate,
  is_vendor,
  vendor_controller.vendor_controller_getAvailableVendor,
);
router.get("/getOne/:vendorId", authenticate, is_user, vendor_controller.vendor_controller_getOne);

router.get(
  "/getEarnings/:vendorId",
  authenticate,
  is_vendor,
  vendor_controller.vendor_controller_getEarnings,
);
router.get(
  "/getAttendance/:vendorId/:month/:year",
  authenticate,
  is_vendor,
  vendor_controller.vendor_controller_getAttendance,
);
router.post(
  "/postAttendance/:vendorId",
  authenticate,
  is_vendor,
  vendor_controller.vendor_controller_postAttendance,
);

// Leave Management Routes
router
  .get("/getLeaveStats", is_vendor, authenticate, vendor_controller.getLeaves)
  .post("/createLeave", is_vendor, authenticate, vendor_controller.createLeave);

router
  .route("/cancelLeave/:leaveId")
  .delete(is_vendor, authenticate, vendor_controller.cancelLeave);

router.get("/availability", authenticate, vendor_controller.checkAvailability);

module.exports = router;
