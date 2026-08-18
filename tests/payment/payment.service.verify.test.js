"use strict";

const crypto = require("crypto");
const mongoose = require("mongoose");

const paymentService = require("../../src/services/PaymentService");

describe("PaymentService.verifyPayment()", () => {
  let session;

  beforeEach(() => {
    session = {
      withTransaction: jest.fn(async (cb) => cb()),
      endSession: jest.fn(),
    };

    jest.spyOn(mongoose, "startSession").mockResolvedValue(session);

    jest.restoreAllMocks();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe("Input Validation", () => {
    test("should reject when order id is missing", async () => {
      await expect(
        paymentService.verifyPayment({
          razorpay_payment_id: "pay_123",
          razorpay_signature: "signature",
          userId: new mongoose.Types.ObjectId(),
        }),
      ).rejects.toMatchObject({
        code: "MISSING_PAYMENT_FIELDS",
      });
    });

    test("should reject when payment id is missing", async () => {
      await expect(
        paymentService.verifyPayment({
          razorpay_order_id: "order_123",
          razorpay_signature: "signature",
          userId: new mongoose.Types.ObjectId(),
        }),
      ).rejects.toMatchObject({
        code: "MISSING_PAYMENT_FIELDS",
      });
    });

    test("should reject when signature is missing", async () => {
      await expect(
        paymentService.verifyPayment({
          razorpay_order_id: "order_123",
          razorpay_payment_id: "pay_123",
          userId: new mongoose.Types.ObjectId(),
        }),
      ).rejects.toMatchObject({
        code: "MISSING_PAYMENT_FIELDS",
      });
    });

    test("should call validatePaymentFields()", async () => {
      jest.spyOn(paymentService, "validatePaymentFields").mockImplementation(() => {});

      jest.spyOn(paymentService, "verifySignature").mockImplementation(() => {
        throw Object.assign(new Error("Stop"), {
          code: "STOP",
        });
      });

      await expect(
        paymentService.verifyPayment({
          razorpay_order_id: "order_123",
          razorpay_payment_id: "pay_123",
          razorpay_signature: "sig",
        }),
      ).rejects.toThrow();

      expect(paymentService.validatePaymentFields).toHaveBeenCalledWith(
        "order_123",
        "pay_123",
        "sig",
      );
    });

    test("should call verifySignature()", async () => {
      jest.spyOn(paymentService, "validatePaymentFields").mockImplementation(() => {});

      const signatureSpy = jest.spyOn(paymentService, "verifySignature").mockImplementation(() => {
        throw Object.assign(new Error("Stop"), {
          code: "STOP",
        });
      });

      await expect(
        paymentService.verifyPayment({
          razorpay_order_id: "order_123",
          razorpay_payment_id: "pay_123",
          razorpay_signature: "sig",
        }),
      ).rejects.toThrow();

      expect(signatureSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("Lock Acquisition", () => {
    test("should acquire processing lock", async () => {
      jest.spyOn(paymentService, "validatePaymentFields").mockImplementation(() => {});

      jest.spyOn(paymentService, "verifySignature").mockImplementation(() => {});

      const acquireSpy = jest.spyOn(paymentService, "acquireProcessingLock").mockRejectedValue(
        Object.assign(new Error("Stop"), {
          code: "STOP",
        }),
      );

      await expect(
        paymentService.verifyPayment({
          razorpay_order_id: "order_123",
          razorpay_payment_id: "pay_123",
          razorpay_signature: "sig",
        }),
      ).rejects.toThrow();

      expect(acquireSpy).toHaveBeenCalledWith("order_123", "pay_123", "sig", session);
    });

    test("should propagate lock acquisition error", async () => {
      jest.spyOn(paymentService, "validatePaymentFields").mockImplementation(() => {});

      jest.spyOn(paymentService, "verifySignature").mockImplementation(() => {});

      jest.spyOn(paymentService, "acquireProcessingLock").mockRejectedValue(
        Object.assign(new Error("Lock Failed"), {
          code: "LOCK_ACQUISITION_FAILED",
        }),
      );

      await expect(
        paymentService.verifyPayment({
          razorpay_order_id: "order_123",
          razorpay_payment_id: "pay_123",
          razorpay_signature: "sig",
        }),
      ).rejects.toMatchObject({
        code: "LOCK_ACQUISITION_FAILED",
      });
    });

    test("should always end mongoose session", async () => {
      jest.spyOn(paymentService, "validatePaymentFields").mockImplementation(() => {});

      jest.spyOn(paymentService, "verifySignature").mockImplementation(() => {});

      jest.spyOn(paymentService, "acquireProcessingLock").mockRejectedValue(
        Object.assign(new Error("Lock Failed"), {
          code: "LOCK_ACQUISITION_FAILED",
        }),
      );

      await expect(
        paymentService.verifyPayment({
          razorpay_order_id: "order_123",
          razorpay_payment_id: "pay_123",
          razorpay_signature: "sig",
        }),
      ).rejects.toThrow();

      expect(session.endSession).toHaveBeenCalled();
    });
  });
});
describe("Successful Verification Flow", () => {
  test("should validate ownership before gateway verification", async () => {
    const transaction = {
      _id: new mongoose.Types.ObjectId(),
      userId: new mongoose.Types.ObjectId(),
      vendorId: null,
      category: "user",
      amount: 100,
      finalAmount: 90,
      razorpayOrderId: "order_123",
    };

    jest.spyOn(paymentService, "validatePaymentFields").mockImplementation(() => {});

    jest.spyOn(paymentService, "verifySignature").mockImplementation(() => {});

    jest.spyOn(paymentService, "acquireProcessingLock").mockResolvedValue({
      transaction,
      locked: true,
      alreadyCompleted: false,
    });

    const ownershipSpy = jest.spyOn(paymentService, "validateOwnership").mockResolvedValue();

    jest.spyOn(paymentService, "verifyWithRazorpay").mockRejectedValue(
      Object.assign(new Error("STOP"), {
        code: "STOP",
      }),
    );

    await expect(
      paymentService.verifyPayment({
        razorpay_order_id: "order_123",
        razorpay_payment_id: "pay_123",
        razorpay_signature: "sig",
        userId: transaction.userId,
      }),
    ).rejects.toThrow();

    expect(ownershipSpy).toHaveBeenCalledWith(transaction, transaction.userId, undefined);
  });

  test("should verify payment with Razorpay", async () => {
    const transaction = {
      _id: new mongoose.Types.ObjectId(),
      userId: new mongoose.Types.ObjectId(),
      vendorId: null,
      category: "user",
      amount: 100,
      finalAmount: 90,
      razorpayOrderId: "order_123",
    };

    jest.spyOn(paymentService, "validatePaymentFields").mockImplementation(() => {});
    jest.spyOn(paymentService, "verifySignature").mockImplementation(() => {});
    jest.spyOn(paymentService, "validateOwnership").mockResolvedValue();

    jest.spyOn(paymentService, "acquireProcessingLock").mockResolvedValue({
      transaction,
      locked: true,
      alreadyCompleted: false,
    });

    const razorpaySpy = jest.spyOn(paymentService, "verifyWithRazorpay").mockRejectedValue(
      Object.assign(new Error("STOP"), {
        code: "STOP",
      }),
    );

    await expect(
      paymentService.verifyPayment({
        razorpay_order_id: "order_123",
        razorpay_payment_id: "pay_123",
        razorpay_signature: "sig",
        userId: transaction.userId,
      }),
    ).rejects.toThrow();

    expect(razorpaySpy).toHaveBeenCalledWith(transaction, "pay_123");
  });

  test("should process successful payment", async () => {
    const transaction = {
      _id: new mongoose.Types.ObjectId(),
      userId: new mongoose.Types.ObjectId(),
      vendorId: null,
      category: "user",
      amount: 100,
      finalAmount: 90,
      razorpayOrderId: "order_123",
    };

    const razorpayPayment = {
      id: "pay_123",
      amount: 9000,
      currency: "INR",
      status: "captured",
      captured: true,
      order_id: "order_123",
    };

    const updatedTransaction = {
      ...transaction,
      razorpayPaymentId: "pay_123",
      status: "completed",
    };

    const creditedEntity = {
      balance: 900,
      totalDiscount: 10,
      totalOriginalAmount: 100,
      transactionCount: 4,
    };

    jest.spyOn(paymentService, "validatePaymentFields").mockImplementation(() => {});
    jest.spyOn(paymentService, "verifySignature").mockImplementation(() => {});
    jest.spyOn(paymentService, "validateOwnership").mockResolvedValue();

    jest.spyOn(paymentService, "acquireProcessingLock").mockResolvedValue({
      transaction,
      locked: true,
      alreadyCompleted: false,
    });

    jest.spyOn(paymentService, "verifyWithRazorpay").mockResolvedValue(razorpayPayment);

    const processSpy = jest.spyOn(paymentService, "processSuccessfulPayment").mockResolvedValue({
      updatedTransaction,
      creditedEntity,
    });

    jest.spyOn(paymentService, "sendSuccessNotification").mockResolvedValue();

    const result = await paymentService.verifyPayment({
      razorpay_order_id: "order_123",
      razorpay_payment_id: "pay_123",
      razorpay_signature: "sig",
      userId: transaction.userId,
    });

    expect(processSpy).toHaveBeenCalled();

    expect(result.success).toBe(true);
    expect(result.payment_id).toBe("pay_123");
    expect(result.order_id).toBe("order_123");
    expect(result.balance).toBe(900);
    expect(result.transaction).toEqual(updatedTransaction);
  });

  test("should send notification after successful payment", async () => {
    const transaction = {
      _id: new mongoose.Types.ObjectId(),
      userId: new mongoose.Types.ObjectId(),
      category: "user",
      finalAmount: 90,
      razorpayOrderId: "order_123",
    };

    const updatedTransaction = {
      ...transaction,
      razorpayPaymentId: "pay_123",
    };

    const creditedEntity = {
      balance: 500,
    };

    jest.spyOn(paymentService, "validatePaymentFields").mockImplementation(() => {});
    jest.spyOn(paymentService, "verifySignature").mockImplementation(() => {});
    jest.spyOn(paymentService, "validateOwnership").mockResolvedValue();

    jest.spyOn(paymentService, "acquireProcessingLock").mockResolvedValue({
      transaction,
      locked: true,
      alreadyCompleted: false,
    });

    jest.spyOn(paymentService, "verifyWithRazorpay").mockResolvedValue({
      amount: 9000,
      status: "captured",
      captured: true,
      currency: "INR",
      order_id: "order_123",
    });

    jest.spyOn(paymentService, "processSuccessfulPayment").mockResolvedValue({
      updatedTransaction,
      creditedEntity,
    });

    const notificationSpy = jest
      .spyOn(paymentService, "sendSuccessNotification")
      .mockResolvedValue();

    await paymentService.verifyPayment({
      razorpay_order_id: "order_123",
      razorpay_payment_id: "pay_123",
      razorpay_signature: "sig",
      userId: transaction.userId,
    });

    expect(notificationSpy).toHaveBeenCalledWith(
      creditedEntity,
      updatedTransaction.finalAmount,
      updatedTransaction,
      expect.any(String),
    );
  });
});
describe("Idempotency", () => {
  test("should return idempotent response when payment already completed", async () => {
    const transaction = {
      _id: new mongoose.Types.ObjectId(),
      userId: new mongoose.Types.ObjectId(),
      razorpayOrderId: "order_123",
      razorpayPaymentId: "pay_123",
      status: "completed",
    };

    const entity = {
      balance: 1200,
      totalDiscount: 15,
      totalOriginalAmount: 150,
      transactionCount: 7,
    };

    jest.spyOn(paymentService, "validatePaymentFields").mockImplementation(() => {});
    jest.spyOn(paymentService, "verifySignature").mockImplementation(() => {});

    jest.spyOn(paymentService, "acquireProcessingLock").mockResolvedValue({
      transaction,
      locked: false,
      alreadyCompleted: true,
    });

    const entitySpy = jest.spyOn(paymentService, "getEntity").mockResolvedValue(entity);

    const result = await paymentService.verifyPayment({
      razorpay_order_id: "order_123",
      razorpay_payment_id: "pay_123",
      razorpay_signature: "sig",
      userId: transaction.userId,
    });

    expect(entitySpy).toHaveBeenCalledWith(transaction);

    expect(result.success).toBe(true);
    expect(result.idempotent).toBe(true);
    expect(result.balance).toBe(1200);
    expect(result.transaction).toEqual(transaction);
    expect(result.message).toBe("Payment already completed");
  });

  test("should return zero balance when entity is null", async () => {
    const transaction = {
      _id: new mongoose.Types.ObjectId(),
      userId: new mongoose.Types.ObjectId(),
      razorpayOrderId: "order_123",
      razorpayPaymentId: "pay_123",
    };

    jest.spyOn(paymentService, "validatePaymentFields").mockImplementation(() => {});
    jest.spyOn(paymentService, "verifySignature").mockImplementation(() => {});

    jest.spyOn(paymentService, "acquireProcessingLock").mockResolvedValue({
      transaction,
      locked: false,
      alreadyCompleted: true,
    });

    jest.spyOn(paymentService, "getEntity").mockResolvedValue(null);

    const result = await paymentService.verifyPayment({
      razorpay_order_id: "order_123",
      razorpay_payment_id: "pay_123",
      razorpay_signature: "sig",
    });

    expect(result.balance).toBe(0);
    expect(result.idempotent).toBe(true);
  });
});

describe("Failure Handling", () => {
  test("should call markTransactionFailed for generic errors", async () => {
    jest.spyOn(paymentService, "validatePaymentFields").mockImplementation(() => {});
    jest.spyOn(paymentService, "verifySignature").mockImplementation(() => {});

    const error = Object.assign(new Error("Gateway Failure"), {
      code: "GATEWAY_FAILURE",
    });

    jest.spyOn(paymentService, "acquireProcessingLock").mockRejectedValue(error);

    const markSpy = jest.spyOn(paymentService, "markTransactionFailed").mockResolvedValue();

    await expect(
      paymentService.verifyPayment({
        razorpay_order_id: "order_123",
        razorpay_payment_id: "pay_123",
        razorpay_signature: "sig",
      }),
    ).rejects.toThrow("Gateway Failure");

    expect(markSpy).toHaveBeenCalledWith("order_123", error);
  });

  test("should NOT mark failed when transaction already completed", async () => {
    jest.spyOn(paymentService, "validatePaymentFields").mockImplementation(() => {});
    jest.spyOn(paymentService, "verifySignature").mockImplementation(() => {});

    const error = Object.assign(new Error("Already Completed"), {
      code: "PAYMENT_ALREADY_COMPLETED",
    });

    jest.spyOn(paymentService, "acquireProcessingLock").mockRejectedValue(error);

    const markSpy = jest.spyOn(paymentService, "markTransactionFailed").mockResolvedValue();

    await expect(
      paymentService.verifyPayment({
        razorpay_order_id: "order_123",
        razorpay_payment_id: "pay_123",
        razorpay_signature: "sig",
      }),
    ).rejects.toThrow();

    expect(markSpy).not.toHaveBeenCalled();
  });

  test("should NOT mark failed when payment already processing", async () => {
    jest.spyOn(paymentService, "validatePaymentFields").mockImplementation(() => {});
    jest.spyOn(paymentService, "verifySignature").mockImplementation(() => {});

    const error = Object.assign(new Error("Processing"), {
      code: "PAYMENT_ALREADY_PROCESSING",
    });

    jest.spyOn(paymentService, "acquireProcessingLock").mockRejectedValue(error);

    const markSpy = jest.spyOn(paymentService, "markTransactionFailed").mockResolvedValue();

    await expect(
      paymentService.verifyPayment({
        razorpay_order_id: "order_123",
        razorpay_payment_id: "pay_123",
        razorpay_signature: "sig",
      }),
    ).rejects.toThrow();

    expect(markSpy).not.toHaveBeenCalled();
  });

  test("should assign VERIFICATION_FAILED when error has no code", async () => {
    jest.spyOn(paymentService, "validatePaymentFields").mockImplementation(() => {});
    jest.spyOn(paymentService, "verifySignature").mockImplementation(() => {});

    const error = new Error("Unknown Error");

    jest.spyOn(paymentService, "acquireProcessingLock").mockRejectedValue(error);

    jest.spyOn(paymentService, "markTransactionFailed").mockResolvedValue();

    await expect(
      paymentService.verifyPayment({
        razorpay_order_id: "order_123",
        razorpay_payment_id: "pay_123",
        razorpay_signature: "sig",
      }),
    ).rejects.toMatchObject({
      code: "VERIFICATION_FAILED",
    });
  });
});
