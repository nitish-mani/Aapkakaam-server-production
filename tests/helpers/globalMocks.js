"use strict";

/**
 * Global Jest Mocks
 *
 * These mocks prevent external services from running during tests.
 * Loaded once from tests/helpers/setup.js.
 */

// ======================================================
// Notification Queue (BullMQ / Redis)
// ======================================================

jest.mock("../../src/queues/notification.queue", () => ({
  addNotificationJob: jest.fn().mockResolvedValue({
    id: "notification-job-1",
  }),
}));

// ======================================================
// Notification Service
// ======================================================

jest.mock("../../src/services/NotificationService", () => ({
  createNotification: jest.fn().mockResolvedValue({}),

  sendSMS: jest.fn().mockResolvedValue({}),

  sendPush: jest.fn().mockResolvedValue({}),

  sendEmail: jest.fn().mockResolvedValue({}),

  sendTelegram: jest.fn().mockResolvedValue({}),

  bookingCreated: jest.fn().mockResolvedValue({}),

  bookingCancelled: jest.fn().mockResolvedValue({}),

  selfBookingCreated: jest.fn().mockResolvedValue({}),
}));

// ======================================================
// Wallet Service
// ======================================================

jest.mock("../../src/services/WalletService", () => ({
  credit: jest.fn().mockResolvedValue({}),

  debit: jest.fn().mockResolvedValue({}),
}));

// ======================================================
// Razorpay SDK
// ======================================================

jest.mock("../../controller/razorpay", () => ({
  payments: {
    fetch: jest.fn(),
  },

  orders: {
    create: jest.fn(),

    fetch: jest.fn(),

    fetchPayments: jest.fn(),
  },

  refunds: {
    create: jest.fn(),

    fetch: jest.fn(),
  },
}));

// ======================================================
// Logger
// ======================================================

jest.mock("../../src/logger/logger", () => ({
  info: jest.fn(),

  debug: jest.fn(),

  warn: jest.fn(),

  error: jest.fn(),
}));

// ======================================================
// Pricing
// ======================================================

jest.mock("../../src/config/pricing", () => ({
  getPricing: jest.fn((amount) => ({
    originalAmount: amount,
    payableAmount: amount,
    discount: 0,
    discountPercent: 0,
  })),
}));
