const crypto = require("crypto"); // PHASE 3: Added missing import
const paymentService = require("../src/services/paymentService");
const { PaymentLogger } = require("../src/logger/index");
const { validatePagination } = require("../middleware/validation");
const ENV = require("../src/config/env");

/**
 * Create a Razorpay order
 */

const create_order = async (req, res) => {
  try {
    const userId = req.user?._id || req.body.userId || null;
    const vendorId = req.vendor?._id || req.body.vendorId || null;

    const category = req.user ? "user" : req.vendor ? "vendor" : req.body.category || "user";

    const amount = Number(req.body.amount);

    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({
        success: false,
        code: "INVALID_AMOUNT",
        error: "Recharge amount must be a valid positive number.",
      });
    }

    const orderData = {
      amount,
      currency: req.body.currency || "INR",
      receipt: req.body.receipt,
      userId,
      vendorId,
      category,

      ipAddress: req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip,

      userAgent: req.headers["user-agent"],

      paymentGateway: req.body.paymentGateway || "razorpay",

      requestId: req.headers["x-request-id"] || crypto.randomUUID(),
    };

    const result = await paymentService.createOrder(orderData);

    return res.status(200).json({
      success: true,
      ...result,
    });
  } catch (error) {
    PaymentLogger.error(
      {
        err: error,
        requestId: req.headers["x-request-id"],
      },
      "Order creation failed",
    );

    const statusCode = error.message?.includes("not found")
      ? 404
      : error.message?.includes("Invalid")
        ? 400
        : 500;

    return res.status(statusCode).json({
      success: false,
      code: error.code || "ORDER_CREATION_FAILED",
      error: error.message || "Order creation failed",
    });
  }
};

/**
 * Verify payment signature and credit balance
 */
const payment_verification = async (req, res) => {
  try {
    const userId = req.user?._id || req.body.userId || null;
    const vendorId = req.vendor?._id || req.body.vendorId || null;

    const verificationData = {
      razorpay_order_id: req.body.razorpay_order_id,
      razorpay_payment_id: req.body.razorpay_payment_id,
      razorpay_signature: req.body.razorpay_signature,

      userId,
      vendorId,

      requestId: req.headers["x-request-id"] || crypto.randomUUID(),

      ipAddress: req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip,
    };

    const result = await paymentService.verifyPayment(verificationData);

    return res.status(200).json(result);
  } catch (error) {
    PaymentLogger.error(
      {
        err: error,
        requestId: req.headers["x-request-id"],
        orderId: req.body.razorpay_order_id,
        paymentId: req.body.razorpay_payment_id,
      },
      "Payment verification failed",
    );

    let status = 500;
    let code = "VERIFICATION_FAILED";

    switch (true) {
      case error.message?.includes("signature"):
        status = 400;
        code = "INVALID_SIGNATURE";
        break;

      case error.message?.includes("processing"):
        status = 409;
        code = "CONCURRENT_PROCESSING";
        break;

      case error.message?.includes("not found"):
        status = 404;
        code = "TRANSACTION_NOT_FOUND";
        break;

      case error.message?.includes("mismatch"):
        status = 400;
        code = "AMOUNT_MISMATCH";
        break;

      case error.message?.includes("already verified"):
        status = 409;
        code = "ALREADY_VERIFIED";
        break;

      case error.message?.includes("already credited"):
        status = 409;
        code = "ALREADY_CREDITED";
        break;
    }

    return res.status(status).json({
      success: false,
      code,
      message: error.message || "Payment verification failed",
    });
  }
};

/**
 * Handle Razorpay webhooks
 */

const webhook_handler = async (req, res) => {
  let payload = null;
  PaymentLogger.info(
    {
      isBuffer: Buffer.isBuffer(req.body),
      constructor: req.body?.constructor?.name,
      contentType: req.headers["content-type"],
      bodyLength: Buffer.isBuffer(req.body) ? req.body.length : JSON.stringify(req.body).length,
      webhookSecretLength: ENV.RAZORPAY_WEBHOOK_SECRET?.length,
    },
    "WEBHOOK_DEBUG",
  );
  try {
    // express.raw() provides req.body as a Buffer
    const rawBody = req.body;

    if (!Buffer.isBuffer(rawBody)) {
      PaymentLogger.error(
        {
          bodyType: typeof rawBody,
          bodyConstructor: rawBody?.constructor?.name,
        },
        "Webhook body is not a Buffer. express.raw() middleware is missing.",
      );

      return res.status(500).json({
        success: false,
        message: "Webhook body parsing failed",
      });
    }

    const webhookSignature = req.headers["x-razorpay-signature"];
    const webhookSecret = ENV.RAZORPAY_WEBHOOK_SECRET;

    if (!webhookSignature || !webhookSecret) {
      PaymentLogger.warn(
        {
          hasSignature: !!webhookSignature,
          hasSecret: !!webhookSecret,
        },
        "Webhook signature or secret missing",
      );

      return res.status(401).json({
        success: false,
        message: "Unauthorized",
      });
    }

    // Verify Razorpay signature using RAW body
    const generatedSignature = crypto
      .createHmac("sha256", webhookSecret)
      .update(rawBody)
      .digest("hex");

    const sigBuf = Buffer.from(webhookSignature, "utf8");
    const genBuf = Buffer.from(generatedSignature, "utf8");

    if (sigBuf.length !== genBuf.length || !crypto.timingSafeEqual(sigBuf, genBuf)) {
      PaymentLogger.warn(
        {
          webhookSignature,
          generatedSignature,
          ip: req.ip,
        },
        "Invalid webhook signature",
      );

      return res.status(401).json({
        success: false,
        message: "Invalid signature",
      });
    }

    // Parse JSON AFTER successful verification
    try {
      payload = JSON.parse(rawBody.toString("utf8"));
    } catch (err) {
      PaymentLogger.error(
        {
          error: err.message,
        },
        "Invalid webhook JSON payload",
      );

      return res.status(400).json({
        success: false,
        message: "Invalid JSON payload",
      });
    }

    PaymentLogger.info(
      {
        event: payload.event,
        webhookId: req.headers["x-razorpay-webhook-id"],
        ip: req.ip,
        userAgent: req.headers["user-agent"],
        timestamp: new Date().toISOString(),
      },
      "Webhook received with valid signature",
    );

    // Process webhook
    const result = await paymentService.processWebhook(payload);

    return res.status(200).json(result);
  } catch (error) {
    PaymentLogger.error(
      {
        error,
        event: payload?.event,
      },
      "Webhook processing failed",
    );

    // Always acknowledge webhook to avoid unnecessary retries
    return res.status(200).json({
      success: false,
      processed: false,
      message: error.message,
      code: error.code || "WEBHOOK_PROCESSING_FAILED",
    });
  }
};

