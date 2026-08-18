"use strict";

require("../setupEnv");

process.env.RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || "rzp_test_key";
process.env.RAZORPAY_SECRET = process.env.RAZORPAY_SECRET || "rzp_test_secret";
process.env.RAZORPAY_KEY_SECRET = process.env.RAZORPAY_SECRET;
process.env.RAZORPAY_WEBHOOK_SECRET =
  process.env.RAZORPAY_WEBHOOK_SECRET || "rzp_test_webhook_secret";

const crypto = require("crypto");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

jest.mock("../../controller/razorpay", () => ({
  orders: {
    create: jest.fn(),
    fetchPayments: jest.fn(),
  },
  payments: {
    fetch: jest.fn(),
  },
}));

jest.mock("../../src/logger/logger", () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
  fatal: jest.fn(),
}));

jest.mock("../../src/services/NotificationService", () => ({
  sendSMS: jest.fn(),
}));

jest.mock("../../src/services/WalletService", () => ({
  credit: jest.fn(),
  debit: jest.fn(),
}));

const razorpay = require("../../controller/razorpay");
const NotificationService = require("../../src/services/NotificationService");
const WalletService = require("../../src/services/WalletService");
const paymentService = require("../../src/services/paymentService");
const paymentController = require("../../controller/payment");

const User = require("../../models/user");
const Vendor = require("../../models/vendor");
const Transaction = require("../../models/transaction");
const WebhookProcess = require("../../models/webhookProcess");

let replSet;
let uniqueCounter = 0;

function unique(prefix) {
  uniqueCounter += 1;
  return `${prefix}_${Date.now()}_${uniqueCounter}_${crypto.randomBytes(4).toString("hex")}`;
}

async function createUser(overrides = {}) {
  return User.create({
    name: "Webhook User",
    phoneNo: Number(`7${String(uniqueCounter).padStart(9, "0")}`),
    email: `${unique("webhook_user")}@example.test`,
    password: "Password@123",
    verifyPhoneNo: true,
    verifyEmail: true,
    agreedToTnCnP: true,
    balance: 0,
    transactionCount: 0,
    totalDiscount: 0,
    totalOriginalAmount: 0,
    status: "active",
    ...overrides,
  });
}

async function createTransaction({
  userId = null,
  vendorId = null,
  status = "initiated",
  amount = 100,
  finalAmount = 90,
  discount = 10,
  discountPercent = 10,
  orderId = unique("order"),
  paymentId = unique("pay"),
  overrides = {},
} = {}) {
  const data = {
    userId: userId || undefined,
    vendorId: vendorId || undefined,
    amount,
    finalAmount,
    discount,
    discountPercent,
    currency: "INR",
    razorpayOrderId: orderId,
    gatewayOrderId: orderId,
    paymentGateway: "razorpay",
    status,
    paymentStatus: status === "failed" ? "failed" : status === "completed" ? "success" : "pending",
    category: vendorId ? "vendor" : "user",
    initiatedAt: new Date(),
    requestId: unique("request"),
    ipAddress: "127.0.0.1",
    userAgent: "jest",
    metadata: {
      orderId,
      requestedAmount: amount,
      currency: "INR",
      gateway: "razorpay",
    },
    ...overrides,
  };

  if (["processing", "completed", "failed", "refunded"].includes(status)) {
    data.razorpayPaymentId = paymentId;
    data.gatewayPaymentId = paymentId;
  }

  if (status === "completed") data.completedAt = new Date();
  if (status === "failed") data.failedAt = new Date();
  if (status === "processing") data.processingStartedAt = new Date();

  const transaction = await Transaction.create(data);
  return { transaction, orderId, paymentId };
}

function capturedWebhook({ orderId, paymentId, webhookId = unique("wh"), amount = 9000 }) {
  return {
    webhook_id: webhookId,
    event: "payment.captured",
    created_at: Math.floor(Date.now() / 1000),
    payload: {
      payment: {
        entity: {
          id: paymentId,
          order_id: orderId,
          amount,
          currency: "INR",
          status: "captured",
          captured: true,
          method: "upi",
        },
      },
    },
  };
}

