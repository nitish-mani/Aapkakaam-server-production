/**
 * payment.service.process.test.js
 * Tests for processSuccessfulPayment() - completing payment with wallet credit
 */

"use strict";

const { mockTransactionModel, mockWalletService } = require("../helpers/mock");
const { createProcessingTransaction, createCompletedTransaction } = require("../helpers/fixtures");
const { PaymentSource } = require("../../src/constants/payment");

jest.mock("../../src/logger/logger", () => require("../helpers/mock").mockLogger);
jest.mock("../../models/transaction", () => require("../helpers/mock").mockTransactionModel);
jest.mock("../../src/services/walletService", () => require("../helpers/mock").mockWalletService);

const paymentService = require("../../src/services/paymentService");
const Transaction = require("../../models/transaction");

describe("Payment Processing Service", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(paymentService, "verifyAmount").mockResolvedValue();
    jest.spyOn(paymentService, "creditBalanceWithAudit");
    jest.spyOn(Transaction, "findOneAndUpdate");
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("should complete successful payment", async () => {
    const session = {};
    const transaction = createProcessingTransaction();
    const creditedEntity = createProcessingTransaction();

    paymentService.creditBalanceWithAudit.mockResolvedValue(creditedEntity);
    Transaction.findOneAndUpdate.mockResolvedValue(createCompletedTransaction());

    const result = await paymentService.processSuccessfulPayment({
      transaction,
      paymentId: "pay_123",
      session,
      requestId: "req-123",
      existingPayment: { amount: 45000 },
    });

    expect(paymentService.verifyAmount).toHaveBeenCalledWith(transaction, { amount: 45000 });
    expect(paymentService.creditBalanceWithAudit).toHaveBeenCalled();
    expect(Transaction.findOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(result.updatedTransaction.status).toBe("completed");
  });

  test("should mark transaction with payment details", async () => {
    paymentService.creditBalanceWithAudit.mockResolvedValue({ balance: 500 });
    Transaction.findOneAndUpdate.mockResolvedValue({ status: "completed" });

    await paymentService.processSuccessfulPayment({
      transaction: createProcessingTransaction({ razorpayOrderId: "orderABC" }),
      paymentId: "pay123",
      session: {},
    });

    const update = Transaction.findOneAndUpdate.mock.calls[0][1];
    expect(update.$set.status).toBe("completed");
    expect(update.$set.paymentMethod).toBe("razorpay");
    expect(update.$set.gatewayPaymentId).toBe("pay123");
    expect(update.$set.razorpayPaymentId).toBe("pay123");
    expect(update.$set.completedAt).toBeInstanceOf(Date);
  });

  test("should verify amount before wallet credit", async () => {
    const order = [];

    paymentService.verifyAmount.mockImplementation(async () => {
      order.push("verify");
    });

    paymentService.creditBalanceWithAudit.mockImplementation(async () => {
      order.push("credit");
      return { balance: 100 };
    });

    Transaction.findOneAndUpdate.mockResolvedValue({ status: "completed" });

    await paymentService.processSuccessfulPayment({
      transaction: createProcessingTransaction(),
      paymentId: "pay1",
      session: {},
      existingPayment: { amount: 10000 },
    });

    expect(order).toEqual(["verify", "credit"]);
  });

  test("should stop when verifyAmount fails", async () => {
    const error = new Error("Amount mismatch");
    error.code = "AMOUNT_MISMATCH";
    paymentService.verifyAmount.mockRejectedValue(error);

    await expect(
      paymentService.processSuccessfulPayment({
        transaction: createProcessingTransaction(),
        paymentId: "pay1",
        session: {},
      }),
    ).rejects.toMatchObject({
      code: "AMOUNT_MISMATCH",
    });

    expect(paymentService.creditBalanceWithAudit).not.toHaveBeenCalled();
    expect(Transaction.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test("should stop when wallet credit fails", async () => {
    paymentService.verifyAmount.mockResolvedValue();

    const error = new Error("Wallet credit failed");
    error.code = "WALLET_CREDIT_FAILED";
    paymentService.creditBalanceWithAudit.mockRejectedValue(error);

    await expect(
      paymentService.processSuccessfulPayment({
        transaction: createProcessingTransaction(),
        paymentId: "pay1",
        session: {},
      }),
    ).rejects.toMatchObject({
      code: "WALLET_CREDIT_FAILED",
    });

    expect(Transaction.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test("should throw TRANSACTION_UPDATE_FAILED", async () => {
    paymentService.verifyAmount.mockResolvedValue();
    paymentService.creditBalanceWithAudit.mockResolvedValue({ balance: 100 });
    Transaction.findOneAndUpdate.mockResolvedValue(null);

    await expect(
      paymentService.processSuccessfulPayment({
        transaction: createProcessingTransaction(),
        paymentId: "pay1",
        session: {},
      }),
    ).rejects.toMatchObject({
      code: "TRANSACTION_UPDATE_FAILED",
    });
  });

  test("should set webhook fields for webhook source", async () => {
    paymentService.verifyAmount.mockResolvedValue();
    paymentService.creditBalanceWithAudit.mockResolvedValue({ balance: 100 });
    Transaction.findOneAndUpdate.mockResolvedValue({ status: "completed" });

    await paymentService.processSuccessfulPayment({
      transaction: createProcessingTransaction(),
      paymentId: "pay1",
      source: PaymentSource.WEBHOOK,
      session: {},
    });

    const update = Transaction.findOneAndUpdate.mock.calls[0][1];
    expect(update.$set.webhookProcessed).toBe(true);
    expect(update.$set.webhookProcessedAt).toBeInstanceOf(Date);
  });

  test("should not set webhook fields for API source", async () => {
    paymentService.verifyAmount.mockResolvedValue();
    paymentService.creditBalanceWithAudit.mockResolvedValue({ balance: 100 });
    Transaction.findOneAndUpdate.mockResolvedValue({ status: "completed" });

    await paymentService.processSuccessfulPayment({
      transaction: createProcessingTransaction(),
      paymentId: "pay1",
      source: PaymentSource.API,
      session: {},
    });

    const update = Transaction.findOneAndUpdate.mock.calls[0][1];
    expect(update.$set.webhookProcessed).toBeUndefined();
    expect(update.$set.webhookProcessedAt).toBeUndefined();
  });

  test("should use custom payment method", async () => {
    paymentService.verifyAmount.mockResolvedValue();
    paymentService.creditBalanceWithAudit.mockResolvedValue({ balance: 500 });
    Transaction.findOneAndUpdate.mockResolvedValue({ status: "completed" });

    await paymentService.processSuccessfulPayment({
      transaction: createProcessingTransaction(),
      paymentId: "gateway-payment",
      paymentMethod: "phonepe",
      session: {},
    });

    const update = Transaction.findOneAndUpdate.mock.calls[0][1];
    expect(update.$set.paymentMethod).toBe("phonepe");
  });
});
