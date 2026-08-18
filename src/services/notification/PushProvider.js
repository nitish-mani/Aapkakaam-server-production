"use strict";

const logger = require("../../logger/logger");
const { sendPushNotification } = require("../NotificationService");

const { RetryableError, PermanentError } = require("../../utils/retryableErrors");

class PushProvider {
  /**
   * Send Push Notification
   */
  async send(notification) {
    const { _id, recipient, payload, requestId, template } = notification;

    // Validate recipient
    if (!recipient?.token) {
      throw new PermanentError("Push notification token is missing.");
    }

    // Validate payload
    if (!payload?.title) {
      throw new PermanentError("Push notification title is missing.");
    }

    if (!payload?.body) {
      throw new PermanentError("Push notification body is missing.");
    }

    logger.debug(
      {
        notificationId: _id,
        template,
        token: recipient.token.substring(0, 20) + "...",
        requestId,
      },
      "Sending push notification",
    );

    try {
      const response = await sendPushNotification({
        token: recipient.token,
        title: payload.title,
        body: payload.body,
        data: payload.data || {},
      });

      logger.info(
        {
          notificationId: _id,
          template,
          requestId,
        },
        "Push notification sent",
      );

      return response;
    } catch (err) {
      logger.error(
        {
          err,
          notificationId: _id,
          template,
          requestId,
        },
        "Push Provider Error",
      );

      /**
       * Network Errors
       */
      if (
        ["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "ECONNABORTED"].includes(err.code)
      ) {
        throw new RetryableError(err.message);
      }

      /**
       * Firebase Admin SDK errors
       */

      switch (err.code) {
        // Retry
        case "messaging/internal-error":
        case "messaging/server-unavailable":
        case "messaging/unknown-error":
        case "messaging/quota-exceeded":
          throw new RetryableError(err.message);

        // Permanent
        case "messaging/invalid-registration-token":
        case "messaging/registration-token-not-registered":
        case "messaging/invalid-argument":
        case "messaging/mismatched-credential":
          throw new PermanentError(err.message);

        default:
          break;
      }

      /**
       * HTTP Errors
       */

      const status = err.response?.status;

      if (status >= 500) {
        throw new RetryableError(err.message);
      }

      if (status === 429) {
        throw new RetryableError("Push provider rate limited.");
      }

      if ([400, 401, 403, 404, 422].includes(status)) {
        throw new PermanentError(err.message);
      }

      /**
       * Unknown -> Retry
       */

      throw new RetryableError(err.message);
    }
  }
}

module.exports = new PushProvider();