/**
 * Track abandoned payment
 */
const trackAbandonedPayment = async (req, res) => {
  try {
    const userId = req.user?._id || req.body.userId;
    const vendorId = req.vendor?._id || req.body.vendorId;

    const data = {
      orderId: req.body.orderId || req.body.razorpay_order_id,
      amount: req.body.amount || 0,
      userId: userId,
      vendorId: vendorId,
      category: req.user ? "user" : req.vendor ? "vendor" : req.body.category || "user",
      ipAddress: req.ip || req.headers["x-forwarded-for"] || req.connection.remoteAddress,
      requestId: req.headers["x-request-id"] || crypto.randomUUID(),
    };

    const result = await paymentService.trackAbandonedPayment(data);
    return res.status(200).json(result);
  } catch (error) {
    PaymentLogger.error(
      { error, requestId: req.headers["x-request-id"] },
      "Error tracking abandoned payment",
    );
    return res.status(400).json({
      success: false,
      message: error.message || "Failed to track abandoned payment",
      code: "ABANDONED_TRACKING_FAILED",
    });
  }
};

/**
 * Track payment failure
 */
const trackPaymentFailure = async (req, res) => {
  try {
    const userId = req.user?._id || req.body.userId;
    const vendorId = req.vendor?._id || req.body.vendorId;

    const data = {
      orderId: req.body.orderId || req.body.razorpay_order_id,
      amount: req.body.amount || 0,
      userId: userId,
      vendorId: vendorId,
      category: req.user ? "user" : req.vendor ? "vendor" : req.body.category || "user",
      error: req.body.error,
      errorCode: req.body.errorCode,
      errorDescription: req.body.errorDescription,
      ipAddress: req.ip || req.headers["x-forwarded-for"] || req.connection.remoteAddress,
      requestId: req.headers["x-request-id"] || crypto.randomUUID(),
    };

    const result = await paymentService.trackPaymentFailure(data);
    return res.status(200).json(result);
  } catch (error) {
    PaymentLogger.error(
      { error, requestId: req.headers["x-request-id"] },
      "Error tracking payment failure",
    );
    return res.status(400).json({
      success: false,
      message: error.message || "Failed to track payment failure",
      code: "FAILURE_TRACKING_FAILED",
    });
  }
};

/**
 * Get transaction history
 */
const getTransactionHistory = async (req, res) => {
  try {
    // Validate pagination
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 100);

    // Use authenticated user/vendor ID or from query params
    const userId = req.user?._id || req.query.userId;
    const vendorId = req.vendor?._id || req.query.vendorId;

    const filters = {
      userId: userId,
      vendorId: vendorId,
      status: req.query.status,
      limit: limit,
      page: page,
    };

    const result = await paymentService.getTransactionHistory(filters);
    return res.status(200).json({
      success: true,
      ...result,
    });
  } catch (error) {
    PaymentLogger.error(
      { error, requestId: req.headers["x-request-id"] },
      "Error fetching transaction history",
    );
    return res.status(500).json({
      success: false,
      message: "Failed to fetch transaction history",
      code: "HISTORY_FETCH_FAILED",
    });
  }
};

/**
 * Get transaction statistics
 */
const getTransactionStats = async (req, res) => {
  try {
    const userId = req.user?._id || req.query.userId;
    const vendorId = req.vendor?._id || req.query.vendorId;

    const filters = {
      userId: userId,
      vendorId: vendorId,
    };
    const result = await paymentService.getTransactionStats(filters);
    return res.status(200).json({
      success: true,
      ...result,
      user: {
        id: userId || vendorId,
        role: req.user ? "user" : req.vendor ? "vendor" : "unknown",
      },
    });
  } catch (error) {
    PaymentLogger.error(
      { error, requestId: req.headers["x-request-id"] },
      "Error fetching transaction stats",
    );
    return res.status(500).json({
      success: false,
      message: "Failed to fetch transaction statistics",
      code: "STATS_FETCH_FAILED",
    });
  }
};

// Export all functions
module.exports = {
  create_order,
  payment_verification,
  webhook_handler,
  trackAbandonedPayment,
  trackPaymentFailure,
  getTransactionHistory,
  getTransactionStats,
};
