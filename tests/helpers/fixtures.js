"use strict";

/**
 * Global mocks for Payment Service tests
 */

const crypto = require("crypto");

// ======================================
// Logger
// ======================================

const logger = {
  info: jest.fn(),
  debug: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

jest.mock("../../src/logger/logger", () => logger);

// ======================================
// Environment
// ======================================

jest.mock("../../src/config/env", () => ({
  NODE_ENV: "test",

  RAZORPAY_KEY: "rzp_test_key",

  RAZORPAY_SECRET: "rzp_test_secret",

  RAZORPAY_WEBHOOK_SECRET: "rzp_test_webhook_secret",
}));

// ======================================
// Pricing
// ======================================

const getPricing = jest.fn((amount) => ({
  originalAmount: amount,
  payableAmount: amount,
  discount: 0,
  discountPercent: 0,
}));

jest.mock("../../src/config/pricing", () => ({
  getPricing,
}));

// ======================================
// Razorpay SDK
// ======================================

const razorpay = {
  orders: {
    create: jest.fn(),
  },

  payments: {
    fetch: jest.fn(),
  },

  refunds: {
    fetch: jest.fn(),
  },
};

jest.mock("../../controller/razorpay", () => razorpay);

// ======================================
// WalletService
// ======================================

const WalletService = {
  credit: jest.fn(),

  debit: jest.fn(),
};

jest.mock("../../src/services/WalletService", () => WalletService);

// ======================================
// NotificationService
// ======================================

const NotificationService = {
  sendSMS: jest.fn(),

  sendEmail: jest.fn(),

  sendPush: jest.fn(),
};

jest.mock("../../src/services/NotificationService", () => NotificationService);

// ======================================
// crypto.randomUUID()
// ======================================

jest.spyOn(crypto, "randomUUID").mockReturnValue("11111111-1111-1111-1111-111111111111");

// ======================================
// Helpers
// ======================================

const resetMocks = () => {
  jest.clearAllMocks();

  razorpay.orders.create.mockReset();

  razorpay.payments.fetch.mockReset();

  razorpay.refunds.fetch.mockReset();

  WalletService.credit.mockReset();

  WalletService.debit.mockReset();

  NotificationService.sendSMS.mockReset();

  NotificationService.sendEmail.mockReset();

  NotificationService.sendPush.mockReset();

  getPricing.mockClear();
};

// ======================================

module.exports = {
  logger,

  razorpay,

  WalletService,

  NotificationService,

  getPricing,

  resetMocks,
};
