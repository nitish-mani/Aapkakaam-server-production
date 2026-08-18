"use strict";

const logger = require("../../logger/logger");
const { sendEmail } = require("../NotificationService");

const { RetryableError, PermanentError } = require("../../utils/retryableErrors");

class EmailProvider {
  /**
   * Send Email Notification
   */
  async send(notification) {
    const { _id, recipient, payload, requestId, template } = notification;

    // Validate recipient
    if (!recipient?.email) {
      throw new PermanentError("Email recipient is missing.");
    }

    // Validate payload
    if (!payload?.subject) {
      throw new PermanentError("Email subject is missing.");
    }

    if (!payload?.html) {
      throw new PermanentError("Email HTML content is missing.");
    }

    logger.debug(
      {
        notificationId: _id,
        template,
        email: recipient.email,
        requestId,
      },
      "Sending email notification",
    );

    try {
      const response = await sendEmail({
        email: recipient.email,
        subject: payload.subject,
        html: payload.html,
      });

      logger.info(
        {
          notificationId: _id,
          template,
          email: recipient.email,
          requestId,
        },
        "Email notification sent",
      );

      return response;
    } catch (err) {
      logger.error(
        {
          err,
          notificationId: _id,
          template,
          email: recipient.email,
          requestId,
        },
        "Email Provider Error",
      );

      // Network Errors
      if (
        ["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "ECONNABORTED"].includes(err.code)
      ) {
        throw new RetryableError(err.message);
      }

      // SMTP Errors
      if (["ECONNECTION", "ETIMEDOUT", "ESOCKET", "EENVELOPE"].includes(err.code)) {
        throw new RetryableError(err.message);
      }

      // Permanent Errors
      if (["EAUTH", "EADDRESS", "EMESSAGE"].includes(err.code)) {
        throw new PermanentError(err.message);
      }

      // Axios HTTP Status (if applicable)
      const status = err.response?.status;

      if (status >= 500) {
        throw new RetryableError(err.message);
      }

      if (status === 429) {
        throw new RetryableError("Email provider rate limited.");
      }

      if ([400, 401, 403, 404, 422].includes(status)) {
        throw new PermanentError(err.message);
      }

      // Default: retry
      throw new RetryableError(err.message);
    }
  }
}

module.exports = new EmailProvider();
