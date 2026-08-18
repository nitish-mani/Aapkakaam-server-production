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

function signPayment(orderId, paymentId) {
  return crypto
    .createHmac("sha256", process.env.RAZORPAY_SECRET)
    .update(`${orderId}|${paymentId}`)
    .digest("hex");
}

function verificationPayload({ orderId, paymentId, userId = null, vendorId = null }) {
  const payload = {
    razorpay_order_id: orderId,
    razorpay_payment_id: paymentId,
    razorpay_signature: signPayment(orderId, paymentId),
  };

  if (userId) payload.userId = userId;
  if (vendorId) payload.vendorId = vendorId;

  return payload;
}

async function createUser(overrides = {}) {
  return User.create({
    name: "Rollback User",
    phoneNo: Number(`5${String(uniqueCounter).padStart(9, "0")}`),
    email: `${unique("rollback_user")}@example.test`,
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

function mockCapturedPayment({ orderId, paymentId, amount = 9000, overrides = {} }) {
  razorpay.payments.fetch.mockResolvedValue({
    id: paymentId,
    order_id: orderId,
    amount,
    currency: "INR",
    status: "captured",
    captured: true,
    method: "upi",
    ...overrides,
  });
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

async function creditWalletInsideSession(
  entityType,
  entityId,
  amount,
  transactionId,
  totalDiscount,
  originalAmount,
  metadata,
  session,
) {
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
}

function installWalletCreditMock() {
  WalletService.credit.mockImplementation(creditWalletInsideSession);
}

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({
    replSet: {
      count: 1,
      storageEngine: "wiredTiger",
    },
  });

  await mongoose.connect(replSet.getUri(), {
    dbName: "payment_rollback_tests",
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

describe("verifyPayment rollback behavior", () => {
  test("rolls back the processing lock when WalletService.credit fails", async () => {
    const user = await createUser();
    const { orderId, paymentId } = await createTransaction({ userId: user._id });
    mockCapturedPayment({ orderId, paymentId });
    WalletService.credit.mockRejectedValueOnce(
      Object.assign(new Error("wallet write failed"), { code: "WALLET_WRITE_FAILED" }),
    );

    await expect(
      paymentService.verifyPayment(verificationPayload({ orderId, paymentId, userId: user._id })),
    ).rejects.toMatchObject({ code: "WALLET_WRITE_FAILED" });

    const stored = await Transaction.findOne({ razorpayOrderId: orderId }).lean();
    const userAfter = await User.findById(user._id).lean();

    expect(stored.status).toBe("initiated");
    expect(stored.razorpayPaymentId).toBeUndefined();
    expect(userAfter).toMatchObject({
      balance: 0,
      transactionCount: 0,
      totalDiscount: 0,
      totalOriginalAmount: 0,
    });
    expect(NotificationService.sendSMS).not.toHaveBeenCalled();
  });

  test("rolls back a wallet mutation that occurs before ledger failure", async () => {
    const user = await createUser();
    const { orderId, paymentId } = await createTransaction({ userId: user._id });
    mockCapturedPayment({ orderId, paymentId });

    WalletService.credit.mockImplementationOnce(async (...args) => {
      await creditWalletInsideSession(...args);
      const error = new Error("ledger insert failed");
      error.code = "LEDGER_INSERT_FAILED";
      throw error;
    });

    await expect(
      paymentService.verifyPayment(verificationPayload({ orderId, paymentId, userId: user._id })),
    ).rejects.toMatchObject({ code: "LEDGER_INSERT_FAILED" });

    const stored = await Transaction.findOne({ razorpayOrderId: orderId }).lean();
    const userAfter = await User.findById(user._id).lean();

    expect(stored.status).toBe("initiated");
    expect(userAfter.balance).toBe(0);
    expect(userAfter.transactionCount).toBe(0);
    expect(NotificationService.sendSMS).not.toHaveBeenCalled();
  });

  test("rolls back wallet credit when the final transaction update fails", async () => {
    const user = await createUser();
    const { orderId, paymentId } = await createTransaction({ userId: user._id });
    mockCapturedPayment({ orderId, paymentId });

    const originalFindOneAndUpdate = Transaction.findOneAndUpdate.bind(Transaction);
    jest.spyOn(Transaction, "findOneAndUpdate").mockImplementation((filter, update, options) => {
      if (filter && filter._id && filter.status === "processing") {
        return Promise.resolve(null);
      }

      return originalFindOneAndUpdate(filter, update, options);
    });

    await expect(
      paymentService.verifyPayment(verificationPayload({ orderId, paymentId, userId: user._id })),
    ).rejects.toMatchObject({ code: "TRANSACTION_UPDATE_FAILED" });

    const stored = await Transaction.findOne({ razorpayOrderId: orderId }).lean();
    const userAfter = await User.findById(user._id).lean();

    expect(stored.status).toBe("initiated");
    expect(userAfter.balance).toBe(0);
    expect(userAfter.transactionCount).toBe(0);
    expect(NotificationService.sendSMS).not.toHaveBeenCalled();
  });

  test("rolls back the lock and avoids wallet credit on amount mismatch", async () => {
    const user = await createUser();
    const { orderId, paymentId } = await createTransaction({ userId: user._id });
    mockCapturedPayment({ orderId, paymentId, amount: 9100 });

    await expect(
      paymentService.verifyPayment(verificationPayload({ orderId, paymentId, userId: user._id })),
    ).rejects.toMatchObject({ code: "AMOUNT_MISMATCH" });

    const stored = await Transaction.findOne({ razorpayOrderId: orderId }).lean();
    const userAfter = await User.findById(user._id).lean();

    expect(stored.status).toBe("initiated");
    expect(userAfter.balance).toBe(0);
    expect(WalletService.credit).not.toHaveBeenCalled();
    expect(NotificationService.sendSMS).not.toHaveBeenCalled();
  });

  test("rolls back the lock and avoids wallet credit on Razorpay network failure", async () => {
    const user = await createUser();
    const { orderId, paymentId } = await createTransaction({ userId: user._id });
    razorpay.payments.fetch.mockRejectedValue(new Error("socket hang up"));

    await expect(
      paymentService.verifyPayment(verificationPayload({ orderId, paymentId, userId: user._id })),
    ).rejects.toMatchObject({ code: "RAZORPAY_API_ERROR" });

    const stored = await Transaction.findOne({ razorpayOrderId: orderId }).lean();
    const userAfter = await User.findById(user._id).lean();

    expect(stored.status).toBe("initiated");
    expect(userAfter.balance).toBe(0);
    expect(WalletService.credit).not.toHaveBeenCalled();
    expect(NotificationService.sendSMS).not.toHaveBeenCalled();
  });
});

describe("webhook rollback and retry state", () => {
  test("marks the webhook failed and rolls back payment state when wallet credit fails", async () => {
    const user = await createUser();
    const { orderId, paymentId } = await createTransaction({ userId: user._id });
    const payload = capturedWebhook({ orderId, paymentId, webhookId: unique("wh_wallet_fail") });

    WalletService.credit.mockRejectedValueOnce(
      Object.assign(new Error("wallet unavailable"), { code: "WALLET_UNAVAILABLE" }),
    );

    await expect(paymentService.processWebhook(payload)).rejects.toMatchObject({
      code: "WALLET_UNAVAILABLE",
    });

    const stored = await Transaction.findOne({ razorpayOrderId: orderId }).lean();
    const userAfter = await User.findById(user._id).lean();
    const webhookRecord = await WebhookProcess.findOne({ webhookId: payload.webhook_id }).lean();

    expect(stored.status).toBe("initiated");
    expect(userAfter.balance).toBe(0);
    expect(webhookRecord).toMatchObject({
      status: "failed",
      error: {
        message: "wallet unavailable",
        code: "WALLET_UNAVAILABLE",
      },
    });
    expect(NotificationService.sendSMS).not.toHaveBeenCalled();
  });

  test("marks the webhook failed and rolls back the processing lock on amount mismatch", async () => {
    const user = await createUser();
    const { orderId, paymentId } = await createTransaction({ userId: user._id });
    const payload = capturedWebhook({
      orderId,
      paymentId,
      webhookId: unique("wh_amount_mismatch"),
      amount: 8800,
    });

    await expect(paymentService.processWebhook(payload)).rejects.toMatchObject({
      code: "AMOUNT_MISMATCH",
    });

    const stored = await Transaction.findOne({ razorpayOrderId: orderId }).lean();
    const userAfter = await User.findById(user._id).lean();
    const webhookRecord = await WebhookProcess.findOne({ webhookId: payload.webhook_id }).lean();

    expect(stored.status).toBe("initiated");
    expect(userAfter.balance).toBe(0);
    expect(webhookRecord.status).toBe("failed");
    expect(webhookRecord.error.code).toBe("AMOUNT_MISMATCH");
    expect(WalletService.credit).not.toHaveBeenCalled();
  });

  test("controller acknowledges webhook processing errors so Razorpay receives HTTP 200", async () => {
    const user = await createUser();
    const { orderId, paymentId } = await createTransaction({ userId: user._id });
    const payload = capturedWebhook({
      orderId,
      paymentId,
      webhookId: unique("wh_controller_error"),
      amount: 8800,
    });
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

    const stored = await Transaction.findOne({ razorpayOrderId: orderId }).lean();
    const webhookRecord = await WebhookProcess.findOne({ webhookId: payload.webhook_id }).lean();

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        processed: false,
        code: "AMOUNT_MISMATCH",
      }),
    );
    expect(stored.status).toBe("initiated");
    expect(webhookRecord.status).toBe("failed");
  });
});
