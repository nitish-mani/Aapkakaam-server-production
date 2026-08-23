"use strict";

const crypto = require("crypto");
const mongoose = require("mongoose");
const ENV = require("../config/env");
const razorpay = require("../../controller/razorpay");

const NotificationService = require("./NotificationService");
const WalletService = require("./WalletService");
const { PaymentLogger } = require("../logger/index");
// Models
const User = require("../../models/user");
const Vendor = require("../../models/vendor");
const Transaction = require("../../models/transaction");
const WebhookProcess = require("../../models/webhookProcess");
const { getPricing } = require("../config/pricing");
const PaymentSource = Object.freeze({
  API: "api",
  WEBHOOK: "webhook",
  RECONCILIATION: "reconciliation",
});

class PaymentService {
  /**
   * Create Razorpay order with server-side pricing validation
   */
  async createOrder(orderData) {
    const {
      amount,
      currency = "INR",
      receipt,
      userId,
      vendorId,
      category = "user",
      paymentGateway = "razorpay",
      requestId,
      ipAddress,
      userAgent,
    } = orderData;

    PaymentLogger.info(
      {
        event: "PAYMENT_ORDER_CREATE_STARTED",
        requestId,
        requestedAmount: amount,
        category,
        userId,
        vendorId,
        gateway: paymentGateway,
      },
      "Payment order creation started",
    );

    // Validate request amount
    const validatedAmount = this.validateAmount(amount);

    const pricing = getPricing(validatedAmount, category);

    // Validate entity
    await this.validateEntity(userId, vendorId);

    // Resolve trusted server-side pricing

    PaymentLogger.debug(
      {
        event: "PAYMENT_PRICING_RESOLVED",
        requestId,
        requestedAmount: amount,
        originalAmount: pricing.originalAmount,
        payableAmount: pricing.payableAmount,
        discount: pricing.discount,
        discountPercent: pricing.discountPercent,
        category,
      },
      "Server-side pricing resolved",
    );

    // Create Razorpay order using the SERVER-CALCULATED payable amount
    const order = await razorpay.orders.create({
      amount: Math.round(pricing.payableAmount * 100),
      currency,
      receipt: receipt || `rcpt_${Date.now()}`,
      notes: {
        userId: userId?.toString() || "",
        vendorId: vendorId?.toString() || "",
        category,
        originalAmount: pricing.originalAmount.toString(),
        payableAmount: pricing.payableAmount.toString(),
      },
    });

    const session = await mongoose.startSession();

    let transaction;

    try {
      await session.withTransaction(async () => {
        const transactionData = {
          // Pricing
          amount: pricing.originalAmount,
          finalAmount: pricing.payableAmount,
          discount: pricing.discount,
          discountPercent: pricing.discountPercent,

          currency,

          // Gateway
          razorpayOrderId: order.id,
          gatewayOrderId: order.id,
          paymentGateway,

          // Status
          status: "initiated",
          initiatedAt: new Date(),

          category,

          // Request Info
          ipAddress,
          userAgent,
          requestId: requestId || crypto.randomUUID(),

          metadata: {
            orderId: order.id,
            requestedAmount: amount,
            originalAmount: pricing.originalAmount,
            payableAmount: pricing.payableAmount,
            gateway: paymentGateway,
          },
        };

        if (userId) transactionData.userId = userId;
        if (vendorId) transactionData.vendorId = vendorId;

        [transaction] = await Transaction.create([transactionData], {
          session,
        });
      });

      PaymentLogger.info(
        {
          event: "PAYMENT_ORDER_CREATED",
          requestId,
          transactionId: transaction._id,
          razorpayOrderId: order.id,
          requestedAmount: amount,
          originalAmount: pricing.originalAmount,
          payableAmount: pricing.payableAmount,
          discount: pricing.discount,
          discountPercent: pricing.discountPercent,
          category,
          userId,
          vendorId,
        },
        "Payment order created successfully",
      );

      return {
        success: true,
        order,
        pricing: {
          originalAmount: pricing.originalAmount,
          payableAmount: pricing.payableAmount,
          discount: pricing.discount,
          discountPercent: pricing.discountPercent,
        },
        transaction: {
          id: transaction._id,
          status: transaction.status,
        },
      };
    } catch (error) {
      PaymentLogger.error(
        {
          err: error,
          event: "PAYMENT_ORDER_CREATE_FAILED",
          requestId,
          orderId: order?.id,
          requestedAmount: amount,
          category,
          userId,
          vendorId,
        },
        "Failed to create payment order",
      );

      throw error;
    } finally {
      await session.endSession();
    }
  }

  /**
   * Acquire processing lock with standardized error codes
   */
  async acquireProcessingLock(orderId, paymentId, signature, session) {
    PaymentLogger.debug(
      {
        event: "PAYMENT_LOCK_REQUEST",
        orderId,
        paymentId,
      },
      "Attempting to acquire payment processing lock",
    );

    const transaction = await Transaction.findOneAndUpdate(
      {
        razorpayOrderId: orderId,
        status: "initiated",
      },
      {
        $set: {
          status: "processing",
          processingStartedAt: new Date(),
          razorpayPaymentId: paymentId,
          razorpaySignature: signature,
        },
      },
      {
        new: true,
        session,
      },
    );

    if (transaction) {
      PaymentLogger.info(
        {
          event: "PAYMENT_LOCK_ACQUIRED",
          transactionId: transaction._id,
          orderId,
          paymentId,
          userId: transaction.userId,
          vendorId: transaction.vendorId,
        },
        "Payment processing lock acquired",
      );

      return {
        transaction,
        locked: true,
        alreadyCompleted: false,
      };
    }

    // Transaction was not in initiated state, inspect current status
    const existing = await Transaction.findOne({
      razorpayOrderId: orderId,
    })
      .select("_id status razorpayPaymentId razorpayOrderId userId vendorId amount finalAmount")
      .lean()
      .session(session);

    if (!existing) {
      PaymentLogger.warn(
        {
          event: "PAYMENT_TRANSACTION_NOT_FOUND",
          orderId,
          paymentId,
        },
        "Transaction not found while acquiring payment lock",
      );

      const error = new Error("Transaction not found");
      error.code = "TRANSACTION_NOT_FOUND";
      throw error;
    }

    switch (existing.status) {
      case "completed":
        PaymentLogger.info(
          {
            event: "PAYMENT_ALREADY_COMPLETED",
            transactionId: existing._id,
            orderId,
            paymentId: existing.razorpayPaymentId,
          },
          "Payment already completed",
        );

        return {
          transaction: existing,
          locked: false,
          alreadyCompleted: true,
        };

      case "processing":
        PaymentLogger.warn(
          {
            event: "PAYMENT_ALREADY_PROCESSING",
            transactionId: existing._id,
            orderId,
            paymentId,
          },
          "Payment is already being processed",
        );

        const error = new Error("Payment is already being processed. Please wait.");
        error.code = "PAYMENT_ALREADY_PROCESSING";
        throw error;

      default:
        PaymentLogger.warn(
          {
            event: "PAYMENT_INVALID_STATE",
            transactionId: existing._id,
            orderId,
            currentStatus: existing.status,
          },
          "Payment cannot be processed from current state",
        );

        const stateError = new Error(`Payment is in ${existing.status} state. Cannot process.`);
        stateError.code = "INVALID_PAYMENT_STATE";
        throw stateError;
    }
  }

  /**
   * Verify payment with idempotency and ownership checks
   */
  async verifyPayment(verificationData) {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      userId,
      vendorId,
      requestId = crypto.randomUUID(),
      ipAddress,
    } = verificationData;

    const startTime = Date.now();

    PaymentLogger.info(
      {
        event: "PAYMENT_VERIFY_STARTED",
        requestId,
        orderId: razorpay_order_id,
        paymentId: razorpay_payment_id,
        userId,
        vendorId,
      },
      "Payment verification started",
    );

    // Validate required fields
    this.validatePaymentFields(razorpay_order_id, razorpay_payment_id, razorpay_signature);

    // Verify signature
    this.verifySignature(razorpay_order_id, razorpay_payment_id, razorpay_signature);

    const session = await mongoose.startSession();

