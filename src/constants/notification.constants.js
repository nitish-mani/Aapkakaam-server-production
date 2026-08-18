"use strict";

const NOTIFICATION_TYPE = Object.freeze({
  SMS: "SMS",
  PUSH: "PUSH",
  EMAIL: "EMAIL",
  TELEGRAM: "TELEGRAM",
});

const NOTIFICATION_STATUS = Object.freeze({
  QUEUED: "queued",
  PROCESSING: "processing",
  SENT: "sent",
  FAILED: "failed",
  CANCELLED: "cancelled",
});

const NOTIFICATION_PRIORITY = Object.freeze({
  CRITICAL: 1,
  HIGH: 2,
  NORMAL: 5,
  LOW: 10,
});

module.exports = {
  NOTIFICATION_TYPE,
  NOTIFICATION_STATUS,
  NOTIFICATION_PRIORITY,
};
