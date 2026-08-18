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

const mockRedisClient = {
  status: "ready",
  set: jest.fn(),
  eval: jest.fn(),
  get: jest.fn(),
  del: jest.fn(),
  ping: jest.fn(),
  quit: jest.fn(),
  disconnect: jest.fn(),
  once: jest.fn(),
  removeListener: jest.fn(),
};

jest.mock("../../src/config/redis", () => mockRedisClient);

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
const RedisService = require("../../src/services/RedisService");
const paymentService = require("../../src/services/paymentService");

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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    name: "Idempotent User",
    phoneNo: Number(`6${String(uniqueCounter).padStart(9, "0")}`),
    email: `${unique("idempotent_user")}@example.test`,
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

function mockCapturedPayment({ orderId, paymentId, amount = 9000 }) {
  razorpay.payments.fetch.mockResolvedValue({
    id: paymentId,
    order_id: orderId,
    amount,
    currency: "INR",
    status: "captured",
    captured: true,
    method: "upi",
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

function installWalletCreditMock({ delayMs = 0 } = {}) {
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
      if (delayMs > 0) {
        await delay(delayMs);
      }

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
    dbName: "payment_idempotency_tests",
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
  mockRedisClient.status = "ready";
  mockRedisClient.set.mockReset();
  mockRedisClient.eval.mockReset();
  mockRedisClient.get.mockReset();
  mockRedisClient.del.mockReset();
  mockRedisClient.ping.mockReset();
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

describe("payment verification idempotency", () => {
  test("credits the wallet once when the same verification is replayed", async () => {
    const user = await createUser();
    const { orderId, paymentId } = await createTransaction({ userId: user._id });
    const payload = verificationPayload({ orderId, paymentId, userId: user._id });
    mockCapturedPayment({ orderId, paymentId });

    const first = await paymentService.verifyPayment(payload);
    const second = await paymentService.verifyPayment(payload);

    const updatedUser = await User.findById(user._id).lean();
    const stored = await Transaction.findOne({ razorpayOrderId: orderId }).lean();

    expect(first.success).toBe(true);
    expect(first.idempotent).toBeUndefined();
    expect(second).toMatchObject({
      success: true,
      idempotent: true,
      message: "Payment already completed",
    });
    expect(stored.status).toBe("completed");
    expect(updatedUser).toMatchObject({
      balance: 90,
      transactionCount: 1,
      totalDiscount: 10,
      totalOriginalAmount: 100,
    });
    expect(WalletService.credit).toHaveBeenCalledTimes(1);
    expect(NotificationService.sendSMS).toHaveBeenCalledTimes(1);
    expect(razorpay.payments.fetch).toHaveBeenCalledTimes(1);
  });

  test("does not hit Razorpay or WalletService for a completed transaction", async () => {
    const user = await createUser({
      balance: 90,
      transactionCount: 1,
      totalDiscount: 10,
      totalOriginalAmount: 100,
    });
    const { orderId, paymentId } = await createTransaction({
      userId: user._id,
      status: "completed",
    });

    const result = await paymentService.verifyPayment(
      verificationPayload({ orderId, paymentId, userId: user._id }),
    );

    expect(result).toMatchObject({
      success: true,
      idempotent: true,
      balance: 90,
      transactionCount: 1,
    });
    expect(razorpay.payments.fetch).not.toHaveBeenCalled();
    expect(WalletService.credit).not.toHaveBeenCalled();
    expect(NotificationService.sendSMS).not.toHaveBeenCalled();
  });

  test("allows only one wallet credit across concurrent verification attempts", async () => {
    const user = await createUser();
    const { orderId, paymentId } = await createTransaction({ userId: user._id });
    const payload = verificationPayload({ orderId, paymentId, userId: user._id });

    WalletService.credit.mockReset();
    installWalletCreditMock({ delayMs: 40 });
    mockCapturedPayment({ orderId, paymentId });

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => paymentService.verifyPayment(payload)),
    );

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    const updatedUser = await User.findById(user._id).lean();
    const stored = await Transaction.findOne({ razorpayOrderId: orderId }).lean();

    expect(fulfilled.length).toBeGreaterThan(0);
    expect(rejected.every((result) => result.reason.code === "PAYMENT_ALREADY_PROCESSING")).toBe(
      true,
    );
    expect(stored.status).toBe("completed");
    expect(updatedUser.balance).toBe(90);
    expect(updatedUser.transactionCount).toBe(1);
    expect(WalletService.credit).toHaveBeenCalledTimes(1);
    expect(NotificationService.sendSMS).toHaveBeenCalledTimes(1);
  });

  test("database unique indexes reject duplicate gateway order IDs", async () => {
    const user = await createUser();
    const orderId = unique("order_unique");

    await createTransaction({ userId: user._id, orderId });

    await expect(createTransaction({ userId: user._id, orderId })).rejects.toMatchObject({
      code: 11000,
    });

    expect(await Transaction.countDocuments({ razorpayOrderId: orderId })).toBe(1);
  });
});

describe("payment webhook idempotency", () => {
  test("allows only one wallet credit across concurrent duplicate webhook deliveries", async () => {
    const user = await createUser();
    const { orderId, paymentId } = await createTransaction({ userId: user._id });
    const payload = capturedWebhook({ orderId, paymentId, webhookId: unique("wh_race") });

    WalletService.credit.mockReset();
    installWalletCreditMock({ delayMs: 50 });

    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => paymentService.processWebhook(payload)),
    );

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    const stored = await Transaction.findOne({ razorpayOrderId: orderId }).lean();
    const updatedUser = await User.findById(user._id).lean();
    const webhookRecords = await WebhookProcess.find({ webhookId: payload.webhook_id }).lean();

    expect(fulfilled.length).toBeGreaterThan(0);
    expect(rejected.every((result) => result.reason.code === "WEBHOOK_CONCURRENT_PROCESSING")).toBe(
      true,
    );
    expect(webhookRecords).toHaveLength(1);
    expect(webhookRecords[0].status).toBe("completed");
    expect(stored.status).toBe("completed");
    expect(updatedUser.balance).toBe(90);
    expect(updatedUser.transactionCount).toBe(1);
    expect(WalletService.credit).toHaveBeenCalledTimes(1);
    expect(NotificationService.sendSMS).toHaveBeenCalledTimes(1);
  });
});

