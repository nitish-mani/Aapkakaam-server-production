"use strict";

const logger = require("./logger");

module.exports = {
  logger,

  AuthLogger: logger.child({
    domain: "auth",
  }),

  BookingLogger: logger.child({
    domain: "booking",
  }),

  VendorLogger: logger.child({
    domain: "vendor",
  }),

  UserLogger: logger.child({
    domain: "user",
  }),

  PaymentLogger: logger.child({
    domain: "payment",
  }),

  CacheLogger: logger.child({
    domain: "cache",
  }),

  RedisLogger: logger.child({
    domain: "redis",
  }),

  WorkerLogger: logger.child({
    domain: "worker",
  }),

  NotificationLogger: logger.child({
    domain: "notification",
  }),

  AuditLogger: logger.child({
    domain: "audit",
  }),

  WalletLogger: logger.child({
    domain: "wallet",
  }),

  SecurityLogger: logger.child({
    domain: "security",
  }),

  AdminLogger: logger.child({
    domain: "admin",
  }),
};
