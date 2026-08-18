/**
 * payment.service.idempotency.test.js
 * Tests for idempotency and concurrency control
 * Multiple concurrent requests should process only once
 */

"use strict";

const { mockMongoose } = require("../helpers/mock");
const { createProcessingTransaction, createCompletedTransaction } = require("../helpers/fixtures");

jest.mock("../../src/logger/logger", () => require("../helpers/mock").mockLogger);
jest.mock("../../src/services/walletService", () => require("../helpers/mock").mockWalletService);
jest.mock("../../models/transaction", () => require("../helpers/mock").mockTransactionModel);
jest.mock("../../models/user", () => require("../helpers/mock").mockUserModel);
jest.mock("../../models/vendor", () => require("../helpers/mock").mockVendorModel);
jest.mock("../../src/config/razorpay", () => require("../helpers/mock").mockRazorpay);
jest.mock("mongoose", () => require("../helpers/mock").mockMongoose);

const paymentService = require("../../src/services/paymentService");
const mongoose = require("mongoose");

describe("Payment Idempotency & Concurrency", () => {
  let mockSession;

  beforeEach(() => {
    jest.clearAllMocks();

    mockSession = {
      withTransaction: jest.fn().mockImplementation(async (fn) => {
        return await fn(mockSession);
      }),
      endSession: jest.fn(),
    };

    mongoose.startSession.mockResolvedValue(mockSession);

    jest.spyOn(paymentService, "validatePaymentFields").mockImplementation(() => {});
    jest.spyOn(paymentService, "verifySignature").mockImplementation(() => {});
    jest.spyOn(paymentService, "validateOwnership").mockResolvedValue();
    jest.spyOn(paymentService, "verifyWithRazorpay").mockResolvedValue({
      id: "pay1",
      order_id: "order1",
      status: "captured",
      captured: true,
      amount: 10000,
      currency: "INR",
    });

    jest.spyOn(paymentService, "processSuccessfulPayment");
    jest.spyOn(paymentService, "sendSuccessNotification").mockResolvedValue();
    jest.spyOn(paymentService, "creditBalanceWithAudit");
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("should process payment only once during concurrent requests", async () => {
    const processingTxn = createProcessingTransaction();

    // First request locks, subsequent requests see completed
    paymentService.acquireProcessingLock = jest
      .fn()
      .mockResolvedValueOnce({
        locked: true,
        alreadyCompleted: false,
        transaction: processingTxn,
      })
      .mockResolvedValue({
        locked: false,
        alreadyCompleted: true,
        transaction: createCompletedTransaction(),
      });

    paymentService.processSuccessfulPayment.mockResolvedValue({
      updatedTransaction: createCompletedTransaction(),
      creditedEntity: { balance: 200 },
    });

    const requests = Array.from({ length: 5 }, () =>
      paymentService.verifyPayment({
        razorpay_order_id: "order1",
        razorpay_payment_id: "pay1",
        razorpay_signature: "sig",
        userId: "user1",
      }),
    );

    const results = await Promise.all(requests);

    expect(paymentService.processSuccessfulPayment).toHaveBeenCalledTimes(1);
    expect(results.filter((r) => r.success)).toHaveLength(5);
  });

  test("should not credit wallet twice", async () => {
    const spy = jest.spyOn(paymentService, "creditBalanceWithAudit");

    paymentService.acquireProcessingLock = jest
      .fn()
      .mockResolvedValueOnce({
        locked: true,
        alreadyCompleted: false,
        transaction: createProcessingTransaction(),
      })
      .mockResolvedValue({
        locked: false,
        alreadyCompleted: true,
        transaction: createCompletedTransaction(),
      });

    paymentService.processSuccessfulPayment.mockImplementation(async () => ({
      updatedTransaction: createCompletedTransaction(),
      creditedEntity: { balance: 500 },
    }));

    await Promise.all(
      Array.from({ length: 10 }, () =>
        paymentService.verifyPayment({
          razorpay_order_id: "order1",
          razorpay_payment_id: "pay1",
          razorpay_signature: "sig",
          userId: "user1",
        }),
      ),
    );

    expect(spy).toHaveBeenCalledTimes(1);
  });

  test("should not send notification twice", async () => {
    paymentService.acquireProcessingLock = jest
      .fn()
      .mockResolvedValueOnce({
        locked: true,
        alreadyCompleted: false,
        transaction: createProcessingTransaction(),
      })
      .mockResolvedValue({
        locked: false,
        alreadyCompleted: true,
        transaction: createCompletedTransaction(),
      });

    paymentService.processSuccessfulPayment.mockResolvedValue({
      updatedTransaction: createCompletedTransaction(),
      creditedEntity: { balance: 500 },
    });

    await Promise.all(
      Array.from({ length: 3 }, () =>
        paymentService.verifyPayment({
          razorpay_order_id: "order1",
          razorpay_payment_id: "pay1",
          razorpay_signature: "sig",
          userId: "user1",
        }),
      ),
    );

    expect(paymentService.sendSuccessNotification).toHaveBeenCalledTimes(1);
  });

  test("should succeed when previous attempt failed before wallet credit", async () => {
    const txn = createProcessingTransaction();

    paymentService.acquireProcessingLock = jest.fn().mockResolvedValue({
      locked: true,
      alreadyCompleted: false,
      transaction: txn,
    });

    paymentService.verifyWithRazorpay.mockResolvedValue({
      order_id: "order1",
      status: "captured",
      captured: true,
      amount: 10000,
      currency: "INR",
    });

    paymentService.processSuccessfulPayment.mockResolvedValue({
      updatedTransaction: createCompletedTransaction(),
      creditedEntity: { balance: 900 },
    });

    const result = await paymentService.verifyPayment({
      razorpay_order_id: "order1",
      razorpay_payment_id: "pay1",
      razorpay_signature: "sig",
      userId: "user1",
    });

    expect(result.success).toBe(true);
  });

  test("should call processSuccessfulPayment exactly once", async () => {
    const txn = createProcessingTransaction();

    paymentService.acquireProcessingLock = jest.fn().mockResolvedValue({
      locked: true,
      alreadyCompleted: false,
      transaction: txn,
    });

    paymentService.verifyWithRazorpay.mockResolvedValue({
      order_id: "order1",
      status: "captured",
      captured: true,
      amount: 10000,
      currency: "INR",
    });

    paymentService.processSuccessfulPayment.mockResolvedValue({
      updatedTransaction: createCompletedTransaction(),
      creditedEntity: { balance: 1200 },
    });

    await paymentService.verifyPayment({
      razorpay_order_id: "order1",
      razorpay_payment_id: "pay1",
      razorpay_signature: "sig",
      userId: "user1",
    });

    expect(paymentService.processSuccessfulPayment).toHaveBeenCalledTimes(1);
  });

  test("should never call markTransactionFailed after successful completion", async () => {
    const txn = createProcessingTransaction();

    paymentService.acquireProcessingLock = jest.fn().mockResolvedValue({
      locked: true,
      alreadyCompleted: false,
      transaction: txn,
    });

    paymentService.verifyWithRazorpay.mockResolvedValue({
      order_id: "order1",
      status: "captured",
      captured: true,
      amount: 10000,
      currency: "INR",
    });

    paymentService.processSuccessfulPayment.mockResolvedValue({
      updatedTransaction: createCompletedTransaction(),
      creditedEntity: { balance: 1000 },
    });

    await paymentService.verifyPayment({
      razorpay_order_id: "order1",
      razorpay_payment_id: "pay1",
      razorpay_signature: "sig",
      userId: "user1",
    });

    expect(paymentService.markTransactionFailed).not.toHaveBeenCalled();
  });
});
