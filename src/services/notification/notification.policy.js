"use strict";

/**
 * Notification delivery policy.
 *
 * One business event creates ONE logical notification.
 *
 * The worker follows this channel order:
 *
 * PUSH
 *   ↓ failure
 * WHATSAPP
 *   ↓ failure
 * SMS
 */

const NOTIFICATION_POLICIES = {
  // ==========================================================
  // OTP
  // ==========================================================

  OTP: {
    channels: ["SMS", "WHATSAPP"],
    fallback: true,
  },

  // ==========================================================
  // BOOKING CREATED
  // ==========================================================

  BOOKING: {
    channels: ["PUSH", "WHATSAPP", "SMS"],
    fallback: true,
  },

  // ==========================================================
  // BOOKING CANCELLED
  // ==========================================================

  CANCELLED: {
    channels: ["PUSH", "WHATSAPP", "SMS"],
    fallback: true,
  },

  // ==========================================================
  // BOOKING COMPLETED
  // ==========================================================

  BOOKING_COMPLETED: {
    channels: ["PUSH", "WHATSAPP", "SMS"],
    fallback: true,
  },

  // ==========================================================
  // PAYMENT
  // ==========================================================

  PAYMENT: {
    channels: ["PUSH", "WHATSAPP", "SMS"],
    fallback: true,
  },
};

function getNotificationPolicy(type) {
  const normalizedType = String(type || "")
    .trim()
    .toUpperCase();

  return (
    NOTIFICATION_POLICIES[normalizedType] || {
      channels: ["PUSH"],
      fallback: false,
    }
  );
}

module.exports = {
  NOTIFICATION_POLICIES,
  getNotificationPolicy,
};
