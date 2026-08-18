/**
 * payment.service.razorpay.test.js
 * Tests for verifyWithRazorpay() - Razorpay API integration and payment validation
 */

"use strict";

const { mockRazorpay } = require("../helpers/mock");
const { createPayment, createProcessingTransaction } = require("../helpers/fixtures");

jest.mock("../../src/logger/logger", () => require("../helpers/mock").mockLogger);
jest.mock("../../src/config/razorpay", () => require("../helpers/mock").mockRazorpay);

const paymentService = require("../../src/services/paymentService");
const razorpay = require("../../src/config/razorpay");

describe("Razorpay Verification Service", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(razorpay.payments, "fetch");
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("should verify Razorpay payment successfully", async () => {
    const mockPayment = createPayment();
    razorpay.payments.fetch.mockResolvedValue(mockPayment);

    const transaction = createProcessingTransaction({
      razorpayOrderId: mockPayment.order_id,
      currency: mockPayment.currency,
    });

    const result = await paymentService.verifyWithRazorpay(transaction, "pay_123");

    expect(result.id).toBe(mockPayment.id);
    expect(razorpay.payments.fetch).toHaveBeenCalledWith("pay_123");
  });

  test("should reject payment not captured (status)", async () => {
    const mockPayment = createPayment({
      status: "authorized",
      captured: false,
    });
    razorpay.payments.fetch.mockResolvedValue(mockPayment);

    const transaction = createProcessingTransaction({
      razorpayOrderId: mockPayment.order_id,
      currency: mockPayment.currency,
    });

    await expect(paymentService.verifyWithRazorpay(transaction, "pay_123")).rejects.toMatchObject({
      code: "PAYMENT_NOT_CAPTURED",
    });
  });

  test("should reject order id mismatch", async () => {
    const mockPayment = createPayment({
      order_id: "different-order",
    });
    razorpay.payments.fetch.mockResolvedValue(mockPayment);

    const transaction = createProcessingTransaction({
      razorpayOrderId: "order_123",
      currency: mockPayment.currency,
    });

    await expect(paymentService.verifyWithRazorpay(transaction, "pay_123")).rejects.toMatchObject({
      code: "ORDER_ID_MISMATCH",
    });
  });

  test("should reject currency mismatch", async () => {
    const mockPayment = createPayment({
      currency: "USD",
    });
    razorpay.payments.fetch.mockResolvedValue(mockPayment);

    const transaction = createProcessingTransaction({
      razorpayOrderId: mockPayment.order_id,
      currency: "INR",
    });

    await expect(paymentService.verifyWithRazorpay(transaction, "pay_123")).rejects.toMatchObject({
      code: "CURRENCY_MISMATCH",
    });
  });

  test("should reject captured flag false", async () => {
    const mockPayment = createPayment({
      status: "captured",
      captured: false,
    });
    razorpay.payments.fetch.mockResolvedValue(mockPayment);

    const transaction = createProcessingTransaction({
      razorpayOrderId: mockPayment.order_id,
      currency: mockPayment.currency,
    });

    await expect(paymentService.verifyWithRazorpay(transaction, "pay_123")).rejects.toMatchObject({
      code: "PAYMENT_NOT_CAPTURED",
    });
  });

  test("should expose validationErrors array", async () => {
    const mockPayment = createPayment({
      order_id: "wrong",
      status: "authorized",
      captured: false,
      currency: "USD",
    });
    razorpay.payments.fetch.mockResolvedValue(mockPayment);

    try {
      await paymentService.verifyWithRazorpay(
        createProcessingTransaction({
          razorpayOrderId: "order_123",
          currency: "INR",
        }),
        "pay_123",
      );
      fail("Expected error");
    } catch (err) {
      expect(err.validationErrors).toHaveLength(4);
      expect(err.validationErrors[0]).toHaveProperty("field");
    }
  });

  test("should preserve business errors", async () => {
    const error = new Error("Order mismatch");
    error.code = "ORDER_ID_MISMATCH";
    razorpay.payments.fetch.mockRejectedValue(error);

    await expect(
      paymentService.verifyWithRazorpay(
        createProcessingTransaction({ razorpayOrderId: "order_123" }),
        "pay_123",
      ),
    ).rejects.toMatchObject({
      code: "ORDER_ID_MISMATCH",
    });
  });

  test("should wrap SDK errors", async () => {
    razorpay.payments.fetch.mockRejectedValue(new Error("Network timeout"));

    await expect(
      paymentService.verifyWithRazorpay(
        createProcessingTransaction({ razorpayOrderId: "order_123" }),
        "pay_123",
      ),
    ).rejects.toMatchObject({
      code: "RAZORPAY_API_ERROR",
    });
  });

  test("should keep original SDK error", async () => {
    const sdkError = new Error("ECONNRESET");
    razorpay.payments.fetch.mockRejectedValue(sdkError);

    try {
      await paymentService.verifyWithRazorpay(
        createProcessingTransaction({ razorpayOrderId: "order_123" }),
        "pay_123",
      );
      fail("Expected error");
    } catch (err) {
      expect(err.code).toBe("RAZORPAY_API_ERROR");
      expect(err.originalError).toBe(sdkError);
    }
  });
});