function failedWebhook({
  orderId,
  paymentId = unique("pay_failed"),
  webhookId = unique("wh_failed"),
  errorCode = "BAD_REQUEST_ERROR",
}) {
  return {
    webhook_id: webhookId,
    event: "payment.failed",
    created_at: Math.floor(Date.now() / 1000),
    payload: {
      payment: {
        entity: {
          id: paymentId,
          order_id: orderId,
          amount: 9000,
          currency: "INR",
          status: "failed",
          captured: false,
          error_code: errorCode,
          error_description: "Payment was declined by the issuer",
        },
      },
    },
  };
}

function signedRawBody(payload) {
  const rawBody = Buffer.from(JSON.stringify(payload));
  const signature = crypto
    .createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest("hex");

  return { rawBody, signature };
}

function createMockResponse() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
}

function installWalletCreditMock() {
  WalletService.credit.mockImplementation(
    async (
      entityType,
      entityId,
      amount,
      transactionId,
      totalDiscount,
      originalAmount,
      metadata,
      session,
    ) => {
      const Model = entityType === "vendor" ? Vendor : User;
      const options = { new: true };

      if (session) options.session = session;

      const entity = await Model.findByIdAndUpdate(
        entityId,
        {
          $inc: {
            balance: amount,
            totalDiscount: totalDiscount || 0,
            transactionCount: 1,
            totalOriginalAmount: originalAmount || 0,
          },
        },
        options,
      );

      if (!entity) {
        const error = new Error(`${entityType} not found`);
        error.code = "ENTITY_NOT_FOUND";
        throw error;
      }

      return {
        entity,
        ledger: {
          _id: new mongoose.Types.ObjectId(),
          transactionId,
          idempotencyKey: metadata.idempotencyKey,
        },
      };
    },
  );
}

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({
    replSet: {
      count: 1,
      storageEngine: "wiredTiger",
    },
  });

  await mongoose.connect(replSet.getUri(), {
    dbName: "payment_webhook_tests",
  });

  await Promise.all([User.init(), Vendor.init(), Transaction.init(), WebhookProcess.init()]);
});

afterAll(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.connection.close();
  await replSet.stop();
});

beforeEach(() => {
  jest.clearAllMocks();
  WalletService.credit.mockReset();
  WalletService.debit.mockReset();
  NotificationService.sendSMS.mockReset();
  NotificationService.sendSMS.mockResolvedValue({ _id: new mongoose.Types.ObjectId() });
  installWalletCreditMock();
});

afterEach(async () => {
  jest.restoreAllMocks();
  await Promise.all([
    User.deleteMany({}),
    Vendor.deleteMany({}),
    Transaction.deleteMany({}),
    WebhookProcess.deleteMany({}),
  ]);
});

