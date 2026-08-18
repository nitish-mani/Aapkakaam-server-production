/**
 * payment.controller.verify.test.js
 * Controller tests for payment verification endpoint
 * Only HTTP concerns: status codes, response body, service invocation
 */

"use strict";

const express = require("express");
const request = require("supertest");
const { payment_verification } = require("../../controller/payment");
const { mockLogger, mockTransactionModel } = require("../helpers/mock");
const {
  createValidRequestBody,
  createExpressRequest,
  createExpressResponse,
} = require("../helpers/fixtures");
const { buildHeaders, expectSuccessResponse, expectApiError } = require("../helpers/setup");

// Mock dependencies once
jest.mock("../../src/services/paymentService", () => ({
  verifyPayment: jest.fn(),
}));

jest.mock("../../src/logger/logger", () => require("../helpers/mock").mockLogger);

const paymentService = require("../../src/services/paymentService");
const logger = require("../../src/logger/logger");

describe("Payment Verification Controller", () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();

    app = express();
    app.use(express.json());

    // Auth middleware
    app.post(
      "/verify",
      (req, res, next) => {
        req.user = { _id: "507f1f77bcf86cd799439011" };
        next();
      },
      payment_verification,
    );
  });

  describe("HTTP Response Mapping", () => {
    test("should return 200 on successful verification", async () => {
      paymentService.verifyPayment.mockResolvedValue({
        success: true,
        payment_id: "pay_123",
        order_id: "order_123",
        balance: 250,
        totalDiscount: 50,
        transactionCount: 3,
        totalOriginalAmount: 300,
        transaction: {
          _id: "txn123",
          status: "completed",
        },
      });

      const res = await request(app)
        .post("/verify")
        .set("x-request-id", "req-123")
        .send(createValidRequestBody());

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.payment_id).toBe("pay_123");
      expect(paymentService.verifyPayment).toHaveBeenCalledTimes(1);
    });

    test("should pass request id header to service", async () => {
      paymentService.verifyPayment.mockResolvedValue({ success: true });

      await request(app)
        .post("/verify")
        .set("x-request-id", "abc-123")
        .send(createValidRequestBody());

      expect(paymentService.verifyPayment).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: "abc-123",
        }),
      );
    });

    test("should generate request id when absent", async () => {
      paymentService.verifyPayment.mockResolvedValue({ success: true });

      await request(app).post("/verify").send(createValidRequestBody());

      const args = paymentService.verifyPayment.mock.calls[0][0];
      expect(args.requestId).toEqual(expect.any(String));
    });

    test("should forward ip address from x-forwarded-for", async () => {
      paymentService.verifyPayment.mockResolvedValue({ success: true });

      await request(app)
        .post("/verify")
        .set("x-forwarded-for", "10.1.1.5")
        .send(createValidRequestBody());

      expect(paymentService.verifyPayment).toHaveBeenCalledWith(
        expect.objectContaining({
          ipAddress: "10.1.1.5",
        }),
      );
    });

    test("should use vendor id when authenticated as vendor", async () => {
      app = express();
      app.use(express.json());

      app.post(
        "/verify",
        (req, res, next) => {
          req.vendor = { _id: "507f1f77bcf86cd799439022" };
          next();
        },
        payment_verification,
      );

      paymentService.verifyPayment.mockResolvedValue({ success: true });

      await request(app).post("/verify").send(createValidRequestBody());

      expect(paymentService.verifyPayment).toHaveBeenCalledWith(
        expect.objectContaining({
          vendorId: "507f1f77bcf86cd799439022",
          userId: null,
        }),
      );
    });
  });

  describe("Error Mapping", () => {
    test("invalid signature -> 400", async () => {
      paymentService.verifyPayment.mockRejectedValue(new Error("Invalid payment signature"));

      const res = await request(app).post("/verify").send(createValidRequestBody());

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("INVALID_SIGNATURE");
    });

    test("transaction not found -> 404", async () => {
      paymentService.verifyPayment.mockRejectedValue(new Error("Transaction not found"));

      const res = await request(app).post("/verify").send(createValidRequestBody());

      expect(res.status).toBe(404);
      expect(res.body.code).toBe("TRANSACTION_NOT_FOUND");
    });

    test("already verified -> 409", async () => {
      paymentService.verifyPayment.mockRejectedValue(new Error("Payment already verified"));

      const res = await request(app).post("/verify").send(createValidRequestBody());

      expect(res.status).toBe(409);
      expect(res.body.code).toBe("ALREADY_VERIFIED");
    });

    test("already credited -> 409", async () => {
      paymentService.verifyPayment.mockRejectedValue(new Error("Wallet already credited"));

      const res = await request(app).post("/verify").send(createValidRequestBody());

      expect(res.status).toBe(409);
      expect(res.body.code).toBe("ALREADY_CREDITED");
    });

    test("amount mismatch -> 400", async () => {
      paymentService.verifyPayment.mockRejectedValue(new Error("Amount mismatch"));

      const res = await request(app).post("/verify").send(createValidRequestBody());

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("AMOUNT_MISMATCH");
    });

    test("processing -> 409", async () => {
      paymentService.verifyPayment.mockRejectedValue(new Error("already processing"));

      const res = await request(app).post("/verify").send(createValidRequestBody());

      expect(res.status).toBe(409);
      expect(res.body.code).toBe("CONCURRENT_PROCESSING");
    });

    test("unexpected error -> 500", async () => {
      paymentService.verifyPayment.mockRejectedValue(new Error("Database unavailable"));

      const res = await request(app).post("/verify").send(createValidRequestBody());

      expect(res.status).toBe(500);
      expect(res.body.code).toBe("VERIFICATION_FAILED");
    });
  });

  describe("Logging", () => {
    test("should log verification failures", async () => {
      paymentService.verifyPayment.mockRejectedValue(new Error("Database unavailable"));

      await request(app).post("/verify").send(createValidRequestBody());

      expect(logger.error).toHaveBeenCalledTimes(1);
    });
  });
});
