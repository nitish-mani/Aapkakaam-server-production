/**
 * payment.service.wallet.test.js
 * Tests for creditBalanceWithAudit() - wallet credit with audit trail
 */

"use strict";

const { mockWalletService } = require("../helpers/mock");
const { createUser, createVendor, createProcessingTransaction } = require("../helpers/fixtures");

jest.mock("../../src/logger/logger", () => require("../helpers/mock").mockLogger);
jest.mock("../../src/services/walletService", () => require("../helpers/mock").mockWalletService);

const paymentService = require("../../src/services/paymentService");
const WalletService = require("../../src/services/walletService");
const { PaymentSource } = require("../../src/constants/payment");

describe("Wallet Credit Service", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(WalletService, "credit");
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("should credit user wallet successfully", async () => {
    const mockUser = createUser();
    WalletService.credit.mockResolvedValue({
      entity: mockUser,
      ledger: { _id: "ledger1" },
    });

    const transaction = createProcessingTransaction({
      userId: mockUser._id,
      amount: 500,
      discount: 50,
      finalAmount: 450,
    });

    const session = {};
    const result = await paymentService.creditBalanceWithAudit(
      transaction,
      450,
      session,
      "payment_order_123",
      "payment_order_123",
      undefined,
      { requestId: "req-123", ipAddress: "127.0.0.1" },
    );

    expect(result.balance).toBe(mockUser.balance);
    expect(WalletService.credit).toHaveBeenCalledWith(
      "user",
      mockUser._id.toString(),
      450,
      transaction._id.toString(),
      50,
      500,
      expect.objectContaining({
        idempotencyKey: "payment_order_123",
        financialOperationId: "payment_order_123",
        requestId: "req-123",
        ipAddress: "127.0.0.1",
      }),
      session,
    );
  });

  test("should credit vendor wallet successfully", async () => {
    const mockVendor = createVendor();
    WalletService.credit.mockResolvedValue({
      entity: mockVendor,
      ledger: { _id: "ledger1" },
    });

    const transaction = createProcessingTransaction({
      vendorId: mockVendor._id,
      userId: null,
      amount: 300,
      discount: 0,
      finalAmount: 300,
    });

    const result = await paymentService.creditBalanceWithAudit(
      transaction,
      300,
      {},
      "payment_order_123",
      "payment_order_123",
    );

    expect(WalletService.credit).toHaveBeenCalledWith(
      "vendor",
      mockVendor._id.toString(),
      300,
      transaction._id.toString(),
      0,
      300,
      expect.any(Object),
      {},
    );
  });

  test("should throw ENTITY_NOT_FOUND when no user or vendor", async () => {
    const transaction = createProcessingTransaction({
      userId: null,
      vendorId: null,
    });

    await expect(
      paymentService.creditBalanceWithAudit(
        transaction,
        100,
        {},
        "payment_order_123",
        "payment_order_123",
      ),
    ).rejects.toMatchObject({
      code: "ENTITY_NOT_FOUND",
    });

    expect(WalletService.credit).not.toHaveBeenCalled();
  });

  test("should throw when WalletService returns undefined", async () => {
    WalletService.credit.mockResolvedValue(undefined);

    const transaction = createProcessingTransaction();

    await expect(
      paymentService.creditBalanceWithAudit(
        transaction,
        100,
        {},
        "payment_order_123",
        "payment_order_123",
      ),
    ).rejects.toThrow("WalletService.credit returned undefined");
  });

  test("should throw when WalletService returns no entity", async () => {
    WalletService.credit.mockResolvedValue({
      ledger: { _id: "ledger1" },
    });

    const transaction = createProcessingTransaction();

    await expect(
      paymentService.creditBalanceWithAudit(
        transaction,
        100,
        {},
        "payment_order_123",
        "payment_order_123",
      ),
    ).rejects.toThrow("WalletService.credit returned result without entity");
  });

  test("should propagate WalletService errors", async () => {
    const error = new Error("Duplicate financial operation");
    error.code = "FINANCIAL_OPERATION_EXISTS";
    WalletService.credit.mockRejectedValue(error);

    const transaction = createProcessingTransaction();

    await expect(
      paymentService.creditBalanceWithAudit(
        transaction,
        100,
        {},
        "payment_order_123",
        "payment_order_123",
      ),
    ).rejects.toMatchObject({
      code: "FINANCIAL_OPERATION_EXISTS",
    });
  });

  test("should set source correctly for API verification", async () => {
    WalletService.credit.mockResolvedValue({
      entity: createUser(),
      ledger: { _id: "ledger1" },
    });

    const transaction = createProcessingTransaction();

    await paymentService.creditBalanceWithAudit(
      transaction,
      100,
      {},
      "payment_order_123",
      "payment_order_123",
      PaymentSource.API,
    );

    const metadata = WalletService.credit.mock.calls[0][6];
    expect(metadata.source).toBe("payment_verification");
  });

  test("should set source correctly for webhook", async () => {
    WalletService.credit.mockResolvedValue({
      entity: createUser(),
      ledger: { _id: "ledger1" },
    });

    const transaction = createProcessingTransaction();

    await paymentService.creditBalanceWithAudit(
      transaction,
      100,
      {},
      "payment_order_123",
      "payment_order_123",
      PaymentSource.WEBHOOK,
    );

    const metadata = WalletService.credit.mock.calls[0][6];
    expect(metadata.source).toBe("webhook");
  });

  test("should include gateway and currency metadata", async () => {
    WalletService.credit.mockResolvedValue({
      entity: createUser(),
      ledger: { _id: "ledger1" },
    });

    const transaction = createProcessingTransaction({
      currency: "USD",
    });

    await paymentService.creditBalanceWithAudit(
      transaction,
      100,
      {},
      "payment_order_123",
      "payment_order_123",
    );

    const metadata = WalletService.credit.mock.calls[0][6];
    expect(metadata.metadata.gateway).toBe("razorpay");
    expect(metadata.metadata.currency).toBe("USD");
  });
});
