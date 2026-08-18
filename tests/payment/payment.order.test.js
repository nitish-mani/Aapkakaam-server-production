"use strict";

/**
 * payment.verify.test.js
 *
 * Production regression suite for PaymentService.verifyPayment()
 * Tests observable behavior and database state, not implementation details
 */

const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");
const crypto = require("crypto");

// Mock only external dependencies
jest.mock("../../src/controller/razorpay", () => ({
  payments: {
    fetch: jest.fn(),
  },
}));

jest.mock("../../src/logger/logger", () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
}));

jest.mock("../../src/services/NotificationService", () => ({
  sendPaymentSuccess: jest.fn(),
}));

const razorpay = require("../../src/controller/razorpay");
const PaymentService = require("../../src/services/PaymentService");
const { sendPaymentSuccess } = require("../../src/services/NotificationService");

const User = require("../../src/models/user");
const Vendor = require("../../src/models/vendor");
const Transaction = require("../../src/models/transaction");

describe("PaymentService.verifyPayment()", () => {
  let mongoServer;
  let user;
  let vendor;
  let webhookSecret;

  beforeAll(async () => {
    mongoServer = await MongoMemoryReplSet.create({
      replSet: {
        count: 1,
        storageEngine: "wiredTiger",
      },
      instanceOpts: [
        {
          ip: "127.0.0.1",
          port: 27028,
        },
      ],
    });

    await mongoose.connect(mongoServer.getUri(), {
      dbName: "jest_verify",
    });

    webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET || "test_webhook_secret_123";
  });

  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.connection.close();
    await mongoServer.stop();
  });

  afterEach(async () => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
    await User.deleteMany({});
    await Vendor.deleteMany({});
    await Transaction.deleteMany({});
  });

  // ============================================
  // Helper Functions
  // ============================================
  async function createUser(overrides = {}) {
    return User.create({
      name: "Nitish Kumar",
      phoneNo: "9999999999",
      password: "Password@123",
      email: "nitish@test.com",
      verifyPhoneNo: true,
      verifyEmail: true,
      agreedToTnCnP: true,
      status: "active",
      balance: 0,
      bookingCount: 0,
      transactionCount: 0,
      totalDiscount: 0,
      totalOriginalAmount: 0,
      role: "user",
      ...overrides,
    });
  }

  async function createVendor(overrides = {}) {
    return Vendor.create({
      name: "Vendor Name",
      phoneNo: "8888888888",
      password: "Password@123",
      email: "vendor@test.com",
      verifyPhoneNo: true,
      verifyEmail: true,
      agreedToTnCnP: true,
      type: "Electrician",
      status: "active",
      wageRate: 500,
      balance: 0,
      bookingCount: 0,
      transactionCount: 0,
      totalDiscount: 0,
      totalOriginalAmount: 0,
      ...overrides,
    });
  }

  function generateValidSignature(orderId, paymentId) {
    const payload = `${orderId}|${paymentId}`;
    return crypto.createHmac("sha256", webhookSecret).update(payload).digest("hex");
  }

  function generateUniqueId(prefix) {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(7);
    return `${prefix}_${timestamp}_${random}`;
  }

  async function createTransaction(userId, vendorId = null, status = "initiated", overrides = {}) {
    const orderId = generateUniqueId("order");
    const paymentId = generateUniqueId("pay");

    const transactionData = {
      razorpayOrderId: orderId,
      razorpayPaymentId: paymentId,
      amount: 100,
      finalAmount: 90,
      discount: 10,
      discountPercent: 10,
      currency: "INR",
      paymentGateway: "razorpay",
      status: status,
      category: userId ? "user" : "vendor",
      requestId: generateUniqueId("req"),
      ipAddress: "127.0.0.1",
      userAgent: "jest-test",
      paymentStatus:
        status === "completed" ? "captured" : status === "failed" ? "failed" : "initiated",
      processingStartedAt: status === "processing" ? new Date() : null,
      completedAt: status === "completed" ? new Date() : null,
      metadata: {
        requestedAmount: 100,
        originalAmount: 100,
        payableAmount: 90,
        gateway: "razorpay",
        orderId: orderId,
        paymentId: paymentId,
      },
      ...overrides,
    };

    if (userId) {
      transactionData.userId = userId;
    } else if (vendorId) {
      transactionData.vendorId = vendorId;
    }

    const transaction = await Transaction.create(transactionData);
    return {
      transaction,
      orderId,
      paymentId,
    };
  }

  function createVerificationPayload(orderId, paymentId, userId = null, vendorId = null) {
    const signature = generateValidSignature(orderId, paymentId);
    const payload = {
      razorpay_order_id: orderId,
      razorpay_payment_id: paymentId,
      razorpay_signature: signature,
    };

    if (userId) payload.userId = userId;
    if (vendorId) payload.vendorId = vendorId;

    return payload;
  }

  function mockRazorpayPayment(status = "captured", captured = true, overrides = {}) {
    razorpay.payments.fetch.mockResolvedValue({
      id: "pay_test_123",
      order_id: "order_test_123",
      amount: 9000,
      currency: "INR",
      status: status,
      captured: captured,
      ...overrides,
    });
  }

  function mockRazorpayFailure(error) {
    razorpay.payments.fetch.mockRejectedValue(error);
  }

  async function verifySuccessfulCompletion(orderId, userId) {
    const transaction = await Transaction.findOne({ razorpayOrderId: orderId });
    expect(transaction).toBeDefined();
    expect(transaction.status).toBe("completed");
    expect(transaction.paymentStatus).toBe("captured");
    expect(transaction.completedAt).toBeDefined();
    expect(transaction.completedAt).toBeInstanceOf(Date);

    const entity = await User.findById(userId);
    expect(entity).toBeDefined();
    expect(entity.balance).toBe(90);
    expect(entity.transactionCount).toBe(1);
    expect(entity.totalDiscount).toBe(10);
    expect(entity.totalOriginalAmount).toBe(100);

    expect(sendPaymentSuccess).toHaveBeenCalled();
  }

  // ============================================
  // Validation Tests
  // ============================================
  describe("Validation", () => {
    let testData;

    beforeEach(async () => {
      user = await createUser();
      testData = await createTransaction(user._id);
    });

    test("should reject when required fields are missing", async () => {
      const missingFields = [
        {
          razorpay_order_id: undefined,
          razorpay_payment_id: testData.paymentId,
          razorpay_signature: "sig",
        },
        {
          razorpay_order_id: testData.orderId,
          razorpay_payment_id: undefined,
          razorpay_signature: "sig",
        },
        {
          razorpay_order_id: testData.orderId,
          razorpay_payment_id: testData.paymentId,
          razorpay_signature: undefined,
        },
      ];

      for (const payload of missingFields) {
        payload.userId = user._id;
        await expect(PaymentService.verifyPayment(payload)).rejects.toThrow();
      }
    });

    test("should reject invalid signature", async () => {
      const payload = {
        razorpay_order_id: testData.orderId,
        razorpay_payment_id: testData.paymentId,
        razorpay_signature: "invalid_signature",
        userId: user._id,
      };

      await expect(PaymentService.verifyPayment(payload)).rejects.toThrow();
    });
  });

  // ============================================
  // Ownership Tests
  // ============================================
  describe("Ownership", () => {
    let testData;

    beforeEach(async () => {
      user = await createUser();
      vendor = await createVendor();
      testData = await createTransaction(user._id);
    });

    test("should reject when wrong user tries to verify", async () => {
      const otherUser = await createUser({
        phoneNo: "7777777777",
        email: "other@test.com",
      });

      mockRazorpayPayment();

      const payload = createVerificationPayload(
        testData.orderId,
        testData.paymentId,
        otherUser._id,
      );

      await expect(PaymentService.verifyPayment(payload)).rejects.toThrow();
    });

    test("should reject when wrong vendor tries to verify", async () => {
      const vendorTransaction = await createTransaction(null, vendor._id);
      const otherVendor = await createVendor({
        phoneNo: "7777777777",
        email: "othervendor@test.com",
      });

      mockRazorpayPayment();

      const payload = createVerificationPayload(
        vendorTransaction.orderId,
        vendorTransaction.paymentId,
        null,
        otherVendor._id,
      );

      await expect(PaymentService.verifyPayment(payload)).rejects.toThrow();
    });

    test("should allow user to verify their own transaction", async () => {
      mockRazorpayPayment();

      const payload = createVerificationPayload(testData.orderId, testData.paymentId, user._id);

      const result = await PaymentService.verifyPayment(payload);
      expect(result.success).toBe(true);
      await verifySuccessfulCompletion(testData.orderId, user._id);
    });

    test("should allow vendor to verify their own transaction", async () => {
      const vendorTransaction = await createTransaction(null, vendor._id);
      mockRazorpayPayment();

      const payload = createVerificationPayload(
        vendorTransaction.orderId,
        vendorTransaction.paymentId,
        null,
        vendor._id,
      );

      const result = await PaymentService.verifyPayment(payload);
      expect(result.success).toBe(true);

      const transaction = await Transaction.findOne({ razorpayOrderId: vendorTransaction.orderId });
      expect(transaction.status).toBe("completed");

      const updatedVendor = await Vendor.findById(vendor._id);
      expect(updatedVendor.balance).toBe(90);
    });
  });

  // ============================================
  // Processing Lock Tests
  // ============================================
  describe("Processing Lock", () => {
    beforeEach(async () => {
      user = await createUser();
    });

    test("should return idempotent for already completed transaction", async () => {
      const { orderId, paymentId } = await createTransaction(user._id, null, "completed");

      const payload = createVerificationPayload(orderId, paymentId, user._id);
      const result = await PaymentService.verifyPayment(payload);

      expect(result.success).toBe(true);
      expect(result.idempotent).toBe(true);
      expect(result.message).toContain("already completed");

      // Verify no changes were made
      const userAfter = await User.findById(user._id);
      expect(userAfter.transactionCount).toBe(0);
    });

    test("should fail when transaction is already processing", async () => {
      const { orderId, paymentId } = await createTransaction(user._id, null, "processing");

      const payload = createVerificationPayload(orderId, paymentId, user._id);

      await expect(PaymentService.verifyPayment(payload)).rejects.toThrow();
    });

    test("should handle concurrent verification attempts", async () => {
      const { orderId, paymentId } = await createTransaction(user._id);
      mockRazorpayPayment();

      const payload = createVerificationPayload(orderId, paymentId, user._id);

      const results = await Promise.allSettled([
        PaymentService.verifyPayment(payload),
        PaymentService.verifyPayment(payload),
      ]);

      const successful = results.filter((r) => r.status === "fulfilled" && r.value.success);
      expect(successful.length).toBeGreaterThan(0);

      const transactions = await Transaction.find({ razorpayOrderId: orderId });
      expect(transactions).toHaveLength(1);
      expect(transactions[0].status).toBe("completed");

      const updatedUser = await User.findById(user._id);
      expect(updatedUser.transactionCount).toBe(1);
    });
  });

  // ============================================
  // Gateway Verification Tests
  // ============================================
  describe("Gateway Verification", () => {
    let testData;

    beforeEach(async () => {
      user = await createUser();
      testData = await createTransaction(user._id);
    });

    test("should succeed when Razorpay payment is found and captured", async () => {
      mockRazorpayPayment();

      const payload = createVerificationPayload(testData.orderId, testData.paymentId, user._id);

      const result = await PaymentService.verifyPayment(payload);
      expect(result.success).toBe(true);
      await verifySuccessfulCompletion(testData.orderId, user._id);
    });

    test("should fail when Razorpay payment is not found", async () => {
      mockRazorpayFailure(new Error("Payment not found"));

      const payload = createVerificationPayload(testData.orderId, testData.paymentId, user._id);

      await expect(PaymentService.verifyPayment(payload)).rejects.toThrow();

      const transaction = await Transaction.findOne({ razorpayOrderId: testData.orderId });
      expect(transaction.status).toBe("failed");
      expect(transaction.failureReason).toBeDefined();
    });

    test("should fail on amount mismatch", async () => {
      mockRazorpayPayment("captured", true, { amount: 10000 });

      const payload = createVerificationPayload(testData.orderId, testData.paymentId, user._id);

      await expect(PaymentService.verifyPayment(payload)).rejects.toThrow();

      const transaction = await Transaction.findOne({ razorpayOrderId: testData.orderId });
      expect(transaction.status).toBe("failed");
    });

    test("should fail on currency mismatch", async () => {
      mockRazorpayPayment("captured", true, { currency: "USD" });

      const payload = createVerificationPayload(testData.orderId, testData.paymentId, user._id);

      await expect(PaymentService.verifyPayment(payload)).rejects.toThrow();

      const transaction = await Transaction.findOne({ razorpayOrderId: testData.orderId });
      expect(transaction.status).toBe("failed");
    });

    test("should fail on uncaptured payment", async () => {
      mockRazorpayPayment("created", false);

      const payload = createVerificationPayload(testData.orderId, testData.paymentId, user._id);

      await expect(PaymentService.verifyPayment(payload)).rejects.toThrow();

      const transaction = await Transaction.findOne({ razorpayOrderId: testData.orderId });
      expect(transaction.status).toBe("failed");
    });

    test("should fail on failed payment", async () => {
      mockRazorpayPayment("failed", false);

      const payload = createVerificationPayload(testData.orderId, testData.paymentId, user._id);

      await expect(PaymentService.verifyPayment(payload)).rejects.toThrow();

      const transaction = await Transaction.findOne({ razorpayOrderId: testData.orderId });
      expect(transaction.status).toBe("failed");
    });

    test("should handle Razorpay API timeout", async () => {
      mockRazorpayFailure(new Error("Request timeout"));

      const payload = createVerificationPayload(testData.orderId, testData.paymentId, user._id);

      await expect(PaymentService.verifyPayment(payload)).rejects.toThrow();

      const transaction = await Transaction.findOne({ razorpayOrderId: testData.orderId });
      expect(transaction.status).toBe("failed");
    });
  });

  // ============================================
  // Successful Verification Tests
  // ============================================
  describe("Successful Verification", () => {
    let testData;

    beforeEach(async () => {
      user = await createUser();
      testData = await createTransaction(user._id);
      mockRazorpayPayment();
    });

    test("should complete transaction and update all related data", async () => {
      const payload = createVerificationPayload(testData.orderId, testData.paymentId, user._id);

      const result = await PaymentService.verifyPayment(payload);

      // Verify response structure
      expect(result).toMatchObject({
        success: true,
        payment_id: testData.paymentId,
        order_id: testData.orderId,
        balance: 90,
        transactionCount: 1,
        totalDiscount: 10,
        totalOriginalAmount: 100,
      });

      // Verify transaction in database
      const transaction = await Transaction.findOne({ razorpayOrderId: testData.orderId });
      expect(transaction).toMatchObject({
        status: "completed",
        paymentStatus: "captured",
        amount: 100,
        finalAmount: 90,
        discount: 10,
        discountPercent: 10,
        currency: "INR",
        paymentGateway: "razorpay",
      });
      expect(transaction.completedAt).toBeDefined();
      expect(transaction.completedAt).toBeInstanceOf(Date);
      expect(transaction.requestId).toBe(testData.transaction.requestId);

      // Verify user updates
      const updatedUser = await User.findById(user._id);
      expect(updatedUser).toMatchObject({
        balance: 90,
        transactionCount: 1,
        totalDiscount: 10,
        totalOriginalAmount: 100,
      });

      // Verify notification
      expect(sendPaymentSuccess).toHaveBeenCalledTimes(1);
      expect(sendPaymentSuccess).toHaveBeenCalledWith(
        expect.objectContaining({ _id: user._id }),
        90,
        expect.objectContaining({
          razorpayPaymentId: testData.paymentId,
        }),
        expect.any(String),
      );
    });

    test("should preserve metadata in transaction", async () => {
      const payload = createVerificationPayload(testData.orderId, testData.paymentId, user._id);

      await PaymentService.verifyPayment(payload);

      const transaction = await Transaction.findOne({ razorpayOrderId: testData.orderId });
      expect(transaction.metadata).toMatchObject({
        requestedAmount: 100,
        originalAmount: 100,
        payableAmount: 90,
        gateway: "razorpay",
        orderId: testData.orderId,
        paymentId: testData.paymentId,
      });
    });
  });

  // ============================================
  // Idempotency Tests
  // ============================================
  describe("Idempotency", () => {
    let testData;

    beforeEach(async () => {
      user = await createUser();
      testData = await createTransaction(user._id);
      mockRazorpayPayment();
    });

    test("should handle duplicate verification correctly", async () => {
      const payload = createVerificationPayload(testData.orderId, testData.paymentId, user._id);

      // First verification
      const result1 = await PaymentService.verifyPayment(payload);
      expect(result1.success).toBe(true);

      // Second verification
      const result2 = await PaymentService.verifyPayment(payload);
      expect(result2.success).toBe(true);
      expect(result2.idempotent).toBe(true);
      expect(result2.message).toContain("already completed");
      expect(result2.transaction.status).toBe("completed");

      // Verify database was updated only once
      const transactions = await Transaction.find({ razorpayOrderId: testData.orderId });
      expect(transactions).toHaveLength(1);
      expect(transactions[0].status).toBe("completed");

      // Verify user was updated only once
      const updatedUser = await User.findById(user._id);
      expect(updatedUser.transactionCount).toBe(1);
      expect(updatedUser.balance).toBe(90);

      // Verify notification was sent only once
      expect(sendPaymentSuccess).toHaveBeenCalledTimes(1);
    });

    test("should return idempotent for already completed transaction without changes", async () => {
      const { orderId, paymentId } = await createTransaction(user._id, null, "completed");

      const payload = createVerificationPayload(orderId, paymentId, user._id);
      const result = await PaymentService.verifyPayment(payload);

      expect(result.success).toBe(true);
      expect(result.idempotent).toBe(true);

      // Verify no changes were made
      const userAfter = await User.findById(user._id);
      expect(userAfter.transactionCount).toBe(0);
      expect(userAfter.balance).toBe(0);
    });
  });

  // ============================================
  // Concurrency Tests
  // ============================================
  describe("Concurrency", () => {
    beforeEach(async () => {
      user = await createUser();
    });

    test("should handle multiple verification attempts for same transaction", async () => {
      const { orderId, paymentId } = await createTransaction(user._id);
      mockRazorpayPayment();

      const payload = createVerificationPayload(orderId, paymentId, user._id);

      const results = await Promise.allSettled([
        PaymentService.verifyPayment(payload),
        PaymentService.verifyPayment(payload),
        PaymentService.verifyPayment(payload),
      ]);

      const successful = results.filter((r) => r.status === "fulfilled" && r.value.success);
      const idempotent = results.filter(
        (r) => r.status === "fulfilled" && r.value.idempotent === true,
      );

      // At least one should succeed, others should be idempotent or fail
      expect(successful.length).toBeGreaterThan(0);

      // Total successful + idempotent should equal total attempts
      expect(successful.length + idempotent.length).toBe(results.length);

      // Verify final state
      const transactions = await Transaction.find({ razorpayOrderId: orderId });
      expect(transactions).toHaveLength(1);
      expect(transactions[0].status).toBe("completed");

      const updatedUser = await User.findById(user._id);
      expect(updatedUser.transactionCount).toBe(1);
      expect(updatedUser.balance).toBe(90);

      // Notification should be sent only once
      expect(sendPaymentSuccess).toHaveBeenCalledTimes(1);
    });

    test("should handle race between verification and webhook", async () => {
      const { orderId, paymentId } = await createTransaction(user._id);
      mockRazorpayPayment();

      const payload = createVerificationPayload(orderId, paymentId, user._id);

      // Simulate webhook completing first
      await PaymentService.verifyPayment(payload);

      // Then verification tries again
      const result = await PaymentService.verifyPayment(payload);

      expect(result.success).toBe(true);
      expect(result.idempotent).toBe(true);

      // Verify only one completion occurred
      const transactions = await Transaction.find({ razorpayOrderId: orderId });
      expect(transactions).toHaveLength(1);
      expect(transactions[0].status).toBe("completed");

      const updatedUser = await User.findById(user._id);
      expect(updatedUser.transactionCount).toBe(1);
    });
  });

  // ============================================
  // Failure Handling Tests
  // ============================================
  describe("Failure Handling", () => {
    let testData;

    beforeEach(async () => {
      user = await createUser();
      testData = await createTransaction(user._id);
    });

    test("should mark transaction failed for retryable errors", async () => {
      mockRazorpayFailure(new Error("Gateway timeout"));

      const payload = createVerificationPayload(testData.orderId, testData.paymentId, user._id);

      await expect(PaymentService.verifyPayment(payload)).rejects.toThrow();

      const transaction = await Transaction.findOne({
        razorpayOrderId: testData.orderId,
      });

      expect(transaction.status).toBe("failed");
      expect(transaction.failureReason).toBeDefined();
      expect(transaction.paymentStatus).toBe("failed");
    });

    test("should NOT mark transaction failed for validation errors", async () => {
      const payload = createVerificationPayload(testData.orderId, testData.paymentId, user._id);
      payload.razorpay_signature = "invalid";

      await expect(PaymentService.verifyPayment(payload)).rejects.toThrow();

      const transaction = await Transaction.findOne({
        razorpayOrderId: testData.orderId,
      });

      expect(transaction.status).not.toBe("failed");
      expect(transaction.failureReason).toBeUndefined();
    });

    test("should handle processing failure with rollback", async () => {
      mockRazorpayPayment();

      // Simulate failure in processing
      jest
        .spyOn(PaymentService, "processSuccessfulPayment")
        .mockRejectedValue(new Error("Wallet update failed"));

      const payload = createVerificationPayload(testData.orderId, testData.paymentId, user._id);

      await expect(PaymentService.verifyPayment(payload)).rejects.toThrow();

      const transaction = await Transaction.findOne({
        razorpayOrderId: testData.orderId,
      });

      expect(transaction.status).toBe("failed");
      expect(transaction.failureReason).toContain("Wallet update failed");

      // User should remain unchanged
      const updatedUser = await User.findById(user._id);
      expect(updatedUser.balance).toBe(0);
      expect(updatedUser.transactionCount).toBe(0);
    });

    test("should handle invalid transaction state", async () => {
      const { orderId, paymentId } = await createTransaction(user._id, null, "invalid_state");

      const payload = createVerificationPayload(orderId, paymentId, user._id);

      await expect(PaymentService.verifyPayment(payload)).rejects.toThrow();
    });
  });

  // ============================================
  // Notification Tests
  // ============================================
  describe("Notifications", () => {
    let testData;

    beforeEach(async () => {
      user = await createUser();
      testData = await createTransaction(user._id);
      mockRazorpayPayment();
    });

    test("should send notification after successful verification", async () => {
      const payload = createVerificationPayload(testData.orderId, testData.paymentId, user._id);

      await PaymentService.verifyPayment(payload);

      expect(sendPaymentSuccess).toHaveBeenCalledTimes(1);
      expect(sendPaymentSuccess).toHaveBeenCalledWith(
        expect.objectContaining({
          _id: user._id,
        }),
        90,
        expect.objectContaining({
          razorpayPaymentId: testData.paymentId,
        }),
        expect.any(String),
      );
    });

    test("should handle notification failure gracefully", async () => {
      sendPaymentSuccess.mockRejectedValue(new Error("Notification service unavailable"));

      const payload = createVerificationPayload(testData.orderId, testData.paymentId, user._id);

      // Payment should complete even if notification fails
      const result = await PaymentService.verifyPayment(payload);
      expect(result.success).toBe(true);

      // Notification should have been attempted
      expect(sendPaymentSuccess).toHaveBeenCalled();

      // Database should still be updated
      const transaction = await Transaction.findOne({
        razorpayOrderId: testData.orderId,
      });
      expect(transaction.status).toBe("completed");

      const updatedUser = await User.findById(user._id);
      expect(updatedUser.balance).toBe(90);
    });

    test("should not send notification for idempotent requests", async () => {
      const payload = createVerificationPayload(testData.orderId, testData.paymentId, user._id);

      await PaymentService.verifyPayment(payload);
      await PaymentService.verifyPayment(payload);

      expect(sendPaymentSuccess).toHaveBeenCalledTimes(1);
    });
  });

  // ============================================
  // Response Structure Tests
  // ============================================
  describe("Response Structure", () => {
    let testData;

    beforeEach(async () => {
      user = await createUser();
      testData = await createTransaction(user._id);
      mockRazorpayPayment();
    });

    test("should return complete response with all required fields", async () => {
      const payload = createVerificationPayload(testData.orderId, testData.paymentId, user._id);

      const result = await PaymentService.verifyPayment(payload);

      const expectedFields = [
        "success",
        "payment_id",
        "order_id",
        "balance",
        "transactionCount",
        "totalDiscount",
        "totalOriginalAmount",
        "transaction",
      ];

      expectedFields.forEach((field) => {
        expect(result).toHaveProperty(field);
      });

      expect(result.transaction).toMatchObject({
        status: "completed",
        razorpayOrderId: testData.orderId,
        razorpayPaymentId: testData.paymentId,
      });
    });

    test("should include idempotent flag for duplicate requests", async () => {
      const payload = createVerificationPayload(testData.orderId, testData.paymentId, user._id);

      await PaymentService.verifyPayment(payload);
      const result = await PaymentService.verifyPayment(payload);

      expect(result.idempotent).toBe(true);
      expect(result.message).toContain("already completed");
    });
  });
});