describe("payment webhook controller signature handling", () => {
  test("rejects requests that did not pass through express.raw", async () => {
    const req = {
      body: { event: "payment.captured" },
      headers: {
        "content-type": "application/json",
        "x-razorpay-signature": "anything",
      },
      ip: "127.0.0.1",
    };
    const res = createMockResponse();

    await paymentController.webhook_handler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        message: "Webhook body parsing failed",
      }),
    );
  });

  test("rejects missing webhook signatures", async () => {
    const { rawBody } = signedRawBody({ event: "payment.captured" });
    const req = {
      body: rawBody,
      headers: {
        "content-type": "application/json",
      },
      ip: "127.0.0.1",
    };
    const res = createMockResponse();

    await paymentController.webhook_handler(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        message: "Unauthorized",
      }),
    );
  });

  test("rejects invalid webhook signatures before parsing or processing", async () => {
    const req = {
      body: Buffer.from(JSON.stringify({ event: "payment.captured" })),
      headers: {
        "content-type": "application/json",
        "x-razorpay-signature": "invalid",
      },
      ip: "127.0.0.1",
    };
    const res = createMockResponse();

    await paymentController.webhook_handler(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        message: "Invalid signature",
      }),
    );
    expect(WalletService.credit).not.toHaveBeenCalled();
  });

  test("rejects invalid JSON only after HMAC verification succeeds", async () => {
    const rawBody = Buffer.from("{not-json");
    const signature = crypto
      .createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET)
      .update(rawBody)
      .digest("hex");

    const req = {
      body: rawBody,
      headers: {
        "content-type": "application/json",
        "x-razorpay-signature": signature,
      },
      ip: "127.0.0.1",
    };
    const res = createMockResponse();

    await paymentController.webhook_handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        message: "Invalid JSON payload",
      }),
    );
  });

  test("accepts a signed payment.captured webhook and completes the transaction", async () => {
    const user = await createUser();
    const { orderId, paymentId } = await createTransaction({ userId: user._id });
    const payload = capturedWebhook({ orderId, paymentId });
    const { rawBody, signature } = signedRawBody(payload);
    const req = {
      body: rawBody,
      headers: {
        "content-type": "application/json",
        "x-razorpay-signature": signature,
        "x-razorpay-webhook-id": payload.webhook_id,
      },
      ip: "127.0.0.1",
    };
    const res = createMockResponse();

    await paymentController.webhook_handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        processed: true,
        idempotent: false,
      }),
    );

    const stored = await Transaction.findOne({ razorpayOrderId: orderId }).lean();
    const updatedUser = await User.findById(user._id).lean();
    const webhookRecord = await WebhookProcess.findOne({ webhookId: payload.webhook_id }).lean();

    expect(stored).toMatchObject({
      status: "completed",
      razorpayPaymentId: paymentId,
      webhookProcessed: true,
    });
    expect(updatedUser.balance).toBe(90);
    expect(webhookRecord.status).toBe("completed");
    expect(razorpay.payments.fetch).not.toHaveBeenCalled();
    expect(WalletService.credit).toHaveBeenCalledTimes(1);
    expect(NotificationService.sendSMS).toHaveBeenCalledTimes(1);
  });
});