describe("RedisService payment lock failure coverage", () => {
  test("returns the lock token when Redis SET NX succeeds", async () => {
    mockRedisClient.set.mockResolvedValue("OK");

    await expect(RedisService.acquireLock(" payment:lock:1 ", 30, "token-1")).resolves.toBe(
      "token-1",
    );

    expect(mockRedisClient.set).toHaveBeenCalledWith("payment:lock:1", "token-1", "EX", 30, "NX");
  });

  test("returns null when the Redis lock is already held", async () => {
    mockRedisClient.set.mockResolvedValue(null);

    await expect(RedisService.acquireLock("payment:lock:busy", 30, "token-2")).resolves.toBeNull();
  });

  test("propagates Redis lock acquisition failures", async () => {
    mockRedisClient.set.mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(RedisService.acquireLock("payment:lock:error", 30, "token-3")).rejects.toThrow(
      "ECONNREFUSED",
    );
  });

  test("fails fast when the Redis connection has ended", async () => {
    mockRedisClient.status = "end";

    await expect(RedisService.acquireLock("payment:lock:end", 30, "token-4")).rejects.toThrow(
      "Redis connection has ended",
    );
    expect(mockRedisClient.set).not.toHaveBeenCalled();
  });

  test("does not release a lock when the ownership token does not match", async () => {
    mockRedisClient.eval.mockResolvedValue(0);

    await expect(RedisService.releaseLock("payment:lock:release", "wrong-token")).resolves.toBe(
      false,
    );
  });

  test("validates Redis lock TTL before issuing commands", async () => {
    await expect(RedisService.acquireLock("payment:lock:ttl", 0, "token-5")).rejects.toThrow(
      "Redis lock TTL must be a positive integer",
    );
    expect(mockRedisClient.set).not.toHaveBeenCalled();
  });
});
