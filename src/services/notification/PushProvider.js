"use strict";

const logger = require("../../logger/logger");

const { sendPushNotification } = require("../firebase/FirebasePushService");

const { RetryableError, PermanentError } = require("../../utils/retryableErrors");

class PushProvider {
  /**
   * Send Push Notification
   *
   * Notification structure:
   *
   * recipient:
   * {
   *   pushToken: "FCM_TOKEN"
   * }
   *
   * content:
   * {
   *   templateData: {
   *     title: "Booking Confirmed",
   *     body: "Your booking has been confirmed",
   *     type: "booking",
   *     screen: "profile",
   *     data: {}
   *   }
   * }
   */
  static async send(notification) {
    const started = Date.now();

    const { _id, recipient, template, content, requestId } = notification;

    // ============================================================
    // RECIPIENT VALIDATION
    // ============================================================

    const rawToken = recipient?.pushToken;

    if (!rawToken) {
      const error = new PermanentError("Push notification recipient pushToken is missing.", {
        code: "INVALID_PUSH_RECIPIENT",
      });

      logger.warn(
        {
          event: "PUSH_RECIPIENT_INVALID",

          notificationId: _id,

          requestId,

          template,

          provider: "Firebase",

          code: "INVALID_PUSH_RECIPIENT",
        },

        "Push notification recipient pushToken is missing",
      );

      throw error;
    }

    const token = String(rawToken).trim();

    if (!token) {
      throw new PermanentError("Push notification pushToken is empty.", {
        code: "INVALID_PUSH_RECIPIENT",
      });
    }

    // ============================================================
    // TEMPLATE DATA
    // ============================================================

    const templateData = content?.templateData;

    if (!templateData || typeof templateData !== "object" || Array.isArray(templateData)) {
      throw new PermanentError(
        `Push notification templateData is missing for notification ${_id}`,
        {
          code: "INVALID_TEMPLATE_DATA",
        },
      );
    }

    const { title, body, type, screen, data: customData = {} } = templateData;

    // ============================================================
    // TITLE
    // ============================================================

    if (!title) {
      throw new PermanentError("Push notification title is missing.", {
        code: "INVALID_PUSH_TITLE",
      });
    }

    // ============================================================
    // BODY
    // ============================================================

    if (!body) {
      throw new PermanentError("Push notification body is missing.", {
        code: "INVALID_PUSH_BODY",
      });
    }

    // ============================================================
    // CUSTOM DATA VALIDATION
    // ============================================================

    if (customData === null || typeof customData !== "object" || Array.isArray(customData)) {
      throw new PermanentError("Push notification data must be an object.", {
        code: "INVALID_PUSH_DATA",
      });
    }

    // ============================================================
    // LOGGING
    // ============================================================

    logger.debug(
      {
        event: "PUSH_SEND_STARTED",

        notificationId: _id,

        requestId,

        template,

        provider: "Firebase",

        // Never log the complete FCM token
        token: token.length > 20 ? `${token.substring(0, 20)}...` : "***",
      },

      "Push notification sending started",
    );

    // ============================================================
    // FIREBASE DATA PAYLOAD
    // ============================================================

    const data = {
      ...customData,

      click_action: customData.click_action || "FLUTTER_NOTIFICATION_CLICK",

      screen: screen || customData.screen || "profile",

      type: type || customData.type || "",
    };

    try {
      // ==========================================================
      // SEND PUSH
      // ==========================================================

      const response = await sendPushNotification({
        token,

        title: String(title),

        body: String(body),

        data,
      });

      const duration = Date.now() - started;

      logger.info(
        {
          event: "PUSH_SENT",

          notificationId: _id,

          requestId,

          template,

          provider: "Firebase",

          duration,

          providerMessageId: response || null,
        },

        "Push notification sent successfully",
      );

      return {
        provider: "Firebase",

        accepted: true,

        success: true,

        providerMessageId: response || null,

        latency: duration,
      };
    } catch (error) {
      const duration = Date.now() - started;

      logger.error(
        {
          event: "PUSH_SEND_FAILED",

          notificationId: _id,

          requestId,

          template,

          provider: "Firebase",

          duration,

          error: {
            message: error.message,

            code: error.code,

            status: error.response?.status,
          },
        },

        "Push notification sending failed",
      );

      // ==========================================================
      // NETWORK ERRORS
      // ==========================================================

      if (
        [
          "ETIMEDOUT",
          "ECONNRESET",
          "ECONNREFUSED",
          "EAI_AGAIN",
          "ECONNABORTED",
          "EHOSTUNREACH",
          "ENETUNREACH",
        ].includes(error.code)
      ) {
        throw new RetryableError(error.message, {
          code: error.code,
          cause: error,
        });
      }

      // ==========================================================
      // ALREADY CLASSIFIED ERROR
      // ==========================================================

      if (error instanceof RetryableError) {
        throw error;
      }

      if (error instanceof PermanentError) {
        throw error;
      }

      // ==========================================================
      // FIREBASE ADMIN ERRORS
      // ==========================================================

      switch (error.code) {
        // --------------------------------------------------------
        // RETRYABLE
        // --------------------------------------------------------

        case "messaging/internal-error":

        case "messaging/server-unavailable":

        case "messaging/unknown-error":

        case "messaging/quota-exceeded":

        case "messaging/unavailable":

        case "messaging/too-many-requests":
          throw new RetryableError(error.message, {
            code: error.code,
            cause: error,
          });

        // --------------------------------------------------------
        // PERMANENT
        // --------------------------------------------------------

        case "messaging/invalid-registration-token":

        case "messaging/registration-token-not-registered":

        case "messaging/invalid-argument":

        case "messaging/mismatched-credential":

        case "messaging/invalid-recipient":

        case "messaging/sender-id-mismatch":

        case "messaging/third-party-auth-error":
          throw new PermanentError(error.message, {
            code: error.code,
            cause: error,
          });

        default:
          break;
      }

      // ==========================================================
      // HTTP STATUS
      // ==========================================================

      const status = error.response?.status;

      // ----------------------------------------------------------
      // RATE LIMITED
      // ----------------------------------------------------------

      if (status === 429) {
        throw new RetryableError("Push provider rate limited.", {
          code: "PUSH_RATE_LIMITED",
          cause: error,
        });
      }

      // ----------------------------------------------------------
      // SERVER ERROR
      // ----------------------------------------------------------

      if (status >= 500 && status <= 599) {
        throw new RetryableError(error.message || "Push provider server error.", {
          code: "PUSH_PROVIDER_SERVER_ERROR",
          cause: error,
        });
      }

      // ----------------------------------------------------------
      // CLIENT / AUTH / CONFIGURATION
      // ----------------------------------------------------------

      if ([400, 401, 403, 404, 422].includes(status)) {
        throw new PermanentError(error.message || "Push provider rejected the request.", {
          code: "PUSH_PROVIDER_CLIENT_ERROR",
          cause: error,
        });
      }

      // ==========================================================
      // UNKNOWN ERROR
      // ==========================================================

      throw new RetryableError(error.message || "Unknown push provider error.", {
        code: "PUSH_UNKNOWN_ERROR",
        cause: error,
      });
    }
  }
}

module.exports = PushProvider;