describe("PaymentService.processWebhook", () => {
  test("deduplicates a repeated completed webhook event", async () => {
    const user = await createUser();
    const { orderId, paymentId } = await createTransaction({ userId: user._id });
    const payload = capturedWebhook({ orderId, paymentId, webhookId: unique("wh_duplicate") });

    const first = await paymentService.processWebhook(payload);
    const second = await paymentService.processWebhook(payload);

    expect(first).toMatchObject({ success: true, processed: true, idempotent: false });
    expect(second).toMatchObject({ success: true, processed: false, idempotent: true });

    const updatedUser = await User.findById(user._id).lean();
    const webhookRecords = await WebhookProcess.find({ webhookId: payload.webhook_id }).lean();

    expect(updatedUser).toMatchObject({
      balance: 90,
      transactionCount: 1,
    });
    expect(webhookRecords).toHaveLength(1);
    expect(webhookRecords[0].status).toBe("completed");
    expect(WalletService.credit).toHaveBeenCalledTimes(1);
    expect(NotificationService.sendSMS).toHaveBeenCalledTimes(1);
  });

  test("returns a retryable error while another worker owns the webhook lease", async () => {
    const user = await createUser();
    const { orderId, paymentId } = await createTransaction({ userId: user._id });
    const payload = capturedWebhook({ orderId, paymentId, webhookId: unique("wh_active") });

    await WebhookProcess.create({
      webhookId: payload.webhook_id,
      event: payload.event,
      orderId,
      paymentId,
      status: "processing",
      claimedAt: new Date(),
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });

    await expect(paymentService.processWebhook(payload)).rejects.toMatchObject({
      code: "WEBHOOK_CONCURRENT_PROCESSING",
      retryable: true,
    });

    const stored = await Transaction.findOne({ razorpayOrderId: orderId }).lean();
    expect(stored.status).toBe("initiated");
    expect(WalletService.credit).not.toHaveBeenCalled();
  });

  test("reclaims an expired processing lease and completes the webhook", async () => {
    const user = await createUser();
    const { orderId, paymentId } = await createTransaction({ userId: user._id });
    const payload = capturedWebhook({ orderId, paymentId, webhookId: unique("wh_expired") });

    await WebhookProcess.create({
      webhookId: payload.webhook_id,
      event: payload.event,
      orderId,
      paymentId,
      status: "processing",
      claimedAt: new Date(Date.now() - 600_000),
      leaseExpiresAt: new Date(Date.now() - 60_000),
    });

    const result = await paymentService.processWebhook(payload);
    const record = await WebhookProcess.findOne({ webhookId: payload.webhook_id }).lean();
    const updatedUser = await User.findById(user._id).lean();

    expect(result).toMatchObject({ success: true, processed: true, idempotent: false });
    expect(record.status).toBe("completed");
    expect(updatedUser.balance).toBe(90);
    expect(WalletService.credit).toHaveBeenCalledTimes(1);
  });

  test("retries a previously failed webhook and clears the failed state", async () => {
    const user = await createUser();
    const { orderId, paymentId } = await createTransaction({ userId: user._id });
    const payload = capturedWebhook({ orderId, paymentId, webhookId: unique("wh_retry") });

    await WebhookProcess.create({
      webhookId: payload.webhook_id,
      event: payload.event,
      orderId,
      paymentId,
      status: "failed",
      failedAt: new Date(),
      error: {
        message: "first attempt failed",
        code: "PROCESSING_ERROR",
      },
    });

    const result = await paymentService.processWebhook(payload);
    const record = await WebhookProcess.findOne({ webhookId: payload.webhook_id }).lean();

    expect(result).toMatchObject({ success: true, processed: true, idempotent: false });
    expect(record.status).toBe("completed");
    expect(record.error).toEqual({});
    expect(WalletService.credit).toHaveBeenCalledTimes(1);
  });

  test("records payment.failed webhook state without crediting the wallet", async () => {
    const user = await createUser();
    const { orderId } = await createTransaction({ userId: user._id });
    const payload = failedWebhook({ orderId });

    const result = await paymentService.processWebhook(payload);

    const stored = await Transaction.findOne({ razorpayOrderId: orderId }).lean();
    const userAfter = await User.findById(user._id).lean();
    const record = await WebhookProcess.findOne({ webhookId: payload.webhook_id }).lean();

    expect(result).toMatchObject({ success: true, processed: true, idempotent: false });
    expect(stored).toMatchObject({
      status: "failed",
      errorCode: "BAD_REQUEST_ERROR",
      webhookProcessed: true,
    });
    expect(userAfter.balance).toBe(0);
    expect(record.status).toBe("completed");
    expect(WalletService.credit).not.toHaveBeenCalled();
    expect(NotificationService.sendSMS).not.toHaveBeenCalled();
  });

  test("ignores unsupported webhook events without creating a process record", async () => {
    const result = await paymentService.processWebhook({
      webhook_id: unique("wh_ignored"),
      event: "subscription.charged",
      payload: {},
    });

    expect(result).toMatchObject({
      success: true,
      processed: false,
      idempotent: true,
      message: "Event ignored",
    });
    expect(await WebhookProcess.countDocuments()).toBe(0);
  });

  test("acknowledges payment events that are missing all identifiers", async () => {
    const result = await paymentService.processWebhook({
      webhook_id: unique("wh_missing_ids"),
      event: "payment.captured",
      payload: {
        payment: {
          entity: {
            amount: 9000,
          },
        },
      },
    });

    expect(result).toMatchObject({
      success: true,
      processed: false,
      idempotent: true,
      message: "Missing identifiers - cannot process",
    });
    expect(WalletService.credit).not.toHaveBeenCalled();
  });
});
