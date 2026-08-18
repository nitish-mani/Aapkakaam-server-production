"use strict";

const logger = require("../../logger/logger");
const { sendTelegram } = require("../NotificationService");

const { RetryableError, PermanentError } = require("../../utils/retryableErrors");

class TelegramProvider {
  /**
   * Send Telegram Notification
   */
  async send(notification) {
    const { _id, recipient, payload, requestId, template } = notification;

    // Validate recipient
    if (!recipient?.chatId) {
      throw new PermanentError("Telegram chatId is missing.");
    }

    // Validate payload
    if (!payload?.message) {
      throw new PermanentError("Telegram message is missing.");
    }

    logger.debug(
      {
        notificationId: _id,
        template,
        chatId: recipient.chatId,
        requestId,
      },
      "Sending Telegram notification",
    );

    try {
      const response = await sendTelegram({
        chatId: recipient.chatId,
        message: payload.message,
      });

      logger.info(
        {
          notificationId: _id,
          template,
          requestId,
        },
        "Telegram notification sent",
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
        "Telegram Provider Error",
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
       * Telegram HTTP Errors
       */
      const status = err.response?.status;

      if (status >= 500) {
        throw new RetryableError(err.message);
      }

      if (status === 429) {
        throw new RetryableError("Telegram rate limit exceeded.");
      }

      if ([400, 401, 403, 404].includes(status)) {
        throw new PermanentError(err.message);
      }

      /**
       * Telegram API response
       * (when HTTP 200 but ok=false)
       */
      const description = err.response?.data?.description;

      if (
        description?.includes("chat not found") ||
        description?.includes("bot was blocked") ||
        description?.includes("user is deactivated")
      ) {
        throw new PermanentError(description);
      }

      /**
       * Unknown → Retry
       */
      throw new RetryableError(err.message);
    }
  }
}

module.exports = new TelegramProvider();
