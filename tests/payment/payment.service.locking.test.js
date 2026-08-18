/**
 * payment.service.locking.test.js
 * Tests for acquireProcessingLock() - transaction state transitions and concurrency control
 */

"use strict";

const { mockTransactionModel } = require("../helpers/mock");
const {
  createInitiatedTransaction,
  createProcessingTransaction,
  createCompletedTransaction,
  createFailedTransaction,
} = require("../helpers/fixtures");

jest.mock("../../src/logger/logger", () => require("../helpers/mock").mockLogger);
jest.mock("../../models/transaction", () => require("../helpers/mock").mockTransactionModel);

const paymentService = require("../../src/services/paymentService");
const Transaction = require("../../models/transaction");

describe("Payment Locking Service", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Transaction, "findOneAndUpdate");
    jest.spyOn(Transaction, "findOne");
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("should acquire processing lock from initiated state", async () => {
    const txn = createProcessingTransaction();
    Transaction.findOneAndUpdate.mockResolvedValue(txn);

    const result = await paymentService.acquireProcessingLock(
      "order_123",
      "pay_123",
      "signature_123",
      null,
    );

    expect(result.locked).toBe(true);
    expect(result.alreadyCompleted).toBe(false);
    expect(result.transaction).toBe(txn);

    expect(Transaction.findOneAndUpdate).toHaveBeenCalledWith(
      {
        razorpayOrderId: "order_123",
        status: "initiated",
      },
      expect.objectContaining({
        $set: expect.objectContaining({
          status: "processing",
          razorpayPaymentId: "pay_123",
          razorpaySignature: "signature_123",
          processingStartedAt: expect.any(Date),
        }),
      }),
      expect.any(Object),
    );
  });

  test("should return idempotent response when already completed", async () => {
    Transaction.findOneAndUpdate.mockResolvedValue(null);
    const completedTxn = createCompletedTransaction();

    Transaction.findOne.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockReturnValue(completedTxn),
      session: jest.fn().mockReturnThis(),
    });

    const result = await paymentService.acquireProcessingLock(
      "order_123",
      "pay_123",
      "signature_123",
      null,
    );

    expect(result.locked).toBe(false);
    expect(result.alreadyCompleted).toBe(true);
    expect(result.transaction.status).toBe("completed");
  });

  test("should throw PAYMENT_ALREADY_PROCESSING when status is processing", async () => {
    Transaction.findOneAndUpdate.mockResolvedValue(null);
    const processingTxn = createProcessingTransaction();

    Transaction.findOne.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockReturnValue(processingTxn),
      session: jest.fn().mockReturnThis(),
    });

    await expect(
      paymentService.acquireProcessingLock("order_123", "pay_123", "signature_123", null),
    ).rejects.toMatchObject({
      code: "PAYMENT_ALREADY_PROCESSING",
    });
  });

  test("should throw TRANSACTION_NOT_FOUND when transaction does not exist", async () => {
    Transaction.findOneAndUpdate.mockResolvedValue(null);
    Transaction.findOne.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockReturnValue(null),
      session: jest.fn().mockReturnThis(),
    });

    await expect(
      paymentService.acquireProcessingLock("order_123", "pay_123", "signature_123", null),
    ).rejects.toMatchObject({
      code: "TRANSACTION_NOT_FOUND",
    });
  });

  test("should reject failed transaction", async () => {
    Transaction.findOneAndUpdate.mockResolvedValue(null);
    const failedTxn = createFailedTransaction();

    Transaction.findOne.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockReturnValue(failedTxn),
      session: jest.fn().mockReturnThis(),
    });

    await expect(
      paymentService.acquireProcessingLock("order_123", "pay_123", "signature_123", null),
    ).rejects.toMatchObject({
      code: "INVALID_PAYMENT_STATE",
    });
  });

  test("should reject refunded transaction", async () => {
    Transaction.findOneAndUpdate.mockResolvedValue(null);
    const refundedTxn = createCompletedTransaction({ status: "refunded" });

    Transaction.findOne.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockReturnValue(refundedTxn),
      session: jest.fn().mockReturnThis(),
    });

    await expect(
      paymentService.acquireProcessingLock("order_123", "pay_123", "signature_123", null),
    ).rejects.toMatchObject({
      code: "INVALID_PAYMENT_STATE",
    });
  });

  test("should reject abandoned transaction", async () => {
    Transaction.findOneAndUpdate.mockResolvedValue(null);
    const abandonedTxn = createInitiatedTransaction({ status: "abandoned" });

    Transaction.findOne.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockReturnValue(abandonedTxn),
      session: jest.fn().mockReturnThis(),
    });

    await expect(
      paymentService.acquireProcessingLock("order_123", "pay_123", "signature_123", null),
    ).rejects.toMatchObject({
      code: "INVALID_PAYMENT_STATE",
    });
  });

  test("should reject pending transaction", async () => {
    Transaction.findOneAndUpdate.mockResolvedValue(null);
    const pendingTxn = createInitiatedTransaction({ status: "pending" });

    Transaction.findOne.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockReturnValue(pendingTxn),
      session: jest.fn().mockReturnThis(),
    });

    await expect(
      paymentService.acquireProcessingLock("order_123", "pay_123", "signature_123", null),
    ).rejects.toMatchObject({
      code: "INVALID_PAYMENT_STATE",
    });
  });

  test("should store payment id and signature while locking", async () => {
    Transaction.findOneAndUpdate.mockResolvedValue(createProcessingTransaction());

    await paymentService.acquireProcessingLock("orderABC", "payXYZ", "sig123", null);

    const update = Transaction.findOneAndUpdate.mock.calls[0][1];
    expect(update.$set.razorpayPaymentId).toBe("payXYZ");
    expect(update.$set.razorpaySignature).toBe("sig123");
    expect(update.$set.processingStartedAt).toBeInstanceOf(Date);
  });
});
