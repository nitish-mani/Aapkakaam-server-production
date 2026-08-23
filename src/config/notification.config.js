"use strict";

/**
 * Notification Configuration
 *
 * IMPORTANT:
 *
 * notification.type
 *   = business/event type OR legacy notification type
 *
 * notification.channel
 *   = actual delivery channel
 *
 * Legacy examples:
 *
 * type    = PUSH
 * channel = PUSH
 *
 * type    = SMS
 * channel = SMS
 *
 * Business examples:
 *
 * type    = PAYMENT
 * channel = PUSH
 *
 * type    = CONCERN
 * channel = PUSH
 *
 * Business policy:
 *
 * PAYMENT
 *   PUSH -> WHATSAPP -> SMS
 *
 * CONCERN
 *   PUSH -> WHATSAPP -> SMS
 */

const CONFIG = Object.freeze({
  // ============================================================
  // LOCK
  // ============================================================

  LOCK_BUFFER_SECONDS: Number(process.env.NOTIFICATION_LOCK_BUFFER_SECONDS) || 10,

  // ============================================================
  // JOB
  // ============================================================

  JOB_TIMEOUT_MS: Number(process.env.NOTIFICATION_JOB_TIMEOUT) || 30000,

  // ============================================================
  // RETRY
  // ============================================================

  MAX_ATTEMPTS: Number(process.env.NOTIFICATION_MAX_ATTEMPTS) || 3,

  RETRY_BASE_DELAY_MS: Number(process.env.NOTIFICATION_RETRY_BASE_DELAY_MS) || 5000,

  MAX_RETRY_DELAY_MS: Number(process.env.NOTIFICATION_MAX_RETRY_DELAY_MS) || 3600000,

  // ============================================================
  // LOCK RENEWAL
  // ============================================================

  LOCK_RENEWAL_INTERVAL_FACTOR: 0.5,

  // ============================================================
  // ERROR HANDLING
  // ============================================================

  ERROR_MESSAGE_MAX_LENGTH: 500,

  MAX_FAILURE_HISTORY: Number(process.env.MAX_FAILURE_HISTORY) || 10,

  REDACTED_ERROR_MESSAGE: "Authentication error (details redacted)",

  SENSITIVE_PATTERNS: [
    /API[_\s]?key/i,
    /secret/i,
    /password/i,
    /token/i,
    /authorization/i,
    /Bearer/i,
    /api[_\s]?key/i,
    /access[_\s]?key/i,
    /private[_\s]?key/i,
  ],

  // ============================================================
  // NOTIFICATION TYPES
  // ============================================================
  //
  // IMPORTANT:
  //
  // This list contains BOTH:
  //
  // 1. Legacy notification types
  //
  //    PUSH
  //    SMS
  //    EMAIL
  //    TELEGRAM
  //    WHATSAPP
  //    IN_APP
  //
  // 2. Business notification types
  //
  //    OTP
  //    BOOKING
  //    CANCELLED
  //    PAYMENT
  //    CONCERN
  //
  // This is required for backward compatibility.
  //
  // ============================================================

  VALID_NOTIFICATION_TYPES: [
    // ----------------------------------------------------------
    // Legacy types
    // ----------------------------------------------------------

    "SMS",
    "EMAIL",
    "PUSH",
    "TELEGRAM",
    "WHATSAPP",
    "IN_APP",

    // ----------------------------------------------------------
    // Business/event types
    // ----------------------------------------------------------

    "OTP",
    "BOOKING",
    "CANCELLED",
    "PAYMENT",
    "CONCERN",
  ],

  // ============================================================
  // DELIVERY CHANNELS
  // ============================================================

  VALID_NOTIFICATION_CHANNELS: ["SMS", "EMAIL", "PUSH", "TELEGRAM", "WHATSAPP", "IN_APP"],

  // ============================================================
  // NETWORK ERRORS
  // ============================================================

  NETWORK_ERROR_CODES: [
    "ECONNRESET",
    "ECONNREFUSED",
    "ETIMEDOUT",
    "EPIPE",
    "ENOTFOUND",
    "EAI_AGAIN",
    "ECONNABORTED",
    "ESOCKETTIMEDOUT",
    "EHOSTUNREACH",
    "ENETUNREACH",
  ],

  // ============================================================
  // TERMINAL STATUSES
  // ============================================================

  TERMINAL_STATUSES: ["sent", "failed", "cancelled"],

  // ============================================================
  // STATUS TRANSITIONS
  // ============================================================

  VALID_STATUS_TRANSITIONS: {
    queued: ["processing"],

    processing: ["sent", "failed", "retrying"],

    retrying: ["processing", "failed"],

    sent: [],

    failed: [],

    cancelled: [],
  },
});

module.exports = CONFIG;