    try {
      let transaction;
      let creditedEntity;
      let updatedTransaction;
      let isIdempotent = false;
      let razorpayPayment = null;

      await session.withTransaction(async () => {
        // Acquire atomic lock
        const {
          transaction: lockedTransaction,
          locked,
          alreadyCompleted,
        } = await this.acquireProcessingLock(
          razorpay_order_id,
          razorpay_payment_id,
          razorpay_signature,
          session,
        );

        transaction = lockedTransaction;

        if (alreadyCompleted) {
          isIdempotent = true;
          PaymentLogger.info(
            {
              event: "PAYMENT_ALREADY_COMPLETED",
              requestId,
              transactionId: transaction._id,
              orderId: transaction.razorpayOrderId,
              paymentId: transaction.razorpayPaymentId,
              userId: transaction.userId,
              vendorId: transaction.vendorId,
            },
            "Payment already completed - returning idempotent response",
          );
          return;
        }

        if (!locked) {
          const error = new Error("Failed to acquire processing lock");
          error.code = "LOCK_ACQUISITION_FAILED";
          throw error;
        }

        PaymentLogger.info(
          {
            event: "PAYMENT_LOCK_ACQUIRED",
            requestId,
            transactionId: transaction._id,
            orderId: razorpay_order_id,
            paymentId: razorpay_payment_id,
            userId: transaction.userId,
            vendorId: transaction.vendorId,
            category: transaction.category,
          },
          "Payment processing lock acquired",
        );

        // Ownership validation
        await this.validateOwnership(transaction, userId, vendorId);

        PaymentLogger.debug(
          {
            event: "PAYMENT_OWNERSHIP_VALIDATED",
            requestId,
            transactionId: transaction._id,
            userId: transaction.userId,
            vendorId: transaction.vendorId,
          },
          "Payment ownership validated",
        );

        // Verify with Razorpay API - this fetches AND validates the payment
        // Returns the complete payment object
        razorpayPayment = await this.verifyWithRazorpay(transaction, razorpay_payment_id);

        PaymentLogger.info(
          {
            event: "PAYMENT_GATEWAY_VERIFIED",
            requestId,
            transactionId: transaction._id,
            orderId: razorpay_order_id,
            paymentId: razorpay_payment_id,
            amount: transaction.amount,
            razorpayAmount: razorpayPayment.amount / 100,
          },
          "Razorpay payment verified successfully",
        );

        // Process successful payment - pass the existing payment object
        const result = await this.processSuccessfulPayment({
          transaction,
          paymentId: razorpay_payment_id,
          paymentMethod: "razorpay",
          source: PaymentSource.API,
          requestId,
          ipAddress,
          session,
          existingPayment: razorpayPayment, // Pass to avoid duplicate fetch
        });

        updatedTransaction = result.updatedTransaction;
        creditedEntity = result.creditedEntity;

        PaymentLogger.info(
          {
            event: "PAYMENT_COMPLETED",
            requestId,
            transactionId: updatedTransaction._id,
            orderId: updatedTransaction.razorpayOrderId,
            paymentId: updatedTransaction.razorpayPaymentId,
            userId: updatedTransaction.userId,
            vendorId: updatedTransaction.vendorId,
            amount: updatedTransaction.amount,
            discount: updatedTransaction.discount,
            discountPercent: updatedTransaction.discountPercent,
            finalAmount: updatedTransaction.finalAmount,
            category: updatedTransaction.category,
            duration: Date.now() - startTime,
          },
          "Payment verification completed",
        );
      });

      // Handle idempotent response
      if (isIdempotent) {
        const entity = await this.getEntity(transaction);
        return {
          success: true,
          payment_id: transaction.razorpayPaymentId,
          order_id: transaction.razorpayOrderId,
          balance: entity?.balance ?? 0,
          totalDiscount: entity?.totalDiscount || 0,
          transactionCount: entity?.transactionCount || 0,
          totalOriginalAmount: entity?.totalOriginalAmount || 0,
          transaction,
          idempotent: true,
          message: "Payment already completed",
        };
      }

      // Send notification (outside transaction)
      if (creditedEntity && updatedTransaction) {
        console.log("notification", creditedEntity);
        await this.sendSuccessNotification(
          creditedEntity,
          updatedTransaction.finalAmount,
          updatedTransaction,
          requestId,
        );
      }

      return {
        success: true,
        payment_id: updatedTransaction.razorpayPaymentId,
        order_id: updatedTransaction.razorpayOrderId,
        balance: creditedEntity?.balance || 0,
        totalDiscount: creditedEntity?.totalDiscount || 0,
        transactionCount: creditedEntity?.transactionCount || 0,
        totalOriginalAmount: creditedEntity?.totalOriginalAmount || 0,
        transaction: updatedTransaction,
      };
    } catch (error) {
      if (!error.code) {
        error.code = "VERIFICATION_FAILED";
      }

      PaymentLogger.error(
        {
          err: error,
          event: "PAYMENT_VERIFY_FAILED",
          requestId,
          orderId: razorpay_order_id,
          paymentId: razorpay_payment_id,
          userId,
          vendorId,
          duration: Date.now() - startTime,
        },
        "Payment verification failed",
      );

      const terminalErrorCodes = [
        "PAYMENT_ALREADY_COMPLETED",
        "PAYMENT_ALREADY_PROCESSING",
        "TRANSACTION_NOT_FOUND",
        "INVALID_PAYMENT_STATE",
      ];

      if (!terminalErrorCodes.includes(error.code)) {
        await this.markTransactionFailed(razorpay_order_id, error);
      }

      throw error;
    } finally {
      await session.endSession();
    }
  }

  /**
   * Verify payment with Razorpay API
   */
  /**
   * Verify payment with Razorpay API
   * This is the SINGLE source for Razorpay payment fetching and validation
   * @param {Object} transaction - Transaction document
   * @param {String} razorpayPaymentId - Razorpay payment ID
   * @returns {Object} Complete Razorpay payment object
   */
  async verifyWithRazorpay(transaction, razorpayPaymentId) {
    PaymentLogger.debug(
      {
        event: "RAZORPAY_VERIFICATION_STARTED",
        transactionId: transaction._id,
        orderId: transaction.razorpayOrderId,
        paymentId: razorpayPaymentId,
      },
      "Starting Razorpay payment verification",
    );

    try {
      // Fetch payment once - this is the ONLY fetch call
      const payment = await razorpay.payments.fetch(razorpayPaymentId);

      // Validate payment state
      const validationErrors = [];

      if (payment.status !== "captured") {
        validationErrors.push({
          field: "status",
          expected: "captured",
          actual: payment.status,
          code: "PAYMENT_NOT_CAPTURED",
        });
      }

      if (payment.order_id !== transaction.razorpayOrderId) {
        validationErrors.push({
          field: "order_id",
          expected: transaction.razorpayOrderId,
          actual: payment.order_id,
          code: "ORDER_ID_MISMATCH",
        });
      }

      // Note: verifyAmount will handle amount validation separately
      // using finalAmount (discount-aware)
      if (payment.currency !== (transaction.currency || "INR")) {
        validationErrors.push({
          field: "currency",
          expected: transaction.currency || "INR",
          actual: payment.currency,
          code: "CURRENCY_MISMATCH",
        });
      }

      if (payment.captured !== true) {
        validationErrors.push({
          field: "captured",
          expected: true,
          actual: payment.captured,
          code: "PAYMENT_NOT_CAPTURED",
        });
      }

      // If any validation failed, throw with details
      if (validationErrors.length > 0) {
        const errorMessage = validationErrors
          .map((e) => `${e.field}: expected ${e.expected}, got ${e.actual}`)
          .join("; ");

        PaymentLogger.warn(
          {
            event: "RAZORPAY_VERIFICATION_FAILED",
            transactionId: transaction._id,
            orderId: transaction.razorpayOrderId,
            paymentId: razorpayPaymentId,
            validationErrors,
          },
          "Razorpay verification validation failed",
        );

        const error = new Error(errorMessage);
        error.code = validationErrors[0].code;
        error.validationErrors = validationErrors;
        throw error;
      }

      PaymentLogger.info(
        {
          event: "RAZORPAY_VERIFICATION_SUCCESS",
          transactionId: transaction._id,
          orderId: transaction.razorpayOrderId,
          paymentId: razorpayPaymentId,
          amount: payment.amount / 100,
          currency: payment.currency,
          status: payment.status,
          method: payment.method,
        },
        "Razorpay payment verified successfully",
      );

      // Return the complete payment object
      return payment;
    } catch (error) {
      // If this is already one of our business errors,
      // don't wrap it.
      if (error.code) {
        throw error;
      }

      // Only wrap unexpected SDK/network errors.
      const wrappedError = new Error(`Failed to communicate with Razorpay: ${error.message}`);

      wrappedError.code = "RAZORPAY_API_ERROR";
      wrappedError.originalError = error;

      throw wrappedError;
    }
  }

  /**
   * Process webhook events from Razorpay with atomic idempotency
   * using unique index and lease timeout mechanism
   */
  async processWebhook(webhookData) {
    const startTime = Date.now();
    const { event, payload } = webhookData;
    const webhookId = webhookData.webhook_id || `wh_${event}_${Date.now()}`;

    PaymentLogger.info(
      {
        event: "WEBHOOK_STARTED",
        webhookId,
        webhookEvent: event,
        timestamp: webhookData.created_at,
      },
      "Processing webhook event",
    );

    // Extract identifiers from payload for early validation
    let orderId, paymentId, refundId;

    try {
      switch (event) {
        case "payment.captured":
        case "payment.failed":
          orderId = payload.payment.entity.order_id;
          paymentId = payload.payment.entity.id;
          break;
        case "order.paid":
          orderId = payload.order.entity.id;
          break;
        case "refund.created":
        case "refund.processed":
        case "refund.failed":
          paymentId = payload.refund.entity.payment_id;
          refundId = payload.refund.entity.id;
          break;
        default:
          PaymentLogger.info(
            {
              event: "WEBHOOK_EVENT_IGNORED",
              webhookId,
              webhookEvent: event,
            },
            "Unhandled webhook event",
          );
          return {
            success: true,
            message: "Event ignored",
            processed: false,
            idempotent: true,
          };
      }

      // Validate we have required identifiers
      if (!orderId && !paymentId && !refundId) {
        PaymentLogger.warn(
          {
            event: "WEBHOOK_MISSING_IDENTIFIERS",
            webhookId,
            webhookEvent: event,
          },
          "Webhook missing required identifiers",
        );
        return {
          success: true,
          message: "Missing identifiers - cannot process",
          processed: false,
          idempotent: true,
        };
      }

      // Process webhook with atomic idempotency
      const result = await this.processWebhookWithAtomicIdempotency(
        webhookId,
        event,
        payload,
        orderId,
        paymentId,
        refundId,
      );

      PaymentLogger.info(
        {
          event: "WEBHOOK_COMPLETED",
          webhookId,
          webhookEvent: event,
          transactionId: result?.transaction?._id,
          idempotent: result?.idempotent || false,
          duration: Date.now() - startTime,
        },
        "Webhook processed successfully",
      );

      return {
        success: true,
        transaction: result?.transaction,
        message: result?.idempotent
          ? "Webhook already processed"
          : result?.message || "Webhook processed",
        idempotent: result?.idempotent || false,
        processed: !result?.idempotent,
      };
    } catch (error) {
      // Ensure error has a code
      if (!error.code) {
        error.code = "WEBHOOK_PROCESSING_FAILED";
      }

      PaymentLogger.error(
        {
          event: "WEBHOOK_FAILED",
          webhookId,
          webhookEvent: event,
          orderId,
          paymentId,
          refundId,
          error: {
            message: error.message,
            code: error.code,
            stack: process.env.NODE_ENV === "production" ? undefined : error.stack,
          },
          duration: Date.now() - startTime,
        },
        "Webhook processing failed",
      );

      throw error;
    }
  }

  /**
   * Process webhook with atomic idempotency using dedicated WebhookProcess collection
   * with unique index on webhookId and lease timeout mechanism
   */
  async processWebhookWithAtomicIdempotency(
    webhookId,
    event,
    payload,
    orderId,
    paymentId,
    refundId,
  ) {
    const LEASE_DURATION_MS = 300000; // 5 minutes
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + LEASE_DURATION_MS);

    let session;
    let result;
    let isIdempotent = false;

    try {
      // First, try to claim the webhook atomically using unique index
      let webhookRecord;

      try {
        // Attempt to create the webhook record with unique webhookId
        // If it already exists, this will throw E11000 duplicate key error
        webhookRecord = await WebhookProcess.create({
          webhookId,
          event,
          orderId,
          paymentId,
          refundId,
          status: "processing",
          claimedAt: now,
          leaseExpiresAt: leaseExpiresAt,
        });

        PaymentLogger.info(
          {
            event: "WEBHOOK_CLAIMED_ATOMICALLY",
            webhookId,
            webhookEvent: event,
            leaseExpiresAt,
          },
          "Webhook atomically claimed for processing",
        );
      } catch (error) {
        // Handle duplicate key error - webhook already exists
        if (error.code === 11000) {
          PaymentLogger.info(
            {
              event: "WEBHOOK_ALREADY_EXISTS",
              webhookId,
              webhookEvent: event,
            },
            "Webhook already exists - checking status",
          );

          // Webhook exists, check its status
          const existingRecord = await WebhookProcess.findOne({ webhookId }).lean();

          // If already completed, return idempotent response
          if (existingRecord.status === "completed") {
            isIdempotent = true;
            PaymentLogger.info(
              {
                event: "WEBHOOK_ALREADY_PROCESSED",
                webhookId,
                webhookEvent: event,
                processedAt: existingRecord.processedAt,
              },
              "Webhook already processed - idempotent response",
            );

            return {
              success: true,
              transaction: existingRecord.result?.transactionId
                ? await Transaction.findById(existingRecord.result.transactionId).lean()
                : null,
              message: "Webhook already processed",
              idempotent: true,
            };
          }

          // If status is 'processing', check lease
          if (existingRecord.status === "processing") {
            const leaseExpired = existingRecord.leaseExpiresAt < now;

            if (!leaseExpired) {
              // Lease is still valid - another instance is processing
              PaymentLogger.warn(
                {
                  event: "WEBHOOK_ACTIVE_PROCESSING",
                  webhookId,
                  webhookEvent: event,
                  leaseExpiresAt: existingRecord.leaseExpiresAt,
                },
                "Webhook is being processed by another instance",
              );

              // Return retryable response - webhook will be retried by Razorpay
              const retryError = new Error("Webhook is being processed by another instance");
              retryError.code = "WEBHOOK_CONCURRENT_PROCESSING";
              retryError.retryable = true;
              throw retryError;
            }

            // Lease has expired - we can reclaim it
            PaymentLogger.warn(
              {
                event: "WEBHOOK_LEASE_EXPIRED",
                webhookId,
                webhookEvent: event,
                leaseExpiresAt: existingRecord.leaseExpiresAt,
              },
              "Webhook lease expired - reclaiming",
            );

            // Reclaim the webhook by updating it
            webhookRecord = await WebhookProcess.findOneAndUpdate(
              {
                webhookId,
                status: "processing",
                leaseExpiresAt: { $lt: now },
              },
              {
                $set: {
                  status: "processing",
                  claimedAt: now,
                  leaseExpiresAt: leaseExpiresAt,
                  updatedAt: now,
                },
              },
              {
                new: true,
                lean: true,
              },
            );

            if (!webhookRecord) {
              // Another instance reclaimed it first
              PaymentLogger.warn(
                {
                  event: "WEBHOOK_RECLAIM_RACE",
                  webhookId,
                  webhookEvent: event,
                },
                "Race condition - another instance reclaimed the webhook",
              );

              const retryError = new Error("Webhook was reclaimed by another instance");
              retryError.code = "WEBHOOK_CONCURRENT_PROCESSING";
              retryError.retryable = true;
              throw retryError;
            }

            PaymentLogger.info(
              {
                event: "WEBHOOK_RECLAIMED",
                webhookId,
                webhookEvent: event,
                newLeaseExpiresAt: leaseExpiresAt,
              },
              "Webhook successfully reclaimed",
            );
          }

          // If status is 'failed', we can retry
          if (existingRecord.status === "failed") {
            PaymentLogger.info(
              {
                event: "WEBHOOK_RETRYING",
                webhookId,
                webhookEvent: event,
                failedAt: existingRecord.failedAt,
              },
              "Webhook failed previously - retrying",
            );

            // Update to processing for retry
            webhookRecord = await WebhookProcess.findOneAndUpdate(
              {
                webhookId,
                status: "failed",
              },
              {
                $set: {
                  status: "processing",
                  claimedAt: now,
                  leaseExpiresAt: leaseExpiresAt,
                  updatedAt: now,
                },
                $unset: {
                  failedAt: 1,
                  error: 1,
                },
              },
              {
                new: true,
                lean: true,
              },
            );

            if (!webhookRecord) {
              // Another instance retried it first
              PaymentLogger.warn(
                {
                  event: "WEBHOOK_RETRY_RACE",
                  webhookId,
                  webhookEvent: event,
                },
                "Race condition - another instance retried the webhook",
              );

              const retryError = new Error("Webhook retry race condition");
              retryError.code = "WEBHOOK_CONCURRENT_PROCESSING";
              retryError.retryable = true;
              throw retryError;
            }
          }

          // If we got here, we have a valid webhookRecord to process
          if (!webhookRecord) {
            // This shouldn't happen, but just in case
            const error = new Error("Unable to claim webhook");
            error.code = "WEBHOOK_CLAIM_FAILED";
            throw error;
          }
        } else {
          // Some other error occurred
          throw error;
        }
      }

      // At this point, we have successfully claimed the webhook
      // Now process it inside a MongoDB transaction

      try {
        // Create a new session for the payment transaction
        session = await mongoose.startSession();

        await session.withTransaction(async () => {
          // Process the webhook based on event type
          switch (event) {
            case "payment.captured":
              result = await this.handlePaymentCaptured(payload, webhookId, session);
              break;
            case "payment.failed":
              result = await this.handlePaymentFailed(payload, webhookId, session);
              break;
            case "order.paid":
              result = await this.handleOrderPaid(payload, webhookId, session);
              break;
            case "refund.created":
              result = await this.handleRefundCreated(payload, webhookId, session);
              break;
            case "refund.processed":
              result = await this.handleRefundProcessed(payload, webhookId, session);
              break;
            case "refund.failed":
              result = await this.handleRefundFailed(payload, webhookId, session);
              break;
            default:
              result = {
                success: true,
                message: "Event ignored",
                processed: false,
                idempotent: true,
              };
          }
        });

        // Transaction committed successfully - mark webhook as completed
        // IMPORTANT: Do this OUTSIDE the transaction to avoid session issues
        if (result && !result.idempotent) {
          await WebhookProcess.findOneAndUpdate(
            {
              webhookId: webhookId,
              status: "processing",
            },
            {
              $set: {
                status: "completed",
                processedAt: new Date(),
                result: {
                  success: result.success,
                  transactionId: result.transaction?._id,
                  message: result.message,
                },
              },
            },
          );

          PaymentLogger.info(
            {
              event: "WEBHOOK_MARKED_COMPLETED",
              webhookId,
              webhookEvent: event,
            },
            "Webhook marked as completed",
          );
        }
      } catch (processingError) {
        // Processing failed - mark webhook as failed (outside transaction)
        // Use a separate session or no session at all
        try {
          await WebhookProcess.findOneAndUpdate(
            {
              webhookId: webhookId,
              status: "processing",
            },
            {
              $set: {
                status: "failed",
                failedAt: new Date(),
                error: {
                  message: processingError.message,
                  code: processingError.code || "PROCESSING_ERROR",
                },
              },
            },
          );

          PaymentLogger.error(
            {
              event: "WEBHOOK_MARKED_FAILED",
              webhookId,
              webhookEvent: event,
              error: processingError.message,
            },
            "Webhook marked as failed",
          );
        } catch (updateError) {
          // Log but don't fail - the webhook will retry with lease expiration
          PaymentLogger.error(
            {
              event: "WEBHOOK_FAILED_UPDATE_ERROR",
              webhookId,
              error: updateError.message,
            },
            "Failed to mark webhook as failed",
          );
        }

        throw processingError;
      }

      // Send notifications outside transaction (only for non-idempotent events)
      if (result && !result.idempotent && !isIdempotent && result.transaction) {
        if (event === "payment.captured") {
          const entity = await this.getEntity(result.transaction);
          if (entity) {
            await this.sendSuccessNotification(
              entity,
              result.transaction.finalAmount,
              result.transaction,
              `webhook_${webhookId}`,
            );
          }
        }
      }

      return {
        ...result,
        idempotent: isIdempotent || result?.idempotent || false,
      };
    } catch (error) {
      // For concurrent processing, just rethrow
      if (error.code === "WEBHOOK_CONCURRENT_PROCESSING") {
        throw error;
      }

      // For other errors, ensure error has code
      if (!error.code) {
        error.code = "WEBHOOK_PROCESSING_FAILED";
      }

      throw error;
    } finally {
      // Clean up session if it exists and is still open
      if (session && session.inTransaction()) {
        await session.abortTransaction();
      }
      if (session) {
        await session.endSession();
      }
    }
  }

  /**
   * Handle payment.captured webhook with atomic race-safety
   */
  async handlePaymentCaptured(payload, webhookId, session) {
    const startTime = Date.now();
    const paymentEntity = payload.payment.entity;
    const { order_id, amount } = paymentEntity;
    const payment_id = paymentEntity.id || paymentEntity.payment_id;

    PaymentLogger.info(
      {
        event: "WEBHOOK_PAYMENT_CAPTURED_STARTED",
        webhookId,
        orderId: order_id,
        paymentId: payment_id,
        webhookAmount: amount,
      },
      "Processing payment.captured webhook",
    );

    let transaction;
    let updatedTransaction;
    let creditedEntity;
    let isIdempotent = false;

    // Find transaction
    transaction = await Transaction.findOne({
      razorpayOrderId: order_id,
    })
      .select("_id status amount finalAmount discount userId vendorId category currency")
      .session(session);

    if (!transaction) {
      const error = new Error(`Transaction not found for order: ${order_id}`);
      error.code = "TRANSACTION_NOT_FOUND";
      throw error;
    }

    // Idempotency check - already completed
    if (transaction.status === "completed") {
      isIdempotent = true;
      updatedTransaction = transaction;

      PaymentLogger.info(
        {
          event: "WEBHOOK_ALREADY_COMPLETED",
          webhookId,
          transactionId: transaction._id,
          orderId: order_id,
          paymentId: payment_id,
        },
        "Payment already completed - idempotent response",
      );

      return {
        success: true,
        transaction: updatedTransaction,
        message: "Already processed",
        idempotent: true,
      };
    }

    // ATOMIC LOCK
    const lockedTransaction = await Transaction.findOneAndUpdate(
      {
        _id: transaction._id,
        status: "initiated",
      },
      {
        $set: {
          status: "processing",
          processingStartedAt: new Date(),
          razorpayPaymentId: payment_id,
          razorpaySignature: "webhook_captured",
        },
      },
      {
        new: true,
        session,
      },
    );

    if (!lockedTransaction) {
      const existing = await Transaction.findById(transaction._id).session(session);

      if (existing?.status === "completed") {
        isIdempotent = true;
        updatedTransaction = existing;

        return {
          success: true,
          transaction: updatedTransaction,
          message: "Already processed",
          idempotent: true,
        };
      }

      if (existing?.status === "processing") {
        const error = new Error("Payment is already being processed");
        error.code = "PAYMENT_ALREADY_PROCESSING";
        error.retryable = true;
        throw error;
      }

      const error = new Error("Failed to acquire processing lock");
      error.code = "LOCK_ACQUISITION_FAILED";
      throw error;
    }

    // REUSE WEBHOOK PAYLOAD - No additional Razorpay API call
    // The webhook payload already contains the payment entity
    const webhookPaymentEntity = payload.payment.entity;

    PaymentLogger.debug(
      {
        event: "WEBHOOK_REUSING_PAYLOAD",
        webhookId,
        transactionId: lockedTransaction._id,
        paymentId: payment_id,
        webhookStatus: webhookPaymentEntity.status,
        webhookAmount: webhookPaymentEntity.amount,
      },
      "Reusing webhook payload for payment verification",
    );

    // Convert webhook payment entity to match Razorpay API response format
    // The webhook payload is already the same structure as the API response
    const razorpayPayment = webhookPaymentEntity;

    // Process successful payment using webhook payload
    // Pass the webhook payment entity to avoid another API call
    const result = await this.processSuccessfulPayment({
      transaction: lockedTransaction,
      paymentId: payment_id,
      paymentMethod: "razorpay",
      source: PaymentSource.WEBHOOK,
      requestId: webhookId,
      ipAddress: null,
      session,
      existingPayment: razorpayPayment, // Reuse webhook payload - NO API CALL
    });

    updatedTransaction = result.updatedTransaction;
    creditedEntity = result.creditedEntity;

    PaymentLogger.info(
      {
        event: "WEBHOOK_WALLET_UPDATED",
        webhookId,
        transactionId: lockedTransaction._id,
        orderId: order_id,
        paymentId: payment_id,
        userId: lockedTransaction.userId,
        vendorId: lockedTransaction.vendorId,
        creditedAmount: lockedTransaction.finalAmount,
        newBalance: creditedEntity.balance,
      },
      "Wallet credited via webhook",
    );

    PaymentLogger.info(
      {
        event: "WEBHOOK_PAYMENT_CAPTURED_COMPLETED",
        webhookId,
        transactionId: updatedTransaction._id,
        orderId: order_id,
        paymentId: payment_id,
        duration: Date.now() - startTime,
      },
      "Payment captured webhook processed successfully",
    );

    return {
      success: true,
      transaction: updatedTransaction,
      message: "Payment captured and processed",
      idempotent: false,
    };
  }

  /**
   * Single source of truth for successful payment completion
   * @private
   */
  async processSuccessfulPayment({
    transaction,
    paymentId,
    paymentMethod = "razorpay",
    source = PaymentSource.API,
    requestId = crypto.randomUUID(),
    ipAddress = null,
    session,
    existingPayment = null, // Optional pre-fetched Razorpay payment
  }) {
    const startTime = Date.now();

    // Generate deterministic identifiers (not stored in Transaction)
    const idempotencyKey = `payment_${transaction.razorpayOrderId}`;
    const financialOperationId = `payment_${transaction.razorpayOrderId}`;

    PaymentLogger.info(
      {
        event: "PROCESS_SUCCESSFUL_PAYMENT_STARTED",
        requestId,
        transactionId: transaction._id,
        orderId: transaction.razorpayOrderId,
        paymentId,
        source,
        userId: transaction.userId,
        vendorId: transaction.vendorId,
        idempotencyKey,
        financialOperationId,
      },
      "Starting successful payment processing",
    );

    // 1. Verify payment amount using stored finalAmount
    // Pass existing payment if available to avoid duplicate Razorpay calls

    await this.verifyAmount(transaction, existingPayment);

    PaymentLogger.info(
      {
        event: "PROCESS_PAYMENT_AMOUNT_VERIFIED",
        requestId,
        transactionId: transaction._id,
        orderId: transaction.razorpayOrderId,
        paymentId,
        finalAmount: transaction.finalAmount,
        source,
      },
      "Payment amount verified successfully",
    );
    // 2. Credit wallet with stored finalAmount and deterministic IDs
    const creditedEntity = await this.creditBalanceWithAudit(
      transaction,
      transaction.finalAmount,
      session,
      idempotencyKey,
      financialOperationId,
      source,
      { requestId, ipAddress },
    );
    console.log("creditEntity", creditedEntity);
    PaymentLogger.info(
      {
        event: "PROCESS_PAYMENT_WALLET_CREDITED",
        requestId,
        transactionId: transaction._id,
        userId: transaction.userId,
        vendorId: transaction.vendorId,
        creditedAmount: transaction.finalAmount,
        newBalance: creditedEntity.balance,
        source,
        idempotencyKey,
        financialOperationId,
      },
      "Wallet credited successfully",
    );

    // 3. Build update object based on source
    // Do NOT store derived idempotency values in Transaction
    const updateData = {
      status: "completed",
      completedAt: new Date(),
      paymentMethod: paymentMethod,
      razorpayPaymentId: paymentId,
      gatewayPaymentId: paymentId,
      completedBy: source, // NEW
    };

    // Only set webhook flags when source is webhook
    if (source === PaymentSource.WEBHOOK) {
      updateData.webhookProcessed = true;
      updateData.webhookProcessedAt = new Date();
    }

    // 4. Update transaction - no derived values stored
    const updatedTransaction = await Transaction.findOneAndUpdate(
      {
        _id: transaction._id,
        status: "processing",
      },
      {
        $set: updateData,
      },
      {
        new: true,
        session,
        select:
          "_id status amount discount discountPercent finalAmount razorpayOrderId razorpayPaymentId userId vendorId category completedAt paymentMethod webhookProcessed webhookProcessedAt",
      },
    );

    if (!updatedTransaction) {
      const error = new Error("Failed to update transaction status");
      error.code = "TRANSACTION_UPDATE_FAILED";
      throw error;
    }

    PaymentLogger.info(
      {
        event: "PROCESS_SUCCESSFUL_PAYMENT_COMPLETED",
        requestId,
        transactionId: updatedTransaction._id,
        orderId: updatedTransaction.razorpayOrderId,
        paymentId,
        source,
        duration: Date.now() - startTime,
        idempotencyKey, // Logged but not stored
        financialOperationId, // Logged but not stored
      },
      "Successful payment processing completed",
    );

    return {
      updatedTransaction,
      creditedEntity,
    };
  }

  /**
   * Handle payment.failed webhook with atomic race-safety
   */
  async handlePaymentFailed(payload, webhookId, session) {
    const startTime = Date.now();
    const paymentEntity = payload.payment.entity;
    const { order_id, error_code, error_description } = paymentEntity;
    const payment_id = paymentEntity.id || paymentEntity.payment_id;

    PaymentLogger.info(
      {
        event: "WEBHOOK_PAYMENT_FAILED_STARTED",
        webhookId,
        orderId: order_id,
        paymentId: payment_id,
        errorCode: error_code,
        errorDescription: error_description,
      },
      "Processing payment.failed webhook",
    );

    const transaction = await Transaction.findOneAndUpdate(
      {
        razorpayOrderId: order_id,
        status: { $in: ["initiated", "processing"] },
      },
      {
        $set: {
          status: "failed",
          failedAt: new Date(),
          errorCode: error_code || "PAYMENT_FAILED",
          errorDescription: error_description || "Payment failed via webhook",
          webhookProcessed: true,
          webhookProcessedAt: new Date(),
        },
      },
      {
        new: true,
        session,
        select: "_id status razorpayOrderId userId vendorId",
      },
    );

    if (!transaction) {
      const existing = await Transaction.findOne({
        razorpayOrderId: order_id,
      }).session(session);

      if (existing) {
        return {
          success: true,
          transaction: existing,
          message: "Failure already recorded",
          idempotent: true,
        };
      }

      const error = new Error(`Transaction not found for order: ${order_id}`);
      error.code = "TRANSACTION_NOT_FOUND";
      throw error;
    }

    PaymentLogger.info(
      {
        event: "WEBHOOK_PAYMENT_FAILED_COMPLETED",
        webhookId,
        transactionId: transaction._id,
        orderId: order_id,
        paymentId: payment_id,
        errorCode: error_code,
        duration: Date.now() - startTime,
      },
      "Payment failed webhook processed successfully",
    );

    return {
      success: true,
      transaction,
      message: "Payment failure recorded",
      idempotent: false,
    };
  }

  /**
   * Validate client supplied payment amount.
   * This only validates the input value.
   * Final pricing is determined by getPricing().
   */
  validateAmount(amount) {
    const numericAmount = Number(amount);

    if (!Number.isFinite(numericAmount)) {
      const error = new Error("Invalid payment amount");
      error.code = "INVALID_AMOUNT";
      throw error;
    }

    if (numericAmount <= 0) {
      const error = new Error("Amount must be greater than zero");
      error.code = "INVALID_AMOUNT";
      throw error;
    }

    // Prevent unrealistic values
    if (numericAmount > 1000000) {
      const error = new Error("Amount exceeds maximum allowed limit");
      error.code = "AMOUNT_TOO_LARGE";
      throw error;
    }

    return numericAmount;
  }

  /**
   * Handle order.paid webhook
   */
  async handleOrderPaid(payload, webhookId, session) {
    const { id, amount } = payload.order.entity;

    PaymentLogger.info(
      {
        event: "WEBHOOK_ORDER_PAID",
        webhookId,
        orderId: id,
        amount,
      },
      "Order paid webhook received - no action required",
    );

    return {
      success: true,
      message: "Order paid processed",
      orderId: id,
      processed: false,
      idempotent: true,
    };
  }

  /**
   * Handle refund.created webhook with atomic race-safety
   */
  async handleRefundCreated(payload, webhookId, session) {
    const startTime = Date.now();
    const { payment_id, amount, status, id: refundId } = payload.refund.entity;

    PaymentLogger.info(
      {
        event: "WEBHOOK_REFUND_CREATED_STARTED",
        webhookId,
        refundId,
        paymentId: payment_id,
        refundAmount: amount / 100,
        status,
      },
      "Processing refund.created webhook",
    );

    const transaction = await Transaction.findOneAndUpdate(
      {
        razorpayPaymentId: payment_id,
        status: "completed",
        refundStatus: { $ne: "processed" },
        $or: [{ refundId: { $ne: refundId } }, { refundId: { $exists: false } }],
      },
      {
        $set: {
          refundAmount: amount / 100,
          refundStatus: "pending",
          refundId: refundId,
          refundRequestedAt: new Date(),
        },
      },
      {
        new: true,
        session,
        select: "_id refundId refundStatus razorpayPaymentId",
      },
    );

    if (!transaction) {
      const existing = await Transaction.findOne({
        razorpayPaymentId: payment_id,
      }).session(session);

      if (existing?.refundId === refundId) {
        return {
          success: true,
          transaction: existing,
          message: "Refund already created",
          idempotent: true,
        };
      }

      if (existing?.refundStatus === "processed") {
        const error = new Error("Refund already processed");
        error.code = "REFUND_ALREADY_PROCESSED";
        throw error;
      }

      const error = new Error(`Transaction not found or not eligible for refund: ${payment_id}`);
      error.code = "TRANSACTION_NOT_FOUND";
      throw error;
    }

    PaymentLogger.info(
      {
        event: "WEBHOOK_REFUND_CREATED_COMPLETED",
        webhookId,
        transactionId: transaction._id,
        refundId,
        paymentId: payment_id,
        refundAmount: amount / 100,
        duration: Date.now() - startTime,
      },
      "Refund created webhook processed successfully",
    );

    return {
      success: true,
      transaction,
      message: "Refund created recorded",
      idempotent: false,
    };
  }

  /**
   * Handle refund.processed webhook with atomic race-safety
   */
  async handleRefundProcessed(payload, webhookId, session) {
    const startTime = Date.now();
    const { payment_id, amount, id: refundId } = payload.refund.entity;

    PaymentLogger.info(
      {
        event: "WEBHOOK_REFUND_PROCESSED_STARTED",
        webhookId,
        refundId,
        paymentId: payment_id,
        refundAmount: amount / 100,
      },
      "Processing refund.processed webhook",
    );

    const transaction = await Transaction.findOneAndUpdate(
      {
        razorpayPaymentId: payment_id,
        refundId: refundId,
        refundStatus: "pending",
        status: { $in: ["completed", "refunded"] },
      },
      {
        $set: {
          status: "refunded",
          refundStatus: "processed",
          refundedAt: new Date(),
        },
      },
      {
        new: true,
        session,
        select: "_id status refundStatus refundId razorpayPaymentId userId vendorId",
      },
    );

    if (!transaction) {
      const existing = await Transaction.findOne({
        razorpayPaymentId: payment_id,
        refundId: refundId,
      }).session(session);

      if (existing?.refundStatus === "processed" && existing?.status === "refunded") {
        return {
          success: true,
          transaction: existing,
          message: "Refund already processed",
          idempotent: true,
        };
      }

      if (existing?.refundStatus === "failed") {
        const error = new Error("Refund has failed status, cannot process");
        error.code = "REFUND_FAILED";
        throw error;
      }

      const error = new Error(`Refund not found or not pending for payment: ${payment_id}`);
      error.code = "REFUND_NOT_FOUND";
      throw error;
    }

    // Deduct balance
    await this.deductBalance(transaction, amount / 100, session);

    PaymentLogger.info(
      {
        event: "WEBHOOK_REFUND_BALANCE_DEDUCTED",
        webhookId,
        transactionId: transaction._id,
        refundId,
        paymentId: payment_id,
        deductedAmount: amount / 100,
      },
      "Balance deducted for refund",
    );

    PaymentLogger.info(
      {
        event: "WEBHOOK_REFUND_PROCESSED_COMPLETED",
        webhookId,
        transactionId: transaction._id,
        refundId,
        paymentId: payment_id,
        refundAmount: amount / 100,
        duration: Date.now() - startTime,
      },
      "Refund processed webhook processed successfully",
    );

    return {
      success: true,
      transaction,
      message: "Refund processed successfully",
      idempotent: false,
    };
  }

  /**
   * Handle refund.failed webhook with atomic race-safety
   */
  async handleRefundFailed(payload, webhookId, session) {
    const startTime = Date.now();
    const { payment_id, id: refundId, error_description } = payload.refund.entity;

    PaymentLogger.info(
      {
        event: "WEBHOOK_REFUND_FAILED_STARTED",
        webhookId,
        refundId,
        paymentId: payment_id,
        error: error_description,
      },
      "Processing refund.failed webhook",
    );

    const transaction = await Transaction.findOneAndUpdate(
      {
        razorpayPaymentId: payment_id,
        refundId: refundId,
        refundStatus: { $in: ["pending", "created"] },
      },
      {
        $set: {
          refundStatus: "failed",
          refundError: error_description || "Refund failed via webhook",
        },
      },
      {
        new: true,
        session,
        select: "_id refundStatus refundId razorpayPaymentId",
      },
    );

    if (!transaction) {
      const existing = await Transaction.findOne({
        razorpayPaymentId: payment_id,
        refundId: refundId,
      }).session(session);

      if (existing?.refundStatus === "failed") {
        return {
          success: true,
          transaction: existing,
          message: "Refund already failed",
          idempotent: true,
        };
      }

      if (existing?.refundStatus === "processed") {
        const error = new Error("Refund already processed, cannot mark as failed");
        error.code = "REFUND_ALREADY_PROCESSED";
        throw error;
      }

      const error = new Error(`Refund not found for payment: ${payment_id}`);
      error.code = "REFUND_NOT_FOUND";
      throw error;
    }

    PaymentLogger.warn(
      {
        event: "WEBHOOK_REFUND_FAILED_COMPLETED",
        webhookId,
        transactionId: transaction._id,
        refundId,
        paymentId: payment_id,
        error: error_description,
        duration: Date.now() - startTime,
      },
      "Refund failed webhook processed",
    );

    return {
      success: true,
      transaction,
      message: "Refund failure recorded",
      idempotent: false,
    };
  }

  // ============ Helper Methods ============

  /**
   * Validate amount with standardized error codes
   */
  /**
   * Verify payment amount
   * @param {Object} transaction - Transaction document
   * @param {String} razorpay_payment_id - Razorpay payment ID
   * @param {Object} existingPayment - Optional existing Razorpay payment object
   * @returns {Object} Payment validation result
   */
  async verifyAmount(transaction, payment) {
    if (!payment) {
      const error = new Error("Payment object is required");
      error.code = "PAYMENT_OBJECT_MISSING";
      throw error;
    }

    const expectedAmount = Math.round(transaction.finalAmount * 100);

    if (payment.amount !== expectedAmount) {
      const error = new Error(`Amount mismatch. Expected ${expectedAmount}, got ${payment.amount}`);
      error.code = "AMOUNT_MISMATCH";
      throw error;
    }

    return true;
  }
  /**
   * Validate entity with standardized error codes
   */
  async validateEntity(userId, vendorId) {
    if (!userId && !vendorId) {
      const error = new Error("Either userId or vendorId is required");
      error.code = "ENTITY_REQUIRED";
      throw error;
    }

    if (userId) {
      const user = await User.findById(userId).select("_id status").lean();

      if (!user) {
        const error = new Error("User not found");
        error.code = "USER_NOT_FOUND";
        throw error;
      }
      if (user.status === "blocked") {
        const error = new Error("User is blocked");
        error.code = "USER_BLOCKED";
        throw error;
      }
    }

    if (vendorId) {
      const vendor = await Vendor.findById(vendorId).select("_id status").lean();

      if (!vendor) {
        const error = new Error("Vendor not found");
        error.code = "VENDOR_NOT_FOUND";
        throw error;
      }
      if (vendor.status === "blocked") {
        const error = new Error("Vendor is blocked");
        error.code = "VENDOR_BLOCKED";
        throw error;
      }
    }
  }

  /**
   * Validate payment fields with standardized error codes
   */
  validatePaymentFields(orderId, paymentId, signature) {
    if (!orderId || !paymentId || !signature) {
      const error = new Error("Missing required payment fields");
      error.code = "MISSING_PAYMENT_FIELDS";
      throw error;
    }
  }

  /**
   * Verify signature with standardized error codes
   */
  verifySignature(orderId, paymentId, signature) {
    try {
      const generated = crypto
        .createHmac("sha256", ENV.RAZORPAY_SECRET)
        .update(`${orderId}|${paymentId}`)
        .digest("hex");

      const sigBuf = Buffer.from(signature, "utf8");
      const genBuf = Buffer.from(generated, "utf8");

      if (sigBuf.length !== genBuf.length || !crypto.timingSafeEqual(sigBuf, genBuf)) {
        const error = new Error("Invalid payment signature");
        error.code = "INVALID_PAYMENT_SIGNATURE";
        throw error;
      }
    } catch (err) {
      if (err.code) throw err;
      const error = new Error("Signature verification failed");
      error.code = "SIGNATURE_VERIFICATION_FAILED";
      throw error;
    }
  }

  /**
   * Validate ownership with standardized error codes
   */

  async validateOwnership(transaction, userId, vendorId) {
    PaymentLogger.info(
      {
        transactionId: transaction._id,
        transactionUserId: transaction.userId?.toString
          ? transaction.userId.toString()
          : transaction.userId,
        requestUserId: userId,
        transactionVendorId: transaction.vendorId?.toString
          ? transaction.vendorId.toString()
          : transaction.vendorId,
        requestVendorId: vendorId,
        category: transaction.category,
      },
      "Ownership validation",
    );

    // Normalize IDs for comparison - convert both to strings
    const normalizedTransactionUserId = transaction.userId?.toString
      ? transaction.userId.toString()
      : String(transaction.userId);
    const normalizedRequestUserId = userId?.toString ? userId.toString() : String(userId);

    if (userId && normalizedTransactionUserId !== normalizedRequestUserId) {
      PaymentLogger.error(
        {
          transactionId: transaction._id,
          transactionUserId: normalizedTransactionUserId,
          requestUserId: normalizedRequestUserId,
          error: "User ID mismatch",
        },
        "User ownership validation failed",
      );

      const error = new Error("User does not own this transaction");
      error.code = "USER_OWNERSHIP_MISMATCH";
      throw error;
    }

    const normalizedTransactionVendorId = transaction.vendorId?.toString
      ? transaction.vendorId.toString()
      : String(transaction.vendorId);
    const normalizedRequestVendorId = vendorId?.toString ? vendorId.toString() : String(vendorId);

    if (vendorId && normalizedTransactionVendorId !== normalizedRequestVendorId) {
      PaymentLogger.error(
        {
          transactionId: transaction._id,
          transactionVendorId: normalizedTransactionVendorId,
          requestVendorId: normalizedRequestVendorId,
        },
        "Vendor ownership validation failed",
      );

      const error = new Error("Vendor does not own this transaction");
      error.code = "VENDOR_OWNERSHIP_MISMATCH";
      throw error;
    }

    // Validate that the entity exists (optimized)
    if (userId) {
      const user = await User.findById(userId).select("_id").lean();
      if (!user) {
        const error = new Error("User not found");
        error.code = "USER_NOT_FOUND";
        throw error;
      }
    }

    if (vendorId) {
      const vendor = await Vendor.findById(vendorId).select("_id").lean();
      if (!vendor) {
        const error = new Error("Vendor not found");
        error.code = "VENDOR_NOT_FOUND";
        throw error;
      }
    }

    PaymentLogger.info(
      {
        transactionId: transaction._id,
        result: "Ownership validation passed",
      },
      "Ownership validation successful",
    );
  }
  /**
   * Credit balance with audit - NOW USING WALLET SERVICE
   * All wallet operations now go through WalletService
   */

  /**
   * Credit wallet with deterministic identifiers
   * @param {Object} transaction - Transaction document
   * @param {Number} amount - Amount to credit
   * @param {Object} session - MongoDB session (required by WalletService)
   * @param {String} idempotencyKey - Deterministic idempotency key
   * @param {String} financialOperationId - Deterministic financial operation ID
   * @param {String} source - Payment source (api/webhook)
   * @param {Object} metadata - Additional metadata
   */
  async creditBalanceWithAudit(
    transaction,
    amount,
    session,
    idempotencyKey,
    financialOperationId,
    source = PaymentSource.API,
    metadata = {},
  ) {
    const entityType = transaction.vendorId ? "vendor" : "user";
    const entityId = transaction.vendorId || transaction.userId;

    if (!entityId) {
      const error = new Error("No entity found in transaction");
      error.code = "ENTITY_NOT_FOUND";
      throw error;
    }

    // Prepare metadata for wallet credit using deterministic IDs
    const walletMetadata = {
      idempotencyKey: idempotencyKey,
      financialOperationId: financialOperationId,
      entryType: "PAYMENT",
      source: source === PaymentSource.WEBHOOK ? "webhook" : "payment_verification",
      paymentId: transaction.razorpayPaymentId,
      orderId: transaction.razorpayOrderId,
      requestId: metadata.requestId || crypto.randomUUID(),
      ipAddress: metadata.ipAddress || transaction.ipAddress,
      createdBy: "system",
      metadata: {
        discount: transaction.discount || 0,
        finalAmount: transaction.finalAmount || amount,
        gateway: "razorpay",
        currency: transaction.currency || "INR",
        ...metadata,
      },
    };

    PaymentLogger.debug(
      {
        transactionId: transaction._id,
        entityType,
        entityId,
        amount,
        idempotencyKey: walletMetadata.idempotencyKey,
        financialOperationId: walletMetadata.financialOperationId,
        source: walletMetadata.source,
      },
      "Calling WalletService.credit with deterministic IDs",
    );

    try {
      // ALWAYS pass session - WalletService.credit supports it
      // This is the documented interface
      const result = await WalletService.credit(
        entityType,
        entityId,
        amount,
        transaction._id,
        transaction.discount,
        transaction.amount,
        walletMetadata,
        session, // Always passed - explicit interface
      );

      if (!result) {
        throw new Error("WalletService.credit returned undefined");
      }

      if (!result.entity) {
        PaymentLogger.error(
          {
            result: result,
            hasEntity: !!result.entity,
            hasLedger: !!result.ledger,
          },
          "WalletService.credit returned result without entity",
        );
        throw new Error("WalletService.credit returned result without entity");
      }

      PaymentLogger.debug(
        {
          event: "WALLET_CREDITED_IN_PAYMENT",
          transactionId: transaction._id,
          entityType,
          entityId,
          amount,
          balanceAfter: result.entity.balance,
          ledgerId: result.ledger?._id,
          financialOperationId: walletMetadata.financialOperationId,
          idempotencyKey: walletMetadata.idempotencyKey,
        },
        "Wallet credited via payment service",
      );

      return result.entity;
    } catch (error) {
      PaymentLogger.error(
        {
          event: "WALLET_CREDIT_FAILED_IN_PAYMENT",
          error: error.message,
          errorCode: error.code,
          errorName: error.name,
          transactionId: transaction._id,
          entityType,
          entityId,
          amount,
          idempotencyKey: walletMetadata.idempotencyKey,
          financialOperationId: walletMetadata.financialOperationId,
          stack: error.stack,
        },
        "Failed to credit wallet during payment processing",
      );

      throw error;
    }
  }

  /**
   * Deduct balance - NOW USING WALLET SERVICE
   */
  async deductBalance(transaction, amount, session) {
    const entityType = transaction.vendorId ? "vendor" : "user";
    const entityId = transaction.vendorId || transaction.userId;

    if (!entityId) {
      const error = new Error("No entity found in transaction");
      error.code = "ENTITY_NOT_FOUND";
      throw error;
    }

    try {
      const result = await WalletService.debit(
        entityType,
        entityId,
        amount,
        transaction._id,
        {
          paymentId: transaction.razorpayPaymentId,
          orderId: transaction.razorpayOrderId,
          idempotencyKey: transaction.razorpayPaymentId,
          source: "refund",
          requestId: transaction.requestId,
          gateway: "razorpay",
          currency: transaction.currency || "INR",
          reason: "refund_processed",
          financialOperationId:
            transaction.financialOperationId ||
            `refund_${transaction.razorpayPaymentId}_${Date.now()}`,
        },
        session,
      );

      PaymentLogger.debug(
        {
          event: "WALLET_DEBITED_IN_PAYMENT",
          transactionId: transaction._id,
          entityType,
          entityId,
          amount,
          balanceAfter: result.entity.balance,
          ledgerId: result.ledger._id,
          auditId: result.audit._id,
          financialOperationId: result.financialOperationId,
        },
        "Wallet debited via payment service",
      );

      return result.entity;
    } catch (error) {
      PaymentLogger.error(
        {
          event: "WALLET_DEBIT_FAILED_IN_PAYMENT",
          error: error.message,
          transactionId: transaction._id,
          entityType,
          entityId,
          amount,
        },
        "Failed to debit wallet during payment processing",
      );
      throw error;
    }
  }

  /**
   * Log audit with error handling
   */
  async logAudit(auditData) {
    try {
      const Audit = mongoose.model("Audit");
      await Audit.create(auditData);
    } catch (error) {
      PaymentLogger.error(
        {
          event: "AUDIT_LOG_FAILED",
          error: {
            message: error.message,
            code: error.code,
          },
          auditData,
        },
        "Failed to create audit log",
      );
      // Don't throw - audit failure shouldn't break the transaction
    }
  }

  /**
   * Mark transaction as failed
   */
  async markTransactionFailed(orderId, error) {
    try {
      const failureData = {
        status: "failed",
        errorCode: error?.code || "VERIFICATION_ERROR",
        errorMessage: error?.message || "Payment verification failed",
        errorDescription: error?.description || error?.message || "Payment verification failed",
        failedAt: new Date(),
      };

      // Only mark the transaction as failed if it is still processing.
      // Never overwrite terminal states like "completed" or an already
      // failed transaction.
      const updated = await Transaction.findOneAndUpdate(
        {
          razorpayOrderId: orderId,
          status: "processing",
        },
        {
          $set: failureData,
        },
        {
          new: true,
          select: "_id razorpayOrderId status userId vendorId errorCode failedAt",
        },
      );

      if (!updated) {
        // Determine why no update occurred for better diagnostics.
        const existing = await Transaction.findOne(
          { razorpayOrderId: orderId },
          "_id razorpayOrderId status userId vendorId",
        ).lean();

        if (!existing) {
          PaymentLogger.warn(
            {
              event: "TRANSACTION_NOT_FOUND_FOR_FAILURE",
              orderId,
            },
            "Transaction not found while attempting to mark payment as failed",
          );
        } else {
          PaymentLogger.info(
            {
              event: "PAYMENT_FAILURE_SKIPPED",
              transactionId: existing._id,
              orderId,
              currentStatus: existing.status,
              userId: existing.userId,
              vendorId: existing.vendorId,
              reason: "Transaction is already in a terminal state. Failure update skipped.",
            },
            "Skipped marking transaction as failed",
          );
        }

        return;
      }

      PaymentLogger.info(
        {
          event: "PAYMENT_MARKED_FAILED",
          transactionId: updated._id,
          orderId,
          userId: updated.userId,
          vendorId: updated.vendorId,
          errorCode: updated.errorCode,
          failedAt: updated.failedAt,
        },
        "Transaction marked as failed",
      );
    } catch (updateErr) {
      PaymentLogger.error(
        {
          event: "PAYMENT_MARK_FAILED_ERROR",
          orderId,
          error: {
            message: updateErr.message,
            code: updateErr.code,
            stack: updateErr.stack,
          },
        },
        "Failed to update transaction status",
      );
    }
  }

  /**
   * Get user/vendor entity
   */
  async getEntity(transaction) {
    const isVendor = !!transaction.vendorId;

    const Model = isVendor ? Vendor : User;
    const entityId = isVendor ? transaction.vendorId : transaction.userId;

    if (!entityId) {
      PaymentLogger.warn(
        {
          event: "ENTITY_NOT_FOUND_IN_TRANSACTION",
          transactionId: transaction._id,
        },
        "Transaction has no associated user or vendor",
      );
      return null;
    }

    const entity = await Model.findById(entityId)
      .select(
        "_id name phoneNo balance totalDiscount transactionCount totalOriginalAmount fcmToken",
      )
      .lean();

    if (!entity) {
      PaymentLogger.warn(
        {
          event: "ENTITY_DOCUMENT_NOT_FOUND",
          transactionId: transaction._id,
          entityId,
          entityType: isVendor ? "vendor" : "user",
        },
        "Associated entity not found",
      );
    }

    return entity;
  }

  /**
   * Send success notification
   */
  async sendSuccessNotification(entity, amount, transaction = null, requestId = null) {
    // console.log("in Notification", entity);

    const transactionId = transaction?._id?.toString() || null;

    const userId =
      transaction?.userId?.toString?.() || transaction?.userId?._id?.toString?.() || null;

    const vendorId =
      transaction?.vendorId?.toString?.() || transaction?.vendorId?._id?.toString?.() || null;

    // ============================================================
    // VALIDATION
    // ============================================================

    if (!transactionId) {
      PaymentLogger.warn(
        {
          event: "PAYMENT_SUCCESS_NOTIFICATION_SKIPPED",

          userId,

          vendorId,

          requestId,

          reason: "TRANSACTION_ID_MISSING",
        },

        "Payment success notification skipped because transaction ID is missing",
      );

      return {
        attempted: 0,
        queued: 0,
        failed: 0,
        results: [],
      };
    }

    // ============================================================
    // RECIPIENT INFORMATION
    // ============================================================

    const phoneNumber = entity?.phoneNo || null;

    const pushToken = entity?.fcmToken || null;

    const whatsappNumber = entity?.phoneNo || null;

    PaymentLogger.info(
      {
        event: "PAYMENT_SUCCESS_NOTIFICATION_STARTED",

        transactionId,

        userId,

        vendorId,

        hasPhoneNumber: Boolean(phoneNumber),

        hasFcmToken: Boolean(pushToken),

        hasWhatsAppNumber: Boolean(whatsappNumber),

        requestId,
      },

      "Preparing payment success notification",
    );

    // ============================================================
    // CHECK AVAILABLE CHANNEL
    // ============================================================

    if (!phoneNumber && !pushToken) {
      PaymentLogger.warn(
        {
          event: "PAYMENT_SUCCESS_NOTIFICATION_SKIPPED",

          transactionId,

          userId,

          vendorId,

          requestId,

          reason: "NO_NOTIFICATION_RECIPIENT",
        },

        "Payment success notification skipped because no recipient channel is available",
      );

      return {
        attempted: 0,
        queued: 0,
        failed: 0,
        results: [],
      };
    }

    // ============================================================
    // ONE LOGICAL PAYMENT NOTIFICATION
    // ============================================================
    //
    // Policy from notification.policy.js:
    //
    // PAYMENT
    //    ↓
    // PUSH
    //    ↓ failure
    // WHATSAPP
    //    ↓ failure
    // SMS
    //
    // We intentionally create ONLY ONE Notification document.
    //
    // The Worker/Dispatcher will perform the actual fallback.
    //
    // ============================================================

    try {
      const notification = await NotificationService.createBusinessNotification({
        type: "PAYMENT",

        userId,

        vendorId,

        recipient: {
          phoneNumber,

          whatsappNumber,

          pushToken,
        },

        template: "payment_success",

        templateData: {
          // ======================================================
          // COMMON DATA
          // ======================================================

          name: entity?.name || "Customer",

          amount,

          balance: amount,

          transactionId,

          paymentId: transaction?.razorpayPaymentId || "",

          orderId: transaction?.razorpayOrderId || "",

          // ======================================================
          // PUSH DATA
          // ======================================================

          title: "Payment Successful",

          body: `₹${amount} has been added to your wallet.`,

          type: "payment",

          screen: "profile",

          data: {
            transactionId,

            paymentId: transaction?.razorpayPaymentId || "",

            orderId: transaction?.razorpayOrderId || "",
          },
        },

        source: "payment",

        sourceId: transactionId,

        requestId,

        priority: 2,

        tags: ["payment", "wallet", "success"],

        // IMPORTANT:
        //
        // ONE logical payment event
        // = ONE idempotency key.
        //
        // Do NOT use:
        //
        // :sms
        // :push
        // :whatsapp
        //
        idempotencyKey: `payment:${transactionId}:success`,
      });

      // ==========================================================
      // QUEUED SUCCESSFULLY
      // ==========================================================

      PaymentLogger.info(
        {
          event: "PAYMENT_SUCCESS_NOTIFICATION_QUEUED",

          transactionId,

          notificationId: notification?._id?.toString() || null,

          userId,

          vendorId,

          type: notification?.type,

          channel: notification?.channel,

          channelPolicy: notification?.channelPolicy,

          requestId,
        },

        "Payment success notification queued",
      );

      return {
        attempted: 1,

        queued: 1,

        failed: 0,

        results: [
          {
            channel: notification?.channel || "PUSH",

            success: true,

            notificationId: notification?._id?.toString() || null,

            type: notification?.type || "PAYMENT",

            channelPolicy: notification?.channelPolicy || null,
          },
        ],
      };
    } catch (error) {
      // ==========================================================
      // QUEUE FAILURE
      // ==========================================================

      PaymentLogger.error(
        {
          err: error,

          event: "PAYMENT_SUCCESS_NOTIFICATION_FAILED",

          transactionId,

          userId,

          vendorId,

          requestId,

          errorCode: error?.code,

          errorMessage: error?.message,
        },

        "Failed to queue payment success notification",
      );

      // IMPORTANT:
      //
      // Payment has already succeeded.
      //
      // Notification failure must NOT make the
      // payment transaction fail.

      return {
        attempted: 1,

        queued: 0,

        failed: 1,

        results: [
          {
            channel: "PAYMENT",

            success: false,

            error: error?.message || "Failed to queue payment notification",
          },
        ],
      };
    }
  }

  // ============ Public Query Methods ============

  /**
   * Cursor pagination with backward compatibility
   */
  async getTransactionHistory(filters) {
    const { userId, vendorId, status, limit = 50, page = 1, before, after } = filters;
    const query = {};

    if (userId) query.userId = userId;
    if (vendorId) query.vendorId = vendorId;
    if (status) query.status = status;

    // Clamp limit
    const clampedLimit = Math.min(Math.max(parseInt(limit) || 50, 1), 100);

    // Cursor-based pagination (new)
    if (before || after) {
      if (after) {
        query._id = { $gt: after };
      }
      if (before) {
        query._id = { $lt: before };
      }

      const transactions = await Transaction.find(query)
        .select(
          "amount status finalAmount transactionDate paymentMethod userId vendorId paymentGateway currency",
        )
        .sort({ _id: before ? -1 : 1 })
        .limit(clampedLimit + 1)
        .lean()
        .populate("userId", "name email phoneNo")
        .populate("vendorId", "name email phoneNo");

      const hasMore = transactions.length > clampedLimit;
      if (hasMore) transactions.pop();

      return {
        data: transactions,
        pagination: {
          limit: clampedLimit,
          hasMore,
          nextCursor: hasMore ? transactions[transactions.length - 1]?._id : null,
          previousCursor: transactions[0]?._id || null,
        },
      };
    }

    // Legacy page-based pagination (backward compatible)
    const skip = (Math.max(parseInt(page) || 1, 1) - 1) * clampedLimit;

    const [transactions, total] = await Promise.all([
      Transaction.find(query)
        .select(
          "amount status finalAmount transactionDate paymentMethod userId vendorId paymentGateway currency",
        )
        .sort({ transactionDate: -1 })
        .skip(skip)
        .limit(clampedLimit)
        .lean()
        .populate("userId", "name email phoneNo")
        .populate("vendorId", "name email phoneNo"),
      Transaction.countDocuments(query),
    ]);

    return {
      data: transactions,
      pagination: {
        page: parseInt(page),
        limit: clampedLimit,
        total,
        totalPages: Math.ceil(total / clampedLimit),
        hasMore: skip + transactions.length < total,
      },
    };
  }

  /**
   * Get transaction statistics
   */
  async getTransactionStats(filters) {
    const { userId, vendorId } = filters;
    const match = {};

    if (userId) match.userId = new mongoose.Types.ObjectId(userId);
    if (vendorId) match.vendorId = new mongoose.Types.ObjectId(vendorId);

    PaymentLogger.info(
      {
        userId,
        vendorId,
        match,
      },
      "Transaction stats filter",
    );

    // Single aggregation pipeline
    const [stats] = await Transaction.aggregate([
      { $match: match },
      {
        $facet: {
          statusCounts: [
            {
              $group: {
                _id: "$status",
                count: { $sum: 1 },
                totalAmount: { $sum: "$amount" },
                totalFinalAmount: { $sum: "$finalAmount" },
                totalDiscount: { $sum: "$discount" },
              },
            },
          ],
          revenue: [
            { $match: { status: "completed" } },
            {
              $group: {
                _id: null,
                totalRevenue: { $sum: "$finalAmount" },
                totalDiscountGiven: { $sum: "$discount" },
              },
            },
          ],
          overall: [
            {
              $group: {
                _id: null,
                total: { $sum: 1 },
                completed: {
                  $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] },
                },
                abandoned: {
                  $sum: { $cond: [{ $eq: ["$status", "abandoned"] }, 1, 0] },
                },
                failed: {
                  $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] },
                },
                initiated: {
                  $sum: { $cond: [{ $eq: ["$status", "initiated"] }, 1, 0] },
                },
                pending: {
                  $sum: { $cond: [{ $eq: ["$status", "pending"] }, 1, 0] },
                },
                refunded: {
                  $sum: { $cond: [{ $eq: ["$status", "refunded"] }, 1, 0] },
                },
                processing: {
                  $sum: { $cond: [{ $eq: ["$status", "processing"] }, 1, 0] },
                },
              },
            },
          ],
        },
      },
    ]);

    const overall = stats.overall[0] || {
      total: 0,
      completed: 0,
      abandoned: 0,
      failed: 0,
      initiated: 0,
      pending: 0,
      refunded: 0,
      processing: 0,
    };
    const revenue = stats.revenue[0] || { totalRevenue: 0, totalDiscountGiven: 0 };
    const total = overall.total || 0;

    return {
      stats: stats.statusCounts,
      summary: {
        total: overall.total || 0,
        completed: overall.completed || 0,
        abandoned: overall.abandoned || 0,
        failed: overall.failed || 0,
        initiated: overall.initiated || 0,
        pending: overall.pending || 0,
        refunded: overall.refunded || 0,
        processing: overall.processing || 0,
        conversionRate: total > 0 ? parseFloat(((overall.completed / total) * 100).toFixed(2)) : 0,
        totalRevenue: revenue.totalRevenue || 0,
        totalDiscountGiven: revenue.totalDiscountGiven || 0,
      },
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Track abandoned payment
   */
  async trackAbandonedPayment(data) {
    const { orderId, amount, userId, vendorId, category = "user", ipAddress, requestId } = data;

    if (!orderId) {
      const error = new Error("Order ID is required");
      error.code = "ORDER_ID_REQUIRED";
      throw error;
    }

    const session = await mongoose.startSession();

    try {
      let transaction;

      await session.withTransaction(async () => {
        transaction = await Transaction.findOne({ razorpayOrderId: orderId }).session(session);

        if (transaction) {
          if (transaction.status === "initiated" || transaction.status === "pending") {
            transaction.status = "abandoned";
            transaction.abandonedAt = new Date();
            transaction.ipAddress = ipAddress || transaction.ipAddress;
            transaction.requestId = requestId || transaction.requestId;
            await transaction.save({ session });
          } else {
            // Already in a terminal state, just log
            PaymentLogger.info(
              {
                orderId,
                currentStatus: transaction.status,
                action: "abandoned_ignored",
              },
              "Transaction already in terminal state, ignoring abandoned tracking",
            );
          }
        } else {
          const transactionData = {
            razorpayOrderId: orderId,
            amount: amount || 0,
            status: "abandoned",
            abandonedAt: new Date(),
            initiatedAt: new Date(),
            category,
            transactionDate: new Date(),
            ipAddress,
            requestId,
          };

          if (userId) transactionData.userId = userId;
          if (vendorId) transactionData.vendorId = vendorId;

          transaction = new Transaction(transactionData);
          await transaction.save({ session });
        }
      });

      PaymentLogger.info(
        {
          orderId,
          userId,
          vendorId,
          requestId,
        },
        "Abandoned payment tracked",
      );

      return { success: true, transaction };
    } catch (error) {
      PaymentLogger.error(
        {
          event: "TRACK_ABANDONED_FAILED",
          orderId,
          userId,
          vendorId,
          error: {
            message: error.message,
            code: error.code,
          },
        },
        "Failed to track abandoned payment",
      );
      throw error;
    } finally {
      await session.endSession();
    }
  }

  /**
   * Track payment failure
   */
  async trackPaymentFailure(data) {
    const {
      orderId,
      amount,
      userId,
      vendorId,
      category = "user",
      error,
      errorCode,
      errorDescription,
      ipAddress,
      requestId,
    } = data;

    if (!orderId) {
      const error = new Error("Order ID is required");
      error.code = "ORDER_ID_REQUIRED";
      throw error;
    }

    const session = await mongoose.startSession();

    try {
      let transaction;

      await session.withTransaction(async () => {
        transaction = await Transaction.findOne({ razorpayOrderId: orderId }).session(session);

        if (transaction) {
          if (transaction.status === "initiated" || transaction.status === "processing") {
            transaction.status = "failed";
            transaction.failedAt = new Date();
            transaction.errorCode = errorCode || "PAYMENT_FAILED";
            transaction.errorMessage = error?.message || error || "Payment failed";
            transaction.errorDescription =
              errorDescription || error?.description || "Payment processing failed";
            transaction.ipAddress = ipAddress || transaction.ipAddress;
            transaction.requestId = requestId || transaction.requestId;
            await transaction.save({ session });
          } else {
            PaymentLogger.info(
              {
                orderId,
                currentStatus: transaction.status,
                action: "failure_ignored",
              },
              "Transaction already in terminal state, ignoring failure tracking",
            );
          }
        } else {
          const transactionData = {
            razorpayOrderId: orderId,
            amount: amount || 0,
            status: "failed",
            failedAt: new Date(),
            initiatedAt: new Date(),
            category,
            transactionDate: new Date(),
            errorCode: errorCode || "PAYMENT_FAILED",
            errorMessage: error?.message || error || "Payment failed",
            errorDescription: errorDescription || error?.description || "Payment processing failed",
            ipAddress,
            requestId,
          };

          if (userId) transactionData.userId = userId;
          if (vendorId) transactionData.vendorId = vendorId;

          transaction = new Transaction(transactionData);
          await transaction.save({ session });
        }
      });

      PaymentLogger.info(
        {
          orderId,
          userId,
          vendorId,
          errorCode,
          requestId,
        },
        "Payment failure tracked",
      );

      return { success: true, transaction };
    } catch (error) {
      PaymentLogger.error(
        {
          event: "TRACK_FAILURE_FAILED",
          orderId,
          userId,
          vendorId,
          error: {
            message: error.message,
            code: error.code,
          },
        },
        "Failed to track payment failure",
      );
      throw error;
    } finally {
      await session.endSession();
    }
  }

  /**
   * Reconcile pending/processing transactions.
   * This is intended to be called from a cron job.
   */
  async reconcilePendingPayments() {
    const startedAt = Date.now();

    PaymentLogger.info({
      event: "PAYMENT_RECONCILIATION_STARTED",
    });

    let processed = 0;
    let recovered = 0;
    let skipped = 0;
    let failed = 0;

    const transactions = await Transaction.find({
      status: {
        $in: ["initiated", "processing"],
      },
      initiatedAt: {
        $gte: new Date(Date.now() - 24 * 60 * 60 * 1000),
      },
    })
      .select("_id razorpayOrderId razorpayPaymentId status finalAmount currency userId vendorId")
      .limit(100);

    for (const transaction of transactions) {
      processed++;

      try {
        const result = await this.reconcileSingleTransaction(transaction);

        switch (result) {
          case "RECOVERED":
            recovered++;
            break;

          case "SKIPPED":
            skipped++;
            break;

          default:
            skipped++;
        }
      } catch (err) {
        failed++;

        PaymentLogger.error(
          {
            event: "PAYMENT_RECONCILIATION_FAILED",
            transactionId: transaction._id,
            orderId: transaction.razorpayOrderId,
            error: err.message,
            code: err.code,
          },
          "Failed to reconcile transaction",
        );
      }
    }

    PaymentLogger.info(
      {
        event: "PAYMENT_RECONCILIATION_COMPLETED",
        processed,
        recovered,
        skipped,
        failed,
        duration: Date.now() - startedAt,
      },
      "Payment reconciliation finished",
    );

    return {
      processed,
      recovered,
      skipped,
      failed,
    };
  }

  /**
   * Reconcile one transaction.
   */
  async reconcileSingleTransaction(transaction) {
    PaymentLogger.debug(
      {
        event: "PAYMENT_RECONCILIATION_TRANSACTION",
        transactionId: transaction._id,
        orderId: transaction.razorpayOrderId,
      },
      "Reconciling transaction",
    );

    // Ask Razorpay which payments belong to this order
    const payments = await razorpay.orders.fetchPayments(transaction.razorpayOrderId);

    if (!payments.items.length) {
      PaymentLogger.debug(
        {
          event: "PAYMENT_RECONCILIATION_NO_PAYMENT",
          orderId: transaction.razorpayOrderId,
        },
        "No payment exists yet",
      );

      return "SKIPPED";
    }

    const payment = payments.items.find((p) => p.status === "captured");

    if (!payment) {
      PaymentLogger.debug(
        {
          event: "PAYMENT_RECONCILIATION_NOT_CAPTURED",
          orderId: transaction.razorpayOrderId,
        },
        "Payment not captured yet",
      );

      return "SKIPPED";
    }

    // Verify payment using your existing validation
    await this.verifyWithRazorpay(transaction, payment.id);

    const session = await mongoose.startSession();

    try {
      await session.withTransaction(async () => {
        const {
          transaction: lockedTransaction,
          locked,
          alreadyCompleted,
        } = await this.acquireProcessingLock(
          transaction.razorpayOrderId,
          payment.id,
          "reconciliation",
          session,
        );

        if (alreadyCompleted) {
          return;
        }

        if (!locked) {
          const err = new Error("Unable to acquire reconciliation lock");

          err.code = "LOCK_FAILED";

          throw err;
        }

        await this.processSuccessfulPayment({
          transaction: lockedTransaction,
          paymentId: payment.id,
          paymentMethod: payment.method || "razorpay",
          source: PaymentSource.RECONCILIATION,
          requestId: `reconciliation_${transaction._id}`,
          ipAddress: null,
          session,
          existingPayment: payment,
        });
      });

      PaymentLogger.info(
        {
          event: "PAYMENT_RECONCILIATION_RECOVERED",
          transactionId: transaction._id,
          orderId: transaction.razorpayOrderId,
          paymentId: payment.id,
        },
        "Transaction recovered successfully",
      );

      return "RECOVERED";
    } finally {
      await session.endSession();
    }
  }
}

module.exports = new PaymentService();
