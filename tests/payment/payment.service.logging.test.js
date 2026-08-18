/**
 * payment.service.logging.test.js
 * Tests for logging events across payment service
 */

"use strict";

const {
  mockLogger,
  mockRazorpay,
  mockWalletService,
  mockTransactionModel,
} = require("../helpers/mock");
const { createProcessingTransaction, createUser } = require("../helpers/fixtures");

jest.mock("../../src/logger/logger", () => require("../helpers/mock").mockLogger);
jest.mock("../../src/config/razorpay", () => require("../helpers/mock").mockRazorpay);
jest.mock("../../src/services/walletService", () => require("../helpers/mock").mockWalletService);
jest.mock("../../models/transaction", () => require("../helpers/mock").mockTransactionModel);
jest.mock("../../models/user", () => require("../helpers/mock").mockUserModel);
jest.mock("../../models/vendor", () => require("../helpers/mock").mockVendorModel);

const paymentService = require("../../src/services/paymentService");
const logger = require("../../src/logger/logger");
const razorpay = require("../../src/config/razorpay");
const WalletService = require("../../src/services/walletService");
const Transaction = require("../../models/transaction");

describe("Payment Service Logging", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(logger, "info").mockImplementation(() => {});
    jest.spyOn(logger, "warn").mockImplementation(() => {});
    jest.spyOn(logger, "error").mockImplementation(() => {});
    jest.spyOn(logger, "debug").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("Razorpay Verification Logging", () => {
    test("should log successful Razorpay verification", async () => {
      jest.spyOn(razorpay.payments, "fetch").mockResolvedValue({
        id: "pay1",
        order_id: "order1",
        status: "captured",
        captured: true,
        amount: 10000,
        currency: "INR",
        method: "upi",
      });

      await paymentService.verifyWithRazorpay(
        createProcessingTransaction({ razorpayOrderId: "order1", currency: "INR" }),
        "pay1",
      );

      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "RAZORPAY_VERIFICATION_SUCCESS",
          paymentId: "pay1",
        }),
        expect.any(String),
      );
    });

    test("should log failed Razorpay validation", async () => {
      jest.spyOn(razorpay.payments, "fetch").mockResolvedValue({
        order_id: "wrong-order",
        status: "authorized",
        captured: false,
        currency: "USD",
        amount: 10000,
      });

      try {
        await paymentService.verifyWithRazorpay(
          createProcessingTransaction({ razorpayOrderId: "order1", currency: "INR" }),
          "pay1",
        );
        fail("Expected error");
      } catch (err) {
        expect(logger.warn).toHaveBeenCalledWith(
          expect.objectContaining({
            event: "RAZORPAY_VERIFICATION_FAILED",
          }),
          expect.any(String),
        );
      }
    });
  });

  describe("Wallet Credit Logging", () => {
    test("should log wallet credit success", async () => {
      jest.spyOn(WalletService, "credit").mockResolvedValue({
        entity: createUser(),
        ledger: { _id: "ledger1" },
      });

      await paymentService.creditBalanceWithAudit(
        createProcessingTransaction(),
        100,
        {},
        "payment_order_123",
        "payment_order_123",
      );

      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "WALLET_CREDITED_IN_PAYMENT",
        }),
        expect.any(String),
      );
    });

    test("should log wallet credit failure", async () => {
      jest.spyOn(WalletService, "credit").mockRejectedValue(new Error("Ledger failure"));

      await expect(
        paymentService.creditBalanceWithAudit(
          createProcessingTransaction(),
          100,
          {},
          "payment_order_123",
          "payment_order_123",
        ),
      ).rejects.toThrow();

      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "WALLET_CREDIT_FAILED_IN_PAYMENT",
        }),
        expect.any(String),
      );
    });
  });

  describe("Transaction Failure Logging", () => {
    test("should log transaction marked failed", async () => {
      jest.spyOn(Transaction, "findOneAndUpdate").mockResolvedValue({
        _id: "txn1",
        razorpayOrderId: "order1",
        status: "failed",
        userId: "user1",
        failedAt: new Date(),
        errorCode: "SDK_ERROR",
      });

      await paymentService.markTransactionFailed("order1", {
        code: "SDK_ERROR",
        message: "Gateway failed",
      });

      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "PAYMENT_MARKED_FAILED",
        }),
        expect.any(String),
      );
    });

    test("should log transaction update failures", async () => {
      jest.spyOn(Transaction, "findOneAndUpdate").mockRejectedValue(new Error("Mongo unavailable"));

      await paymentService.markTransactionFailed("order1", {
        code: "SDK_ERROR",
      });

      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "PAYMENT_MARK_FAILED_ERROR",
        }),
        expect.any(String),
      );
    });
  });
});
