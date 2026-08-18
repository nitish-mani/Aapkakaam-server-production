"use strict";

const { PermanentError } = require("../../utils/retryableErrors");
const CONFIG = require("../../config/notification.config");
const NotificationStateMachine = require("./NotificationStateMachine");

/**
 * NotificationValidator - Pure validation logic
 * Single Responsibility: Validate notification data only
 */
class NotificationValidator {
  /**
   * Validate notification before processing
   */
  validate(notification) {
    // Check type
    if (!notification.type) {
      throw new PermanentError("Notification type is required");
    }

    if (!CONFIG.VALID_NOTIFICATION_TYPES.includes(notification.type)) {
      throw new PermanentError(`Invalid notification type: ${notification.type}`);
    }

    // Provider-specific validation
    const requiredFields = {
      SMS: ["phoneNumber"],
      EMAIL: ["email"],
      PUSH: ["pushToken"],
      TELEGRAM: ["telegramChatId"],
      WHATSAPP: ["phoneNumber"],
      IN_APP: ["userId"],
    };

    const fields = requiredFields[notification.type] || [];
    for (const field of fields) {
      if (!notification.recipient?.[field]) {
        throw new PermanentError(`${notification.type} requires ${field}`);
      }
    }

    // Check expiration
    if (notification.expiresAt && new Date() > notification.expiresAt) {
      throw new PermanentError("Notification has expired");
    }

    // Validate status if present
    if (notification.status) {
      NotificationStateMachine.validateStatus(notification.status);
    }

    return true;
  }
}

module.exports = new NotificationValidator();
