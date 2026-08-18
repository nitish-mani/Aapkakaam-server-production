"use strict";

/**
 * payment.verify.test.js
 *
 * Part 1
 *
 * Production-grade Jest tests for payment verification.
 *
 * Focus:
 *  - Controller validation
 *  - Successful verification
 *  - Required field validation
 *  - HTTP response mapping
 *  - Service invocation
 */

const express = require("express");
const request = require("supertest");

jest.mock("../../src/services/paymentService", () => ({
  verifyPayment: jest.fn(),
}));

jest.mock("../../src/logger/logger", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const paymentService = require("../../src/services/paymentService");
const logger = require("../../src/logger/logger");

const { payment_verification } = require("../../controller/payment");

describe("Payment Verification Controller", () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();

    app = express();

    app.use(express.json());

    app.post(
      "/verify",
      (req, res, next) => {
        req.user = {
          _id: "user123",
        };

        next();
      },
      payment_verification,
    );
  });

  describe("Successful Verification", () => {
    test("should verify payment successfully", async () => {
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

      const res = await request(app).post("/verify").set("x-request-id", "req-1").send({
        razorpay_order_id: "order_123",

        razorpay_payment_id: "pay_123",

        razorpay_signature: "signature",
      });

      expect(res.status).toBe(200);

      expect(res.body.success).toBe(true);

      expect(res.body.payment_id).toBe("pay_123");

      expect(paymentService.verifyPayment).toHaveBeenCalledTimes(1);

      expect(paymentService.verifyPayment).toHaveBeenCalledWith(
        expect.objectContaining({
          razorpay_order_id: "order_123",

          razorpay_payment_id: "pay_123",

          razorpay_signature: "signature",

          userId: "user123",
        }),
      );
    });

    test("should use vendor id when authenticated as vendor", async () => {
      app = express();

      app.use(express.json());

      app.post(
        "/verify",
        (req, res, next) => {
          req.vendor = {
            _id: "vendor123",
          };

          next();
        },
        payment_verification,
      );

      paymentService.verifyPayment.mockResolvedValue({
        success: true,
      });

      await request(app).post("/verify").send({
        razorpay_order_id: "order",

        razorpay_payment_id: "payment",

        razorpay_signature: "sig",
      });

      expect(paymentService.verifyPayment).toHaveBeenCalledWith(
        expect.objectContaining({
          vendorId: "vendor123",

          userId: null,
        }),
      );
    });
  });

  describe("Controller Validation", () => {
    test("should pass request id header", async () => {
      paymentService.verifyPayment.mockResolvedValue({
        success: true,
      });

      await request(app).post("/verify").set("x-request-id", "abc-123").send({
        razorpay_order_id: "o1",

        razorpay_payment_id: "p1",

        razorpay_signature: "s1",
      });

      expect(paymentService.verifyPayment).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: "abc-123",
        }),
      );
    });

    test("should generate request id when absent", async () => {
      paymentService.verifyPayment.mockResolvedValue({
        success: true,
      });

      await request(app).post("/verify").send({
        razorpay_order_id: "o1",

        razorpay_payment_id: "p1",

        razorpay_signature: "s1",
      });

      const args = paymentService.verifyPayment.mock.calls[0][0];

      expect(args.requestId).toEqual(expect.any(String));
    });

    test("should forward ip address", async () => {
      paymentService.verifyPayment.mockResolvedValue({
        success: true,
      });

      await request(app).post("/verify").set("x-forwarded-for", "10.1.1.5").send({
        razorpay_order_id: "o1",

        razorpay_payment_id: "p1",

        razorpay_signature: "sig",
      });

      expect(paymentService.verifyPayment).toHaveBeenCalledWith(
        expect.objectContaining({
          ipAddress: "10.1.1.5",
        }),
      );
    });
  });

  describe("Error Mapping", () => {
    test("invalid signature -> 400", async () => {
      paymentService.verifyPayment.mockRejectedValue(new Error("Invalid payment signature"));

      const res = await request(app).post("/verify").send({
        razorpay_order_id: "o",

        razorpay_payment_id: "p",

        razorpay_signature: "x",
      });

      expect(res.status).toBe(400);

      expect(res.body.code).toBe("INVALID_SIGNATURE");
    });

    test("transaction not found -> 404", async () => {
      paymentService.verifyPayment.mockRejectedValue(new Error("Transaction not found"));

      const res = await request(app).post("/verify").send({
        razorpay_order_id: "o",

        razorpay_payment_id: "p",

        razorpay_signature: "x",
      });

      expect(res.status).toBe(404);

      expect(res.body.code).toBe("TRANSACTION_NOT_FOUND");
    });

    test("already verified -> 409", async () => {
      paymentService.verifyPayment.mockRejectedValue(new Error("Payment already verified"));

      const res = await request(app).post("/verify").send({
        razorpay_order_id: "o",

        razorpay_payment_id: "p",

        razorpay_signature: "x",
      });

      expect(res.status).toBe(409);

      expect(res.body.code).toBe("ALREADY_VERIFIED");
    });

    test("already credited -> 409", async () => {
      paymentService.verifyPayment.mockRejectedValue(new Error("Wallet already credited"));

      const res = await request(app).post("/verify").send({
        razorpay_order_id: "o",

        razorpay_payment_id: "p",

        razorpay_signature: "x",
      });

      expect(res.status).toBe(409);

      expect(res.body.code).toBe("ALREADY_CREDITED");
    });

    test("amount mismatch -> 400", async () => {
      paymentService.verifyPayment.mockRejectedValue(new Error("Amount mismatch"));

      const res = await request(app).post("/verify").send({
        razorpay_order_id: "o",

        razorpay_payment_id: "p",

        razorpay_signature: "x",
      });

      expect(res.status).toBe(400);

      expect(res.body.code).toBe("AMOUNT_MISMATCH");
    });

    test("processing -> 409", async () => {
      paymentService.verifyPayment.mockRejectedValue(new Error("already processing"));

      const res = await request(app).post("/verify").send({
        razorpay_order_id: "o",

        razorpay_payment_id: "p",

        razorpay_signature: "x",
      });

      expect(res.status).toBe(409);

      expect(res.body.code).toBe("CONCURRENT_PROCESSING");
    });

    test("unexpected error -> 500", async () => {
      paymentService.verifyPayment.mockRejectedValue(new Error("Database unavailable"));

      const res = await request(app).post("/verify").send({
        razorpay_order_id: "o",

        razorpay_payment_id: "p",

        razorpay_signature: "x",
      });

      expect(res.status).toBe(500);

      expect(res.body.code).toBe("VERIFICATION_FAILED");
    });
  });

  describe("Logging", () => {
    test("should log verification failures", async () => {
      paymentService.verifyPayment.mockRejectedValue(new Error("Database unavailable"));

      await request(app).post("/verify").send({
        razorpay_order_id: "order",

        razorpay_payment_id: "payment",

        razorpay_signature: "sig",
      });

      expect(logger.error).toHaveBeenCalledTimes(1);
    });
  });
});
describe("validatePaymentFields()", () => {
  let paymentService;

  beforeEach(() => {
    jest.resetModules();
    paymentService = require("../../src/services/paymentService");
  });

  test("should not throw for valid payment fields", () => {
    expect(() => {
      paymentService.validatePaymentFields("order_123", "pay_123", "signature_123");
    }).not.toThrow();
  });

  test("should throw when order id is missing", () => {
    expect(() => {
      paymentService.validatePaymentFields(null, "pay_123", "signature");
    }).toThrow("Missing required payment fields");

    try {
      paymentService.validatePaymentFields(null, "pay_123", "signature");
    } catch (err) {
      expect(err.code).toBe("MISSING_PAYMENT_FIELDS");
    }
  });

  test("should throw when payment id is missing", () => {
    expect(() => {
      paymentService.validatePaymentFields("order", "", "signature");
    }).toThrow("Missing required payment fields");

    try {
      paymentService.validatePaymentFields("order", "", "signature");
    } catch (err) {
      expect(err.code).toBe("MISSING_PAYMENT_FIELDS");
    }
  });

  test("should throw when signature is missing", () => {
    expect(() => {
      paymentService.validatePaymentFields("order", "payment", undefined);
    }).toThrow("Missing required payment fields");

    try {
      paymentService.validatePaymentFields("order", "payment", undefined);
    } catch (err) {
      expect(err.code).toBe("MISSING_PAYMENT_FIELDS");
    }
  });

  test("should reject all empty strings", () => {
    expect(() => {
      paymentService.validatePaymentFields("", "", "");
    }).toThrow();

    try {
      paymentService.validatePaymentFields("", "", "");
    } catch (err) {
      expect(err.code).toBe("MISSING_PAYMENT_FIELDS");
    }
  });
});
describe("validateAmount()", () => {
  let paymentService;

  beforeEach(() => {
    jest.resetModules();
    paymentService = require("../../src/services/paymentService");
  });

  test("should accept valid amount", () => {
    expect(paymentService.validateAmount(500)).toBe(500);
  });

  test("should convert numeric string", () => {
    expect(paymentService.validateAmount("250")).toBe(250);
  });

  test("should reject NaN", () => {
    expect(() => {
      paymentService.validateAmount("abc");
    }).toThrow("Invalid payment amount");

    try {
      paymentService.validateAmount("abc");
    } catch (err) {
      expect(err.code).toBe("INVALID_AMOUNT");
    }
  });

  test("should reject zero", () => {
    expect(() => {
      paymentService.validateAmount(0);
    }).toThrow("Amount must be greater than zero");

    try {
      paymentService.validateAmount(0);
    } catch (err) {
      expect(err.code).toBe("INVALID_AMOUNT");
    }
  });

  test("should reject negative amount", () => {
    expect(() => {
      paymentService.validateAmount(-100);
    }).toThrow("Amount must be greater than zero");
  });

  test("should reject unrealistic amount", () => {
    expect(() => {
      paymentService.validateAmount(1000001);
    }).toThrow("Amount exceeds maximum allowed limit");

    try {
      paymentService.validateAmount(1000001);
    } catch (err) {
      expect(err.code).toBe("AMOUNT_TOO_LARGE");
    }
  });
});
describe("verifySignature()", () => {
  let paymentService;
  let ENV;
  const crypto = require("crypto");

  beforeEach(() => {
    jest.resetModules();

    ENV = require("../../src/config/env");
    paymentService = require("../../src/services/paymentService");

    ENV.RAZORPAY_SECRET = "test_secret_key";
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("should verify a valid Razorpay signature", () => {
    const orderId = "order_ABC123";
    const paymentId = "pay_XYZ123";

    const signature = crypto
      .createHmac("sha256", ENV.RAZORPAY_SECRET)
      .update(`${orderId}|${paymentId}`)
      .digest("hex");

    expect(() => {
      paymentService.verifySignature(orderId, paymentId, signature);
    }).not.toThrow();
  });

  test("should reject invalid signature", () => {
    expect(() => {
      paymentService.verifySignature("order1", "payment1", "invalid_signature");
    }).toThrow("Invalid payment signature");

    try {
      paymentService.verifySignature("order1", "payment1", "invalid_signature");
    } catch (err) {
      expect(err.code).toBe("INVALID_PAYMENT_SIGNATURE");
    }
  });

  test("should reject modified payment id", () => {
    const signature = crypto
      .createHmac("sha256", ENV.RAZORPAY_SECRET)
      .update("order123|payment123")
      .digest("hex");

    expect(() => {
      paymentService.verifySignature("order123", "payment999", signature);
    }).toThrow("Invalid payment signature");
  });

  test("should reject modified order id", () => {
    const signature = crypto
      .createHmac("sha256", ENV.RAZORPAY_SECRET)
      .update("order123|payment123")
      .digest("hex");

    expect(() => {
      paymentService.verifySignature("order999", "payment123", signature);
    }).toThrow("Invalid payment signature");
  });

  test("should throw SIGNATURE_VERIFICATION_FAILED when crypto fails", () => {
    jest.spyOn(crypto, "createHmac").mockImplementation(() => {
      throw new Error("crypto failed");
    });

    expect(() => {
      paymentService.verifySignature("order123", "payment123", "signature");
    }).toThrow("Signature verification failed");

    try {
      paymentService.verifySignature("order123", "payment123", "signature");
    } catch (err) {
      expect(err.code).toBe("SIGNATURE_VERIFICATION_FAILED");
    }
  });

  test("should preserve business errors without wrapping", () => {
    const signature = "bad_signature";

    try {
      paymentService.verifySignature("order", "payment", signature);
    } catch (err) {
      expect(err.code).toBe("INVALID_PAYMENT_SIGNATURE");
      expect(err.message).toBe("Invalid payment signature");
    }
  });

  test("should reject signature with different length", () => {
    expect(() => {
      paymentService.verifySignature("order123", "payment123", "abc");
    }).toThrow("Invalid payment signature");
  });

  test("should reject empty signature", () => {
    expect(() => {
      paymentService.verifySignature("order123", "payment123", "");
    }).toThrow("Invalid payment signature");
  });
});
describe("validateOwnership()", () => {
  let paymentService;
  let User;
  let Vendor;

  beforeEach(() => {
    jest.resetModules();

    paymentService = require("../../src/services/paymentService");
    User = require("../../models/user");
    Vendor = require("../../models/vendor");

    jest.spyOn(User, "findById");
    jest.spyOn(Vendor, "findById");
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("should validate user ownership", async () => {
    User.findById.mockReturnValue({
      select: () => ({
        lean: async () => ({ _id: "user1" }),
      }),
    });

    await expect(
      paymentService.validateOwnership(
        {
          _id: "txn1",
          userId: {
            toString: () => "user1",
          },
        },
        "user1",
        null,
      ),
    ).resolves.toBeUndefined();
  });

  test("should validate vendor ownership", async () => {
    Vendor.findById.mockReturnValue({
      select: () => ({
        lean: async () => ({ _id: "vendor1" }),
      }),
    });

    await expect(
      paymentService.validateOwnership(
        {
          _id: "txn1",
          vendorId: {
            toString: () => "vendor1",
          },
        },
        null,
        "vendor1",
      ),
    ).resolves.toBeUndefined();
  });

  test("should reject user ownership mismatch", async () => {
    await expect(
      paymentService.validateOwnership(
        {
          _id: "txn1",
          userId: {
            toString: () => "userA",
          },
        },
        "userB",
        null,
      ),
    ).rejects.toMatchObject({
      code: "USER_OWNERSHIP_MISMATCH",
    });
  });

  test("should reject vendor ownership mismatch", async () => {
    await expect(
      paymentService.validateOwnership(
        {
          _id: "txn1",
          vendorId: {
            toString: () => "vendorA",
          },
        },
        null,
        "vendorB",
      ),
    ).rejects.toMatchObject({
      code: "VENDOR_OWNERSHIP_MISMATCH",
    });
  });

  test("should throw USER_NOT_FOUND", async () => {
    User.findById.mockReturnValue({
      select: () => ({
        lean: async () => null,
      }),
    });

    await expect(
      paymentService.validateOwnership(
        {
          _id: "txn1",
          userId: {
            toString: () => "user1",
          },
        },
        "user1",
        null,
      ),
    ).rejects.toMatchObject({
      code: "USER_NOT_FOUND",
    });
  });

  test("should throw VENDOR_NOT_FOUND", async () => {
    Vendor.findById.mockReturnValue({
      select: () => ({
        lean: async () => null,
      }),
    });

    await expect(
      paymentService.validateOwnership(
        {
          _id: "txn1",
          vendorId: {
            toString: () => "vendor1",
          },
        },
        null,
        "vendor1",
      ),
    ).rejects.toMatchObject({
      code: "VENDOR_NOT_FOUND",
    });
  });

  test("should compare ObjectId and string correctly", async () => {
    User.findById.mockReturnValue({
      select: () => ({
        lean: async () => ({ _id: "507f1f77bcf86cd799439011" }),
      }),
    });

    await expect(
      paymentService.validateOwnership(
        {
          _id: "txn1",
          userId: {
            toString: () => "507f1f77bcf86cd799439011",
          },
        },
        "507f1f77bcf86cd799439011",
        null,
      ),
    ).resolves.toBeUndefined();
  });

  test("should skip user lookup when userId not supplied", async () => {
    Vendor.findById.mockReturnValue({
      select: () => ({
        lean: async () => ({ _id: "vendor1" }),
      }),
    });

    await paymentService.validateOwnership(
      {
        _id: "txn1",
        vendorId: {
          toString: () => "vendor1",
        },
      },
      null,
      "vendor1",
    );

    expect(User.findById).not.toHaveBeenCalled();
    expect(Vendor.findById).toHaveBeenCalledTimes(1);
  });

  test("should skip vendor lookup when vendorId not supplied", async () => {
    User.findById.mockReturnValue({
      select: () => ({
        lean: async () => ({ _id: "user1" }),
      }),
    });

    await paymentService.validateOwnership(
      {
        _id: "txn1",
        userId: {
          toString: () => "user1",
        },
      },
      "user1",
      null,
    );

    expect(Vendor.findById).not.toHaveBeenCalled();
    expect(User.findById).toHaveBeenCalledTimes(1);
  });
});
describe("acquireProcessingLock()", () => {
  let paymentService;
  let Transaction;

  beforeEach(() => {
    jest.resetModules();

    paymentService = require("../../src/services/paymentService");
    Transaction = require("../../models/transaction");

    jest.spyOn(Transaction, "findOneAndUpdate");
    jest.spyOn(Transaction, "findOne");
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("should acquire processing lock", async () => {
    const txn = {
      _id: "txn1",
      razorpayOrderId: "order1",
      userId: "user1",
      vendorId: null,
      status: "processing",
    };

    Transaction.findOneAndUpdate.mockResolvedValue(txn);

    const result = await paymentService.acquireProcessingLock(
      "order1",
      "payment1",
      "signature",
      null,
    );

    expect(result.locked).toBe(true);
    expect(result.alreadyCompleted).toBe(false);
    expect(result.transaction).toBe(txn);

    expect(Transaction.findOneAndUpdate).toHaveBeenCalledWith(
      {
        razorpayOrderId: "order1",
        status: "initiated",
      },
      expect.objectContaining({
        $set: expect.objectContaining({
          status: "processing",
          razorpayPaymentId: "payment1",
          razorpaySignature: "signature",
        }),
      }),
      expect.any(Object),
    );
  });

  test("should return idempotent response when already completed", async () => {
    Transaction.findOneAndUpdate.mockResolvedValue(null);

    Transaction.findOne.mockReturnValue({
      select: () => ({
        lean: () => ({
          _id: "txn1",
          status: "completed",
          razorpayPaymentId: "payment1",
        }),
        session() {
          return this;
        },
      }),
    });

    const result = await paymentService.acquireProcessingLock(
      "order1",
      "payment1",
      "signature",
      null,
    );

    expect(result.locked).toBe(false);
    expect(result.alreadyCompleted).toBe(true);
    expect(result.transaction.status).toBe("completed");
  });

  test("should throw PAYMENT_ALREADY_PROCESSING", async () => {
    Transaction.findOneAndUpdate.mockResolvedValue(null);

    Transaction.findOne.mockReturnValue({
      select: () => ({
        lean: () => ({
          _id: "txn1",
          status: "processing",
        }),
        session() {
          return this;
        },
      }),
    });

    await expect(
      paymentService.acquireProcessingLock("order1", "payment1", "signature", null),
    ).rejects.toMatchObject({
      code: "PAYMENT_ALREADY_PROCESSING",
    });
  });

  test("should throw TRANSACTION_NOT_FOUND", async () => {
    Transaction.findOneAndUpdate.mockResolvedValue(null);

    Transaction.findOne.mockReturnValue({
      select: () => ({
        lean: () => null,
        session() {
          return this;
        },
      }),
    });

    await expect(
      paymentService.acquireProcessingLock("order1", "payment1", "signature", null),
    ).rejects.toMatchObject({
      code: "TRANSACTION_NOT_FOUND",
    });
  });

  test("should reject failed transaction", async () => {
    Transaction.findOneAndUpdate.mockResolvedValue(null);

    Transaction.findOne.mockReturnValue({
      select: () => ({
        lean: () => ({
          _id: "txn1",
          status: "failed",
        }),
        session() {
          return this;
        },
      }),
    });

    await expect(
      paymentService.acquireProcessingLock("order1", "payment1", "signature", null),
    ).rejects.toMatchObject({
      code: "INVALID_PAYMENT_STATE",
    });
  });

  test("should reject refunded transaction", async () => {
    Transaction.findOneAndUpdate.mockResolvedValue(null);

    Transaction.findOne.mockReturnValue({
      select: () => ({
        lean: () => ({
          _id: "txn1",
          status: "refunded",
        }),
        session() {
          return this;
        },
      }),
    });

    await expect(
      paymentService.acquireProcessingLock("order1", "payment1", "signature", null),
    ).rejects.toMatchObject({
      code: "INVALID_PAYMENT_STATE",
    });
  });

  test("should reject abandoned transaction", async () => {
    Transaction.findOneAndUpdate.mockResolvedValue(null);

    Transaction.findOne.mockReturnValue({
      select: () => ({
        lean: () => ({
          _id: "txn1",
          status: "abandoned",
        }),
        session() {
          return this;
        },
      }),
    });

    await expect(
      paymentService.acquireProcessingLock("order1", "payment1", "signature", null),
    ).rejects.toMatchObject({
      code: "INVALID_PAYMENT_STATE",
    });
  });

  test("should reject pending transaction", async () => {
    Transaction.findOneAndUpdate.mockResolvedValue(null);

    Transaction.findOne.mockReturnValue({
      select: () => ({
        lean: () => ({
          _id: "txn1",
          status: "pending",
        }),
        session() {
          return this;
        },
      }),
    });

    await expect(
      paymentService.acquireProcessingLock("order1", "payment1", "signature", null),
    ).rejects.toMatchObject({
      code: "INVALID_PAYMENT_STATE",
    });
  });

  test("should store payment id while locking", async () => {
    Transaction.findOneAndUpdate.mockResolvedValue({
      _id: "txn1",
      status: "processing",
    });

    await paymentService.acquireProcessingLock("orderABC", "payXYZ", "sig123", null);

    const update = Transaction.findOneAndUpdate.mock.calls[0][1];

    expect(update.$set.razorpayPaymentId).toBe("payXYZ");
    expect(update.$set.razorpaySignature).toBe("sig123");
    expect(update.$set.processingStartedAt).toBeInstanceOf(Date);
  });
});
describe("verifyAmount()", () => {
  let paymentService;

  beforeEach(() => {
    jest.resetModules();
    paymentService = require("../../src/services/paymentService");
  });

  test("should verify matching amount", async () => {
    const transaction = {
      finalAmount: 500,
    };

    const payment = {
      amount: 50000, // paise
    };

    await expect(paymentService.verifyAmount(transaction, payment)).resolves.toBe(true);
  });

  test("should reject amount mismatch", async () => {
    const transaction = {
      finalAmount: 500,
    };

    const payment = {
      amount: 40000,
    };

    await expect(paymentService.verifyAmount(transaction, payment)).rejects.toMatchObject({
      code: "AMOUNT_MISMATCH",
    });
  });

  test("should reject when payment object is missing", async () => {
    await expect(
      paymentService.verifyAmount(
        {
          finalAmount: 500,
        },
        null,
      ),
    ).rejects.toMatchObject({
      code: "PAYMENT_OBJECT_MISSING",
    });
  });

  test("should verify decimal final amount", async () => {
    const transaction = {
      finalAmount: 499.99,
    };

    const payment = {
      amount: Math.round(499.99 * 100),
    };

    await expect(paymentService.verifyAmount(transaction, payment)).resolves.toBe(true);
  });

  test("should use rounded paise value", async () => {
    const transaction = {
      finalAmount: 99.995,
    };

    const payment = {
      amount: 10000,
    };

    await expect(paymentService.verifyAmount(transaction, payment)).resolves.toBe(true);
  });

  test("should reject one paisa difference", async () => {
    const transaction = {
      finalAmount: 100,
    };

    const payment = {
      amount: 9999,
    };

    await expect(paymentService.verifyAmount(transaction, payment)).rejects.toHaveProperty(
      "code",
      "AMOUNT_MISMATCH",
    );
  });

  test("error should include expected and actual amount", async () => {
    try {
      await paymentService.verifyAmount(
        {
          finalAmount: 250,
        },
        {
          amount: 20000,
        },
      );

      throw new Error("Expected verifyAmount to throw");
    } catch (err) {
      expect(err.code).toBe("AMOUNT_MISMATCH");
      expect(err.message).toContain("Expected");
      expect(err.message).toContain("got");
    }
  });
});
describe("verifyPayment() - Happy Path", () => {
  let paymentService;
  let mongoose;

  beforeEach(() => {
    jest.resetModules();

    mongoose = require("mongoose");
    paymentService = require("../../src/services/paymentService");

    jest.spyOn(paymentService, "validatePaymentFields").mockImplementation(() => {});
    jest.spyOn(paymentService, "verifySignature").mockImplementation(() => {});
    jest.spyOn(paymentService, "acquireProcessingLock");
    jest.spyOn(paymentService, "validateOwnership").mockResolvedValue();
    jest.spyOn(paymentService, "verifyWithRazorpay");
    jest.spyOn(paymentService, "processSuccessfulPayment");
    jest.spyOn(paymentService, "sendSuccessNotification").mockResolvedValue();

    jest.spyOn(mongoose, "startSession").mockResolvedValue({
      withTransaction: async (fn) => fn(),
      endSession: jest.fn(),
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("should verify payment successfully", async () => {
    const lockedTransaction = {
      _id: "txn1",
      razorpayOrderId: "order1",
      razorpayPaymentId: null,
      userId: "user1",
      vendorId: null,
      amount: 500,
      finalAmount: 450,
      discount: 50,
      discountPercent: 10,
      category: "user",
      status: "processing",
    };

    const updatedTransaction = {
      ...lockedTransaction,
      razorpayPaymentId: "pay1",
      status: "completed",
    };

    const entity = {
      _id: "user1",
      balance: 1450,
      totalDiscount: 50,
      transactionCount: 4,
      totalOriginalAmount: 500,
      phoneNo: 9999999999,
      name: "Nitish",
    };

    paymentService.acquireProcessingLock.mockResolvedValue({
      transaction: lockedTransaction,
      locked: true,
      alreadyCompleted: false,
    });

    paymentService.verifyWithRazorpay.mockResolvedValue({
      id: "pay1",
      amount: 45000,
      status: "captured",
      currency: "INR",
      captured: true,
      order_id: "order1",
    });

    paymentService.processSuccessfulPayment.mockResolvedValue({
      updatedTransaction,
      creditedEntity: entity,
    });

    const result = await paymentService.verifyPayment({
      razorpay_order_id: "order1",
      razorpay_payment_id: "pay1",
      razorpay_signature: "signature",
      userId: "user1",
      requestId: "req1",
      ipAddress: "127.0.0.1",
    });

    expect(result.success).toBe(true);

    expect(result.payment_id).toBe("pay1");

    expect(result.order_id).toBe("order1");

    expect(result.balance).toBe(1450);

    expect(paymentService.validatePaymentFields).toHaveBeenCalledWith(
      "order1",
      "pay1",
      "signature",
    );

    expect(paymentService.verifySignature).toHaveBeenCalledWith("order1", "pay1", "signature");

    expect(paymentService.acquireProcessingLock).toHaveBeenCalledTimes(1);

    expect(paymentService.validateOwnership).toHaveBeenCalledWith(lockedTransaction, "user1", null);

    expect(paymentService.verifyWithRazorpay).toHaveBeenCalledWith(lockedTransaction, "pay1");

    expect(paymentService.processSuccessfulPayment).toHaveBeenCalledTimes(1);

    expect(paymentService.sendSuccessNotification).toHaveBeenCalledTimes(1);
  });

  test("should return idempotent response when payment already completed", async () => {
    const completedTxn = {
      _id: "txn1",
      razorpayOrderId: "order1",
      razorpayPaymentId: "pay1",
      status: "completed",
    };

    jest.spyOn(paymentService, "getEntity").mockResolvedValue({
      balance: 900,
      totalDiscount: 100,
      transactionCount: 3,
      totalOriginalAmount: 1000,
    });

    paymentService.acquireProcessingLock.mockResolvedValue({
      transaction: completedTxn,
      locked: false,
      alreadyCompleted: true,
    });

    const result = await paymentService.verifyPayment({
      razorpay_order_id: "order1",
      razorpay_payment_id: "pay1",
      razorpay_signature: "signature",
      userId: "user1",
    });

    expect(result.success).toBe(true);

    expect(result.idempotent).toBe(true);

    expect(result.message).toBe("Payment already completed");

    expect(paymentService.processSuccessfulPayment).not.toHaveBeenCalled();

    expect(paymentService.sendSuccessNotification).not.toHaveBeenCalled();
  });

  test("should not send notification when wallet credit fails", async () => {
    const txn = {
      _id: "txn1",
      razorpayOrderId: "order1",
      userId: "user1",
      finalAmount: 100,
      status: "processing",
    };

    paymentService.acquireProcessingLock.mockResolvedValue({
      transaction: txn,
      locked: true,
      alreadyCompleted: false,
    });

    paymentService.verifyWithRazorpay.mockResolvedValue({
      order_id: "order1",
      status: "captured",
      amount: 10000,
      currency: "INR",
      captured: true,
    });

    paymentService.processSuccessfulPayment.mockRejectedValue(new Error("Wallet credit failed"));

    await expect(
      paymentService.verifyPayment({
        razorpay_order_id: "order1",
        razorpay_payment_id: "pay1",
        razorpay_signature: "signature",
        userId: "user1",
      }),
    ).rejects.toThrow("Wallet credit failed");

    expect(paymentService.sendSuccessNotification).not.toHaveBeenCalled();
  });
});
describe("verifyPayment() - Failure Paths", () => {
  let paymentService;
  let mongoose;

  beforeEach(() => {
    jest.resetModules();

    mongoose = require("mongoose");
    paymentService = require("../../src/services/paymentService");

    jest.spyOn(paymentService, "validatePaymentFields").mockImplementation(() => {});
    jest.spyOn(paymentService, "verifySignature").mockImplementation(() => {});
    jest.spyOn(paymentService, "acquireProcessingLock");
    jest.spyOn(paymentService, "validateOwnership").mockResolvedValue();
    jest.spyOn(paymentService, "verifyWithRazorpay");
    jest.spyOn(paymentService, "processSuccessfulPayment");
    jest.spyOn(paymentService, "markTransactionFailed").mockResolvedValue();

    jest.spyOn(mongoose, "startSession").mockResolvedValue({
      withTransaction: async (fn) => fn(),
      endSession: jest.fn(),
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("should rethrow PAYMENT_ALREADY_PROCESSING", async () => {
    const err = new Error("already processing");
    err.code = "PAYMENT_ALREADY_PROCESSING";

    paymentService.acquireProcessingLock.mockRejectedValue(err);

    await expect(
      paymentService.verifyPayment({
        razorpay_order_id: "order1",
        razorpay_payment_id: "pay1",
        razorpay_signature: "sig",
        userId: "user1",
      }),
    ).rejects.toMatchObject({
      code: "PAYMENT_ALREADY_PROCESSING",
    });

    expect(paymentService.markTransactionFailed).not.toHaveBeenCalled();
  });

  test("should rethrow TRANSACTION_NOT_FOUND", async () => {
    const err = new Error("Transaction not found");
    err.code = "TRANSACTION_NOT_FOUND";

    paymentService.acquireProcessingLock.mockRejectedValue(err);

    await expect(
      paymentService.verifyPayment({
        razorpay_order_id: "order1",
        razorpay_payment_id: "pay1",
        razorpay_signature: "sig",
        userId: "user1",
      }),
    ).rejects.toMatchObject({
      code: "TRANSACTION_NOT_FOUND",
    });

    expect(paymentService.markTransactionFailed).not.toHaveBeenCalled();
  });

  test("should rethrow INVALID_PAYMENT_STATE", async () => {
    const err = new Error("invalid state");
    err.code = "INVALID_PAYMENT_STATE";

    paymentService.acquireProcessingLock.mockRejectedValue(err);

    await expect(
      paymentService.verifyPayment({
        razorpay_order_id: "order1",
        razorpay_payment_id: "pay1",
        razorpay_signature: "sig",
        userId: "user1",
      }),
    ).rejects.toMatchObject({
      code: "INVALID_PAYMENT_STATE",
    });

    expect(paymentService.markTransactionFailed).not.toHaveBeenCalled();
  });

  test("should mark transaction failed on ownership error", async () => {
    const txn = {
      _id: "txn1",
      razorpayOrderId: "order1",
      userId: "user1",
      status: "processing",
    };

    paymentService.acquireProcessingLock.mockResolvedValue({
      transaction: txn,
      locked: true,
      alreadyCompleted: false,
    });

    const err = new Error("ownership failed");
    err.code = "USER_OWNERSHIP_MISMATCH";

    paymentService.validateOwnership.mockRejectedValue(err);

    await expect(
      paymentService.verifyPayment({
        razorpay_order_id: "order1",
        razorpay_payment_id: "pay1",
        razorpay_signature: "sig",
        userId: "user2",
      }),
    ).rejects.toMatchObject({
      code: "USER_OWNERSHIP_MISMATCH",
    });

    expect(paymentService.markTransactionFailed).toHaveBeenCalledWith("order1", err);
  });

  test("should mark transaction failed on Razorpay verification failure", async () => {
    const txn = {
      _id: "txn1",
      razorpayOrderId: "order1",
      userId: "user1",
      status: "processing",
    };

    paymentService.acquireProcessingLock.mockResolvedValue({
      transaction: txn,
      locked: true,
      alreadyCompleted: false,
    });

    const err = new Error("Gateway verification failed");
    err.code = "RAZORPAY_API_ERROR";

    paymentService.verifyWithRazorpay.mockRejectedValue(err);

    await expect(
      paymentService.verifyPayment({
        razorpay_order_id: "order1",
        razorpay_payment_id: "pay1",
        razorpay_signature: "sig",
        userId: "user1",
      }),
    ).rejects.toMatchObject({
      code: "RAZORPAY_API_ERROR",
    });

    expect(paymentService.markTransactionFailed).toHaveBeenCalledWith("order1", err);
  });

  test("should mark transaction failed on amount mismatch", async () => {
    const txn = {
      _id: "txn1",
      razorpayOrderId: "order1",
      userId: "user1",
      status: "processing",
    };

    paymentService.acquireProcessingLock.mockResolvedValue({
      transaction: txn,
      locked: true,
      alreadyCompleted: false,
    });

    paymentService.verifyWithRazorpay.mockResolvedValue({
      status: "captured",
      amount: 10000,
      currency: "INR",
      order_id: "order1",
    });

    const err = new Error("Amount mismatch");
    err.code = "AMOUNT_MISMATCH";

    paymentService.processSuccessfulPayment.mockRejectedValue(err);

    await expect(
      paymentService.verifyPayment({
        razorpay_order_id: "order1",
        razorpay_payment_id: "pay1",
        razorpay_signature: "sig",
        userId: "user1",
      }),
    ).rejects.toMatchObject({
      code: "AMOUNT_MISMATCH",
    });

    expect(paymentService.markTransactionFailed).toHaveBeenCalledTimes(1);
  });

  test("should assign VERIFICATION_FAILED when error has no code", async () => {
    const txn = {
      _id: "txn1",
      razorpayOrderId: "order1",
      userId: "user1",
      status: "processing",
    };

    paymentService.acquireProcessingLock.mockResolvedValue({
      transaction: txn,
      locked: true,
      alreadyCompleted: false,
    });

    paymentService.verifyWithRazorpay.mockRejectedValue(new Error("unexpected failure"));

    await expect(
      paymentService.verifyPayment({
        razorpay_order_id: "order1",
        razorpay_payment_id: "pay1",
        razorpay_signature: "sig",
        userId: "user1",
      }),
    ).rejects.toMatchObject({
      code: "VERIFICATION_FAILED",
    });

    const [, errorArg] = paymentService.markTransactionFailed.mock.calls[0];

    expect(errorArg.code).toBe("VERIFICATION_FAILED");
  });
});
describe("processSuccessfulPayment()", () => {
  let paymentService;
  let Transaction;

  beforeEach(() => {
    jest.resetModules();

    paymentService = require("../../src/services/paymentService");
    Transaction = require("../../models/transaction");

    jest.spyOn(paymentService, "verifyAmount").mockResolvedValue();
    jest.spyOn(paymentService, "creditBalanceWithAudit");
    jest.spyOn(Transaction, "findOneAndUpdate");
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("should complete successful payment", async () => {
    const session = {};

    const transaction = {
      _id: "txn1",
      razorpayOrderId: "order1",
      finalAmount: 450,
      userId: "user1",
      vendorId: null,
      status: "processing",
    };

    const creditedEntity = {
      _id: "user1",
      balance: 1450,
    };

    paymentService.creditBalanceWithAudit.mockResolvedValue(creditedEntity);

    Transaction.findOneAndUpdate.mockResolvedValue({
      _id: "txn1",
      status: "completed",
      razorpayOrderId: "order1",
      razorpayPaymentId: "pay1",
    });

    const result = await paymentService.processSuccessfulPayment({
      transaction,

      paymentId: "pay1",

      session,

      requestId: "req1",

      existingPayment: {
        amount: 45000,
      },
    });

    expect(paymentService.verifyAmount).toHaveBeenCalledWith(transaction, {
      amount: 45000,
    });

    expect(paymentService.creditBalanceWithAudit).toHaveBeenCalledWith(
      transaction,

      450,

      session,

      "payment_order1",

      "payment_order1",

      expect.any(String),

      expect.objectContaining({
        requestId: "req1",
      }),
    );

    expect(Transaction.findOneAndUpdate).toHaveBeenCalledTimes(1);

    expect(result.updatedTransaction.status).toBe("completed");

    expect(result.creditedEntity.balance).toBe(1450);
  });

  test("should mark transaction completed", async () => {
    paymentService.creditBalanceWithAudit.mockResolvedValue({
      balance: 500,
    });

    Transaction.findOneAndUpdate.mockResolvedValue({
      status: "completed",
    });

    await paymentService.processSuccessfulPayment({
      transaction: {
        _id: "txn1",
        razorpayOrderId: "orderABC",
        finalAmount: 100,
        status: "processing",
      },

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
    paymentService.creditBalanceWithAudit.mockResolvedValue({
      balance: 100,
    });

    Transaction.findOneAndUpdate.mockResolvedValue({
      status: "completed",
    });

    const order = [];

    paymentService.verifyAmount.mockImplementation(async () => {
      order.push("verify");
    });

    paymentService.creditBalanceWithAudit.mockImplementation(async () => {
      order.push("credit");
      return { balance: 100 };
    });

    await paymentService.processSuccessfulPayment({
      transaction: {
        _id: "txn1",
        razorpayOrderId: "order1",
        finalAmount: 100,
        status: "processing",
      },

      paymentId: "pay1",

      session: {},

      existingPayment: {
        amount: 10000,
      },
    });

    expect(order).toEqual(["verify", "credit"]);
  });

  test("should generate deterministic operation ids", async () => {
    paymentService.creditBalanceWithAudit.mockResolvedValue({
      balance: 100,
    });

    Transaction.findOneAndUpdate.mockResolvedValue({
      status: "completed",
    });

    await paymentService.processSuccessfulPayment({
      transaction: {
        _id: "txn1",
        razorpayOrderId: "orderXYZ",
        finalAmount: 100,
        status: "processing",
      },

      paymentId: "pay1",

      session: {},
    });

    expect(paymentService.creditBalanceWithAudit.mock.calls[0][3]).toBe("payment_orderXYZ");

    expect(paymentService.creditBalanceWithAudit.mock.calls[0][4]).toBe("payment_orderXYZ");
  });
});
describe("processSuccessfulPayment() - Failure Paths", () => {
  let paymentService;
  let Transaction;
  let PaymentSource;

  beforeEach(() => {
    jest.resetModules();

    paymentService = require("../../src/services/paymentService");
    Transaction = require("../../models/transaction");
    ({ PaymentSource } = require("../../src/constants/payment"));

    jest.spyOn(paymentService, "verifyAmount");
    jest.spyOn(paymentService, "creditBalanceWithAudit");
    jest.spyOn(Transaction, "findOneAndUpdate");
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("should stop when verifyAmount fails", async () => {
    const error = new Error("Amount mismatch");
    error.code = "AMOUNT_MISMATCH";

    paymentService.verifyAmount.mockRejectedValue(error);

    await expect(
      paymentService.processSuccessfulPayment({
        transaction: {
          _id: "txn1",
          razorpayOrderId: "order1",
          finalAmount: 100,
          status: "processing",
        },
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
        transaction: {
          _id: "txn1",
          razorpayOrderId: "order1",
          finalAmount: 100,
          status: "processing",
        },
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

    paymentService.creditBalanceWithAudit.mockResolvedValue({
      balance: 100,
    });

    Transaction.findOneAndUpdate.mockResolvedValue(null);

    await expect(
      paymentService.processSuccessfulPayment({
        transaction: {
          _id: "txn1",
          razorpayOrderId: "order1",
          finalAmount: 100,
          status: "processing",
        },

        paymentId: "pay1",

        session: {},
      }),
    ).rejects.toMatchObject({
      code: "TRANSACTION_UPDATE_FAILED",
    });
  });

  test("should set webhook fields for webhook source", async () => {
    paymentService.verifyAmount.mockResolvedValue();

    paymentService.creditBalanceWithAudit.mockResolvedValue({
      balance: 100,
    });

    Transaction.findOneAndUpdate.mockResolvedValue({
      status: "completed",
    });

    await paymentService.processSuccessfulPayment({
      transaction: {
        _id: "txn1",
        razorpayOrderId: "order1",
        finalAmount: 100,
        status: "processing",
      },

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

    paymentService.creditBalanceWithAudit.mockResolvedValue({
      balance: 100,
    });

    Transaction.findOneAndUpdate.mockResolvedValue({
      status: "completed",
    });

    await paymentService.processSuccessfulPayment({
      transaction: {
        _id: "txn1",
        razorpayOrderId: "order1",
        finalAmount: 100,
        status: "processing",
      },

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

    paymentService.creditBalanceWithAudit.mockResolvedValue({
      balance: 500,
    });

    Transaction.findOneAndUpdate.mockResolvedValue({
      status: "completed",
    });

    await paymentService.processSuccessfulPayment({
      transaction: {
        _id: "txn1",
        razorpayOrderId: "order1",
        finalAmount: 500,
        status: "processing",
      },

      paymentId: "gateway-payment",

      paymentMethod: "phonepe",

      session: {},
    });

    const update = Transaction.findOneAndUpdate.mock.calls[0][1];

    expect(update.$set.paymentMethod).toBe("phonepe");
  });
});
describe("creditBalanceWithAudit()", () => {
  let paymentService;
  let WalletService;

  beforeEach(() => {
    jest.resetModules();

    paymentService = require("../../src/services/paymentService");
    WalletService = require("../../src/services/walletService");

    jest.spyOn(WalletService, "credit");
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("should credit user wallet successfully", async () => {
    const transaction = {
      _id: "txn1",
      userId: "user1",
      vendorId: null,
      razorpayOrderId: "order1",
      razorpayPaymentId: "pay1",
      amount: 500,
      discount: 50,
      finalAmount: 450,
      currency: "INR",
    };

    WalletService.credit.mockResolvedValue({
      entity: {
        _id: "user1",
        balance: 1450,
      },
      ledger: {
        _id: "ledger1",
      },
    });

    const session = {};

    const entity = await paymentService.creditBalanceWithAudit(
      transaction,

      450,

      session,

      "payment_order1",

      "payment_order1",

      "api",

      {
        requestId: "req1",
        ipAddress: "127.0.0.1",
      },
    );

    expect(entity.balance).toBe(1450);

    expect(WalletService.credit).toHaveBeenCalledTimes(1);

    expect(WalletService.credit).toHaveBeenCalledWith(
      "user",

      "user1",

      450,

      "txn1",

      50,

      500,

      expect.objectContaining({
        idempotencyKey: "payment_order1",

        financialOperationId: "payment_order1",

        paymentId: "pay1",

        orderId: "order1",

        requestId: "req1",

        ipAddress: "127.0.0.1",
      }),

      session,
    );
  });

  test("should credit vendor wallet successfully", async () => {
    WalletService.credit.mockResolvedValue({
      entity: {
        _id: "vendor1",
        balance: 800,
      },
      ledger: {
        _id: "ledger1",
      },
    });

    await paymentService.creditBalanceWithAudit(
      {
        _id: "txn1",

        vendorId: "vendor1",

        razorpayOrderId: "order1",

        razorpayPaymentId: "pay1",

        amount: 300,

        discount: 0,

        finalAmount: 300,
      },

      300,

      {},

      "payment_order1",

      "payment_order1",
    );

    expect(WalletService.credit.mock.calls[0][0]).toBe("vendor");

    expect(WalletService.credit.mock.calls[0][1]).toBe("vendor1");
  });

  test("should throw ENTITY_NOT_FOUND", async () => {
    await expect(
      paymentService.creditBalanceWithAudit(
        {
          _id: "txn1",

          razorpayOrderId: "order1",
        },

        100,

        {},

        "payment_order1",

        "payment_order1",
      ),
    ).rejects.toMatchObject({
      code: "ENTITY_NOT_FOUND",
    });

    expect(WalletService.credit).not.toHaveBeenCalled();
  });

  test("should throw when WalletService returns undefined", async () => {
    WalletService.credit.mockResolvedValue(undefined);

    await expect(
      paymentService.creditBalanceWithAudit(
        {
          _id: "txn1",

          userId: "user1",

          razorpayOrderId: "order1",
        },

        100,

        {},

        "payment_order1",

        "payment_order1",
      ),
    ).rejects.toThrow("WalletService.credit returned undefined");
  });

  test("should throw when WalletService returns no entity", async () => {
    WalletService.credit.mockResolvedValue({
      ledger: {
        _id: "ledger1",
      },
    });

    await expect(
      paymentService.creditBalanceWithAudit(
        {
          _id: "txn1",

          userId: "user1",

          razorpayOrderId: "order1",
        },

        100,

        {},

        "payment_order1",

        "payment_order1",
      ),
    ).rejects.toThrow("WalletService.credit returned result without entity");
  });

  test("should propagate WalletService errors", async () => {
    const error = new Error("Duplicate financial operation");

    error.code = "FINANCIAL_OPERATION_EXISTS";

    WalletService.credit.mockRejectedValue(error);

    await expect(
      paymentService.creditBalanceWithAudit(
        {
          _id: "txn1",

          userId: "user1",

          razorpayOrderId: "order1",
        },

        100,

        {},

        "payment_order1",

        "payment_order1",
      ),
    ).rejects.toMatchObject({
      code: "FINANCIAL_OPERATION_EXISTS",
    });
  });
});
describe("creditBalanceWithAudit() - Metadata & Audit", () => {
  let paymentService;
  let WalletService;
  let crypto;

  beforeEach(() => {
    jest.resetModules();

    paymentService = require("../../src/services/paymentService");
    WalletService = require("../../src/services/walletService");
    crypto = require("crypto");

    jest.spyOn(WalletService, "credit");
    jest.spyOn(crypto, "randomUUID").mockReturnValue("generated-request-id");

    WalletService.credit.mockResolvedValue({
      entity: {
        _id: "user1",
        balance: 1500,
      },
      ledger: {
        _id: "ledger1",
      },
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("should generate requestId when metadata.requestId is absent", async () => {
    await paymentService.creditBalanceWithAudit(
      {
        _id: "txn1",
        userId: "user1",
        razorpayOrderId: "order1",
        razorpayPaymentId: "pay1",
        amount: 500,
        finalAmount: 450,
        discount: 50,
      },
      450,
      {},
      "payment_order1",
      "payment_order1",
    );

    const metadata = WalletService.credit.mock.calls[0][6];

    expect(metadata.requestId).toBe("generated-request-id");
  });

  test("should preserve provided requestId", async () => {
    await paymentService.creditBalanceWithAudit(
      {
        _id: "txn1",
        userId: "user1",
        razorpayOrderId: "order1",
        razorpayPaymentId: "pay1",
        amount: 500,
        finalAmount: 450,
        discount: 50,
      },
      450,
      {},
      "payment_order1",
      "payment_order1",
      undefined,
      {
        requestId: "req-123",
      },
    );

    const metadata = WalletService.credit.mock.calls[0][6];

    expect(metadata.requestId).toBe("req-123");
  });

  test("should use metadata ipAddress over transaction ip", async () => {
    await paymentService.creditBalanceWithAudit(
      {
        _id: "txn1",
        userId: "user1",
        razorpayOrderId: "order1",
        razorpayPaymentId: "pay1",
        amount: 500,
        finalAmount: 450,
        discount: 50,
        ipAddress: "10.0.0.1",
      },
      450,
      {},
      "payment_order1",
      "payment_order1",
      undefined,
      {
        ipAddress: "20.0.0.1",
      },
    );

    const metadata = WalletService.credit.mock.calls[0][6];

    expect(metadata.ipAddress).toBe("20.0.0.1");
  });

  test("should fallback to transaction ipAddress", async () => {
    await paymentService.creditBalanceWithAudit(
      {
        _id: "txn1",
        userId: "user1",
        razorpayOrderId: "order1",
        razorpayPaymentId: "pay1",
        amount: 500,
        finalAmount: 450,
        discount: 50,
        ipAddress: "192.168.1.100",
      },
      450,
      {},
      "payment_order1",
      "payment_order1",
    );

    const metadata = WalletService.credit.mock.calls[0][6];

    expect(metadata.ipAddress).toBe("192.168.1.100");
  });

  test("should set payment_verification source for API", async () => {
    const { PaymentSource } = require("../../src/constants/payment");

    await paymentService.creditBalanceWithAudit(
      {
        _id: "txn1",
        userId: "user1",
        razorpayOrderId: "order1",
        razorpayPaymentId: "pay1",
        amount: 500,
        finalAmount: 450,
      },
      450,
      {},
      "payment_order1",
      "payment_order1",
      PaymentSource.API,
    );

    const metadata = WalletService.credit.mock.calls[0][6];

    expect(metadata.source).toBe("payment_verification");
  });

  test("should set webhook source correctly", async () => {
    const { PaymentSource } = require("../../src/constants/payment");

    await paymentService.creditBalanceWithAudit(
      {
        _id: "txn1",
        userId: "user1",
        razorpayOrderId: "order1",
        razorpayPaymentId: "pay1",
        amount: 500,
        finalAmount: 450,
      },
      450,
      {},
      "payment_order1",
      "payment_order1",
      PaymentSource.WEBHOOK,
    );

    const metadata = WalletService.credit.mock.calls[0][6];

    expect(metadata.source).toBe("webhook");
  });

  test("should forward session unchanged", async () => {
    const session = {
      id: "mongo-session",
    };

    await paymentService.creditBalanceWithAudit(
      {
        _id: "txn1",
        userId: "user1",
        razorpayOrderId: "order1",
        razorpayPaymentId: "pay1",
        amount: 500,
        finalAmount: 450,
      },
      450,
      session,
      "payment_order1",
      "payment_order1",
    );

    expect(WalletService.credit.mock.calls[0][7]).toBe(session);
  });

  test("should include gateway and currency metadata", async () => {
    await paymentService.creditBalanceWithAudit(
      {
        _id: "txn1",
        userId: "user1",
        razorpayOrderId: "order1",
        razorpayPaymentId: "pay1",
        amount: 500,
        finalAmount: 450,
        currency: "USD",
      },
      450,
      {},
      "payment_order1",
      "payment_order1",
    );

    const metadata = WalletService.credit.mock.calls[0][6];

    expect(metadata.metadata.gateway).toBe("razorpay");

    expect(metadata.metadata.currency).toBe("USD");
  });
});
describe("verifyWithRazorpay()", () => {
  let paymentService;
  let razorpay;

  beforeEach(() => {
    jest.resetModules();

    paymentService = require("../../src/services/paymentService");

    razorpay = require("../../src/config/razorpay");

    jest.spyOn(razorpay.payments, "fetch");
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("should verify Razorpay payment successfully", async () => {
    razorpay.payments.fetch.mockResolvedValue({
      id: "pay1",

      order_id: "order1",

      status: "captured",

      captured: true,

      amount: 45000,

      currency: "INR",

      method: "upi",
    });

    const transaction = {
      _id: "txn1",

      razorpayOrderId: "order1",

      currency: "INR",
    };

    const payment = await paymentService.verifyWithRazorpay(transaction, "pay1");

    expect(payment.id).toBe("pay1");

    expect(razorpay.payments.fetch).toHaveBeenCalledWith("pay1");
  });

  test("should reject payment not captured (status)", async () => {
    razorpay.payments.fetch.mockResolvedValue({
      order_id: "order1",

      status: "authorized",

      captured: false,

      amount: 10000,

      currency: "INR",
    });

    await expect(
      paymentService.verifyWithRazorpay(
        {
          _id: "txn1",

          razorpayOrderId: "order1",

          currency: "INR",
        },

        "pay1",
      ),
    ).rejects.toMatchObject({
      code: "PAYMENT_NOT_CAPTURED",
    });
  });

  test("should reject order id mismatch", async () => {
    razorpay.payments.fetch.mockResolvedValue({
      order_id: "different-order",

      status: "captured",

      captured: true,

      amount: 10000,

      currency: "INR",
    });

    await expect(
      paymentService.verifyWithRazorpay(
        {
          _id: "txn1",

          razorpayOrderId: "order1",

          currency: "INR",
        },

        "pay1",
      ),
    ).rejects.toMatchObject({
      code: "ORDER_ID_MISMATCH",
    });
  });

  test("should reject currency mismatch", async () => {
    razorpay.payments.fetch.mockResolvedValue({
      order_id: "order1",

      status: "captured",

      captured: true,

      amount: 10000,

      currency: "USD",
    });

    await expect(
      paymentService.verifyWithRazorpay(
        {
          _id: "txn1",

          razorpayOrderId: "order1",

          currency: "INR",
        },

        "pay1",
      ),
    ).rejects.toMatchObject({
      code: "CURRENCY_MISMATCH",
    });
  });

  test("should reject captured flag false", async () => {
    razorpay.payments.fetch.mockResolvedValue({
      order_id: "order1",

      status: "captured",

      captured: false,

      amount: 10000,

      currency: "INR",
    });

    await expect(
      paymentService.verifyWithRazorpay(
        {
          _id: "txn1",

          razorpayOrderId: "order1",

          currency: "INR",
        },

        "pay1",
      ),
    ).rejects.toMatchObject({
      code: "PAYMENT_NOT_CAPTURED",
    });
  });

  test("should expose validationErrors array", async () => {
    razorpay.payments.fetch.mockResolvedValue({
      order_id: "wrong",

      status: "authorized",

      captured: false,

      amount: 10000,

      currency: "USD",
    });

    try {
      await paymentService.verifyWithRazorpay(
        {
          _id: "txn1",

          razorpayOrderId: "order1",

          currency: "INR",
        },

        "pay1",
      );

      throw new Error("Expected failure");
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
        {
          _id: "txn1",

          razorpayOrderId: "order1",
        },

        "pay1",
      ),
    ).rejects.toMatchObject({
      code: "ORDER_ID_MISMATCH",
    });
  });

  test("should wrap SDK errors", async () => {
    razorpay.payments.fetch.mockRejectedValue(new Error("Network timeout"));

    await expect(
      paymentService.verifyWithRazorpay(
        {
          _id: "txn1",

          razorpayOrderId: "order1",
        },

        "pay1",
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
        {
          _id: "txn1",

          razorpayOrderId: "order1",
        },

        "pay1",
      );
    } catch (err) {
      expect(err.code).toBe("RAZORPAY_API_ERROR");

      expect(err.originalError).toBe(sdkError);
    }
  });
});
describe("markTransactionFailed()", () => {
  let paymentService;
  let Transaction;
  let logger;

  beforeEach(() => {
    jest.resetModules();

    paymentService = require("../../src/services/paymentService");
    Transaction = require("../../models/transaction");
    logger = require("../../src/logger/logger");

    jest.spyOn(Transaction, "findOneAndUpdate");
    jest.spyOn(Transaction, "findOne");

    jest.spyOn(logger, "info").mockImplementation(() => {});
    jest.spyOn(logger, "warn").mockImplementation(() => {});
    jest.spyOn(logger, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("should mark processing transaction as failed", async () => {
    Transaction.findOneAndUpdate.mockResolvedValue({
      _id: "txn1",
      razorpayOrderId: "order1",
      status: "failed",
      userId: "user1",
      vendorId: null,
      errorCode: "AMOUNT_MISMATCH",
      failedAt: new Date(),
    });

    await paymentService.markTransactionFailed("order1", {
      code: "AMOUNT_MISMATCH",
      message: "Amount mismatch",
    });

    expect(Transaction.findOneAndUpdate).toHaveBeenCalledTimes(1);

    const filter = Transaction.findOneAndUpdate.mock.calls[0][0];

    expect(filter).toEqual({
      razorpayOrderId: "order1",
      status: "processing",
    });

    const update = Transaction.findOneAndUpdate.mock.calls[0][1];

    expect(update.$set.status).toBe("failed");

    expect(update.$set.errorCode).toBe("AMOUNT_MISMATCH");

    expect(update.$set.errorMessage).toBe("Amount mismatch");

    expect(update.$set.failedAt).toBeInstanceOf(Date);
  });

  test("should use default error values", async () => {
    Transaction.findOneAndUpdate.mockResolvedValue({
      _id: "txn1",
      status: "failed",
      failedAt: new Date(),
    });

    await paymentService.markTransactionFailed("order1", {});

    const update = Transaction.findOneAndUpdate.mock.calls[0][1];

    expect(update.$set.errorCode).toBe("VERIFICATION_ERROR");

    expect(update.$set.errorMessage).toBe("Payment verification failed");

    expect(update.$set.errorDescription).toBe("Payment verification failed");
  });

  test("should use error.description when provided", async () => {
    Transaction.findOneAndUpdate.mockResolvedValue({
      _id: "txn1",
      status: "failed",
    });

    await paymentService.markTransactionFailed("order1", {
      code: "SDK_ERROR",
      message: "Gateway failed",
      description: "Razorpay timeout",
    });

    const update = Transaction.findOneAndUpdate.mock.calls[0][1];

    expect(update.$set.errorDescription).toBe("Razorpay timeout");
  });

  test("should not overwrite completed transaction", async () => {
    Transaction.findOneAndUpdate.mockResolvedValue(null);

    Transaction.findOne.mockReturnValue({
      lean: () => ({
        _id: "txn1",
        status: "completed",
        userId: "user1",
      }),
    });

    await paymentService.markTransactionFailed("order1", {
      code: "AMOUNT_MISMATCH",
    });

    expect(Transaction.findOne).toHaveBeenCalledTimes(1);

    expect(logger.info).toHaveBeenCalled();
  });

  test("should warn when transaction does not exist", async () => {
    Transaction.findOneAndUpdate.mockResolvedValue(null);

    Transaction.findOne.mockReturnValue({
      lean: () => null,
    });

    await paymentService.markTransactionFailed("missing-order", {
      code: "ERROR",
    });

    expect(logger.warn).toHaveBeenCalled();
  });

  test("should swallow database update errors", async () => {
    Transaction.findOneAndUpdate.mockRejectedValue(new Error("Mongo unavailable"));

    await expect(
      paymentService.markTransactionFailed("order1", {
        code: "SDK_ERROR",
      }),
    ).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalled();
  });

  test("should not rethrow logger/update failures", async () => {
    Transaction.findOneAndUpdate.mockRejectedValue(new Error("Replica set unavailable"));

    await expect(
      paymentService.markTransactionFailed("order1", {
        code: "ERROR",
      }),
    ).resolves.toBeUndefined();
  });
});
describe("verifyPayment() - Idempotency & Concurrency", () => {
  let paymentService;

  beforeEach(() => {
    jest.resetModules();

    paymentService = require("../../src/services/paymentService");

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
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("should process payment only once during concurrent requests", async () => {
    const processingTxn = {
      _id: "txn1",
      razorpayOrderId: "order1",
      userId: "user1",
      status: "processing",
      finalAmount: 100,
    };

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
        transaction: {
          ...processingTxn,
          status: "completed",
        },
      });

    paymentService.processSuccessfulPayment.mockResolvedValue({
      updatedTransaction: {
        ...processingTxn,
        status: "completed",
      },
      creditedEntity: {
        balance: 200,
      },
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
        transaction: {
          _id: "txn1",
          razorpayOrderId: "order1",
          status: "processing",
          finalAmount: 100,
          userId: "user1",
        },
      })
      .mockResolvedValue({
        locked: false,
        alreadyCompleted: true,
        transaction: {
          _id: "txn1",
          razorpayOrderId: "order1",
          status: "completed",
          finalAmount: 100,
          userId: "user1",
        },
      });

    paymentService.processSuccessfulPayment.mockImplementation(async () => ({
      updatedTransaction: {
        status: "completed",
      },
      creditedEntity: {
        balance: 500,
      },
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
        transaction: {
          _id: "txn1",
          razorpayOrderId: "order1",
          finalAmount: 100,
          status: "processing",
          userId: "user1",
        },
      })
      .mockResolvedValue({
        locked: false,
        alreadyCompleted: true,
        transaction: {
          _id: "txn1",
          razorpayOrderId: "order1",
          status: "completed",
        },
      });

    paymentService.processSuccessfulPayment.mockResolvedValue({
      updatedTransaction: {
        status: "completed",
      },
      creditedEntity: {
        balance: 500,
      },
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
});
describe("verifyPayment() - Retry & Recovery", () => {
  let paymentService;

  beforeEach(() => {
    jest.resetModules();

    paymentService = require("../../src/services/paymentService");

    jest.spyOn(paymentService, "validatePaymentFields").mockImplementation(() => {});
    jest.spyOn(paymentService, "verifySignature").mockImplementation(() => {});
    jest.spyOn(paymentService, "validateOwnership").mockResolvedValue();
    jest.spyOn(paymentService, "verifyWithRazorpay");
    jest.spyOn(paymentService, "processSuccessfulPayment");
    jest.spyOn(paymentService, "markTransactionFailed").mockResolvedValue();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("should succeed when previous attempt failed before wallet credit", async () => {
    const txn = {
      _id: "txn1",
      razorpayOrderId: "order1",
      status: "processing",
      userId: "user1",
      finalAmount: 100,
    };

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
      updatedTransaction: {
        ...txn,
        status: "completed",
      },
      creditedEntity: {
        balance: 900,
      },
    });

    const result = await paymentService.verifyPayment({
      razorpay_order_id: "order1",
      razorpay_payment_id: "pay1",
      razorpay_signature: "sig",
      userId: "user1",
    });

    expect(result.success).toBe(true);
  });

  test("should mark transaction failed when Razorpay API times out", async () => {
    const txn = {
      _id: "txn1",
      razorpayOrderId: "order1",
      status: "processing",
      userId: "user1",
    };

    paymentService.acquireProcessingLock = jest.fn().mockResolvedValue({
      locked: true,
      alreadyCompleted: false,
      transaction: txn,
    });

    const error = new Error("Gateway timeout");
    error.code = "RAZORPAY_API_ERROR";

    paymentService.verifyWithRazorpay.mockRejectedValue(error);

    await expect(
      paymentService.verifyPayment({
        razorpay_order_id: "order1",
        razorpay_payment_id: "pay1",
        razorpay_signature: "sig",
        userId: "user1",
      }),
    ).rejects.toMatchObject({
      code: "RAZORPAY_API_ERROR",
    });

    expect(paymentService.markTransactionFailed).toHaveBeenCalledWith("order1", error);
  });

  test("should preserve original business error", async () => {
    const txn = {
      _id: "txn1",
      razorpayOrderId: "order1",
      status: "processing",
      userId: "user1",
    };

    paymentService.acquireProcessingLock = jest.fn().mockResolvedValue({
      locked: true,
      alreadyCompleted: false,
      transaction: txn,
    });

    const businessError = new Error("Currency mismatch");
    businessError.code = "CURRENCY_MISMATCH";

    paymentService.verifyWithRazorpay.mockRejectedValue(businessError);

    await expect(
      paymentService.verifyPayment({
        razorpay_order_id: "order1",
        razorpay_payment_id: "pay1",
        razorpay_signature: "sig",
        userId: "user1",
      }),
    ).rejects.toBe(businessError);
  });

  test("should call processSuccessfulPayment exactly once", async () => {
    const txn = {
      _id: "txn1",
      razorpayOrderId: "order1",
      status: "processing",
      userId: "user1",
      finalAmount: 100,
    };

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
      updatedTransaction: {
        ...txn,
        status: "completed",
      },
      creditedEntity: {
        balance: 1200,
      },
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
    const txn = {
      _id: "txn1",
      razorpayOrderId: "order1",
      status: "processing",
      userId: "user1",
      finalAmount: 100,
    };

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
      updatedTransaction: {
        ...txn,
        status: "completed",
      },
      creditedEntity: {
        balance: 1000,
      },
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
describe("PaymentService - Logging", () => {
  let paymentService;
  let logger;
  let razorpay;
  let WalletService;
  let Transaction;

  beforeEach(() => {
    jest.resetModules();

    paymentService = require("../../src/services/paymentService");
    logger = require("../../src/logger/logger");
    razorpay = require("../../src/config/razorpay");
    WalletService = require("../../src/services/walletService");
    Transaction = require("../../models/transaction");

    jest.spyOn(logger, "info").mockImplementation(() => {});
    jest.spyOn(logger, "warn").mockImplementation(() => {});
    jest.spyOn(logger, "error").mockImplementation(() => {});
    jest.spyOn(logger, "debug").mockImplementation(() => {});

    jest.spyOn(razorpay.payments, "fetch");
    jest.spyOn(WalletService, "credit");
    jest.spyOn(Transaction, "findOneAndUpdate");
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("should log successful Razorpay verification", async () => {
    razorpay.payments.fetch.mockResolvedValue({
      id: "pay1",
      order_id: "order1",
      status: "captured",
      captured: true,
      amount: 10000,
      currency: "INR",
      method: "upi",
    });

    await paymentService.verifyWithRazorpay(
      {
        _id: "txn1",
        razorpayOrderId: "order1",
        currency: "INR",
      },
      "pay1",
    );

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "RAZORPAY_VERIFICATION_SUCCESS",
        transactionId: "txn1",
        paymentId: "pay1",
      }),
      expect.any(String),
    );
  });

  test("should log failed Razorpay validation", async () => {
    razorpay.payments.fetch.mockResolvedValue({
      order_id: "wrong-order",
      status: "authorized",
      captured: false,
      currency: "USD",
      amount: 10000,
    });

    await expect(
      paymentService.verifyWithRazorpay(
        {
          _id: "txn1",
          razorpayOrderId: "order1",
          currency: "INR",
        },
        "pay1",
      ),
    ).rejects.toBeDefined();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "RAZORPAY_VERIFICATION_FAILED",
      }),
      expect.any(String),
    );
  });

  test("should log wallet credit success", async () => {
    WalletService.credit.mockResolvedValue({
      entity: {
        _id: "user1",
        balance: 500,
      },
      ledger: {
        _id: "ledger1",
      },
    });

    await paymentService.creditBalanceWithAudit(
      {
        _id: "txn1",
        userId: "user1",
        razorpayOrderId: "order1",
        razorpayPaymentId: "pay1",
        amount: 100,
        finalAmount: 100,
      },
      100,
      {},
      "payment_order1",
      "payment_order1",
    );

    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "WALLET_CREDITED_IN_PAYMENT",
      }),
      expect.any(String),
    );
  });

  test("should log wallet credit failure", async () => {
    WalletService.credit.mockRejectedValue(new Error("Ledger failure"));

    await expect(
      paymentService.creditBalanceWithAudit(
        {
          _id: "txn1",
          userId: "user1",
          razorpayOrderId: "order1",
        },
        100,
        {},
        "payment_order1",
        "payment_order1",
      ),
    ).rejects.toThrow();

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "WALLET_CREDIT_FAILED_IN_PAYMENT",
      }),
      expect.any(String),
    );
  });

  test("should log transaction marked failed", async () => {
    Transaction.findOneAndUpdate.mockResolvedValue({
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
    Transaction.findOneAndUpdate.mockRejectedValue(new Error("Mongo unavailable"));

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
