"use strict";

const { PermanentError } = require("../../utils/retryableErrors");

const CONFIG = require("../../config/notification.config");

const NotificationStateMachine = require("./NotificationStateMachine");

class NotificationValidator {
  validate(notification) {
    // ============================================================
    // BASIC
    // ============================================================

    if (!notification) {
      throw new PermanentError("Notification is required");
    }

    // ============================================================
    // BUSINESS TYPE
    // ============================================================

    if (!notification.type) {
      throw new PermanentError("Notification type is required");
    }

    const notificationType = String(notification.type).trim().toUpperCase();

    const validTypes = Array.isArray(CONFIG.VALID_NOTIFICATION_TYPES)
      ? CONFIG.VALID_NOTIFICATION_TYPES.map((type) => String(type).trim().toUpperCase())
      : [];

    if (!validTypes.includes(notificationType)) {
      throw new PermanentError(`Invalid notification type: ${notification.type}`);
    }

    // ============================================================
    // CHANNEL
    // ============================================================

    if (!notification.channel) {
      throw new PermanentError("Notification channel is required");
    }

    const channel = String(notification.channel).trim().toUpperCase();

    const validChannels = Array.isArray(CONFIG.VALID_NOTIFICATION_CHANNELS)
      ? CONFIG.VALID_NOTIFICATION_CHANNELS.map((item) => String(item).trim().toUpperCase())
      : [];

    if (!validChannels.includes(channel)) {
      throw new PermanentError(`Invalid notification channel: ${notification.channel}`);
    }

    // ============================================================
    // RECIPIENT STRUCTURE
    // ============================================================

    /**
     * IMPORTANT
     *
     * Do NOT validate channel recipient fields here.
     *
     * Example:
     *
     * PUSH without pushToken
     *
     * is NOT an invalid notification.
     *
     * It simply means PUSH is unavailable and the
     * NotificationDispatcher must try the next channel.
     *
     * Dispatcher owns:
     *
     * PUSH
     *   ↓ unavailable/failure
     * WHATSAPP
     *   ↓ unavailable/failure
     * SMS
     *
     * Validator owns only the notification structure.
     */

    if (!notification.recipient) {
      throw new PermanentError("Notification recipient is required");
    }

    // ============================================================
    // EXPIRATION
    // ============================================================

    if (notification.expiresAt) {
      const expiresAt = new Date(notification.expiresAt);

      if (Number.isNaN(expiresAt.getTime())) {
        throw new PermanentError("Invalid notification expiration date");
      }

      if (new Date() > expiresAt) {
        throw new PermanentError("Notification has expired");
      }
    }

    // ============================================================
    // STATUS
    // ============================================================

    if (notification.status) {
      NotificationStateMachine.validateStatus(notification.status);
    }

    return true;
  }
}

module.exports = new NotificationValidator();
