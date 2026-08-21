"use strict";

const SmsProvider = require("./SmsProvider");
const PushProvider = require("./PushProvider");
const EmailProvider = require("./EmailProvider");
const TelegramProvider = require("./TelegramProvider");

// WhatsApp provider is optional.
let WhatsAppProvider = null;

try {
  WhatsAppProvider = require("./WhatsAppProvider");
} catch (error) {
  WhatsAppProvider = null;
}

const logger = require("../../logger/logger");

const DEFAULT_TIMEOUT = Number(process.env.NOTIFICATION_DISPATCH_TIMEOUT) || 30000;

class NotificationDispatcher {
  constructor() {
    this.providers = new Map();

    // ==========================================================
    // REGISTER PROVIDERS
    // ==========================================================

    this.register("sms", SmsProvider);

    this.register("push", PushProvider);

    this.register("email", EmailProvider);

    this.register("telegram", TelegramProvider);

    if (WhatsAppProvider) {
      this.register("whatsapp", WhatsAppProvider);
    } else {
      logger.warn("WhatsApp provider not available - WhatsApp fallback will be skipped");
    }
  }

  // ============================================================
  // REGISTER PROVIDER
  // ============================================================

  register(type, provider) {
    if (!type || typeof type !== "string") {
      throw new Error("Provider type is required.");
    }

    const normalizedType = type.trim().toLowerCase();

    if (!provider || typeof provider.send !== "function") {
      throw new Error(
        `Provider '${normalizedType}' must expose an async send(notification) method.`,
      );
    }

    this.providers.set(normalizedType, provider);

    logger.info(
      {
        provider: normalizedType,
      },
      "Notification provider registered",
    );
  }

  // ============================================================
  // GET PROVIDER
  // ============================================================

  getProvider(type) {
    if (!type || typeof type !== "string") {
      throw new Error("Notification provider type is required.");
    }

    const normalizedType = type.trim().toLowerCase();

    const provider = this.providers.get(normalizedType);

    if (!provider) {
      throw new Error(`No provider registered for '${normalizedType}'.`);
    }

    return provider;
  }

  // ============================================================
  // GET CURRENT CHANNEL
  // ============================================================

  getCurrentChannel(notification) {
    // ==========================================================
    // NEW BUSINESS NOTIFICATION
    // ==========================================================

    if (notification?.channel) {
      return notification.channel.trim().toUpperCase();
    }

    // ==========================================================
    // POLICY FALLBACK
    // ==========================================================

    const channels = notification?.channelPolicy?.channels;

    if (Array.isArray(channels) && channels.length > 0) {
      const index = Number.isInteger(notification.channelIndex) ? notification.channelIndex : 0;

      return (channels[index] || channels[0]).trim().toUpperCase();
    }

    // ==========================================================
    // LEGACY NOTIFICATION
    // ==========================================================

    if (notification?.type) {
      return notification.type.trim().toUpperCase();
    }

    return null;
  }

  // ============================================================
  // GET CHANNEL POLICY
  // ============================================================

  getChannelPolicy(notification) {
    const channels = notification?.channelPolicy?.channels;

    if (Array.isArray(channels) && channels.length > 0) {
      return channels.map((channel) => String(channel).trim().toUpperCase()).filter(Boolean);
    }

    // Legacy notification.
    if (notification?.type) {
      return [String(notification.type).trim().toUpperCase()];
    }

    return [];
  }

  // ============================================================
  // CHECK PROVIDER
  // ============================================================

  hasProvider(type) {
    if (!type) {
      return false;
    }

    return this.providers.has(type.trim().toLowerCase());
  }

  // ============================================================
  // CHECK CHANNEL RECIPIENT
  // ============================================================

  /**
   * Check whether the recipient has the information required
   * to use the requested delivery channel.
   *
   * IMPORTANT:
   *
   * Missing recipient information is NOT a provider failure.
   *
   * Example:
   *
   * PUSH
   *   pushToken missing
   *       ↓
   *   skip PUSH
   *       ↓
   *   WHATSAPP
   *
   * This is what allows the fallback chain to work correctly.
   */
  getChannelRecipientStatus(notification, channel) {
    const recipient = notification?.recipient || {};

    const normalizedChannel = String(channel || "")
      .trim()
      .toUpperCase();

    switch (normalizedChannel) {
      // ========================================================
      // PUSH
      // ========================================================

      case "PUSH": {
        const token = String(recipient.pushToken || "").trim();

        if (!token) {
          return {
            available: false,

            reason: "MISSING_PUSH_TOKEN",

            message: "Push token is missing",
          };
        }

        return {
          available: true,
        };
      }

      // ========================================================
      // WHATSAPP
      // ========================================================

      case "WHATSAPP": {
        const number = String(recipient.whatsappNumber || recipient.phoneNumber || "").trim();

        if (!number) {
          return {
            available: false,

            reason: "MISSING_WHATSAPP_NUMBER",

            message: "WhatsApp number is missing",
          };
        }

        return {
          available: true,
        };
      }

      // ========================================================
      // SMS
      // ========================================================

      case "SMS": {
        const number = String(recipient.phoneNumber || "").trim();

        if (!number) {
          return {
            available: false,

            reason: "MISSING_PHONE_NUMBER",

            message: "Phone number is missing",
          };
        }

        return {
          available: true,
        };
      }

      // ========================================================
      // EMAIL
      // ========================================================

      case "EMAIL": {
        const email = String(recipient.email || "").trim();

        if (!email) {
          return {
            available: false,

            reason: "MISSING_EMAIL",

            message: "Email address is missing",
          };
        }

        return {
          available: true,
        };
      }

      // ========================================================
      // TELEGRAM
      // ========================================================

      case "TELEGRAM": {
        const chatId = String(recipient.telegramChatId || "").trim();

        if (!chatId) {
          return {
            available: false,

            reason: "MISSING_TELEGRAM_CHAT_ID",

            message: "Telegram chat ID is missing",
          };
        }

        return {
          available: true,
        };
      }

      // ========================================================
      // IN APP
      // ========================================================

      case "IN_APP": {
        const userId = String(recipient.userId || "").trim();

        if (!userId) {
          return {
            available: false,

            reason: "MISSING_USER_ID",

            message: "User ID is missing",
          };
        }

        return {
          available: true,
        };
      }

      // ========================================================
      // UNKNOWN CHANNEL
      // ========================================================

      default:
        return {
          available: true,
        };
    }
  }

  // ============================================================
  // BUILD PROVIDER NOTIFICATION
  // ============================================================

  /**
   * Database notification:
   *
   *   type = PAYMENT
   *   channel = PUSH
   *
   * Provider receives:
   *
   *   type = PUSH
   *   channel = PUSH
   *
   * This allows existing providers to continue working
   * without changing their business-event logic.
   */
  buildProviderNotification(notification, channel) {
    const providerNotification = {
      ...(typeof notification.toObject === "function" ? notification.toObject() : notification),

      type: channel,

      channel,

      businessType: notification.type,

      notificationType: notification.type,

      channelIndex: notification.channelIndex,

      channelPolicy: notification.channelPolicy,
    };

    return providerNotification;
  }

  // ============================================================
  // DISPATCH ONE CHANNEL
  // ============================================================

  async dispatchChannel(notification, channel) {
    const normalizedChannel = String(channel).trim().toUpperCase();

    const providerType = normalizedChannel.toLowerCase();

    const provider = this.getProvider(providerType);

    const start = Date.now();

    logger.debug(
      {
        notificationId: notification._id,

        businessType: notification.type,

        channel: normalizedChannel,

        requestId: notification.requestId,
      },

      "Notification channel dispatch started",
    );

    const providerNotification = this.buildProviderNotification(notification, normalizedChannel);

    try {
      const response = await Promise.race([
        provider.send(providerNotification),

        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error(`Notification dispatch timeout after ${DEFAULT_TIMEOUT} ms`)),
            DEFAULT_TIMEOUT,
          ),
        ),
      ]);

      const duration = Date.now() - start;

      logger.info(
        {
          notificationId: notification._id,

          businessType: notification.type,

          channel: normalizedChannel,

          requestId: notification.requestId,

          duration: `${duration} ms`,
        },

        "Notification channel dispatched successfully",
      );

      return {
        success: true,

        channel: normalizedChannel,

        response,

        duration,
      };
    } catch (err) {
      const duration = Date.now() - start;

      err.provider = normalizedChannel;

      err.dispatchDuration = duration;

      logger.error(
        {
          err,

          notificationId: notification._id,

          businessType: notification.type,

          channel: normalizedChannel,

          requestId: notification.requestId,

          duration: `${duration} ms`,
        },

        "Notification channel dispatch failed",
      );

      throw err;
    }
  }

  // ============================================================
  // MOVE TO NEXT CHANNEL
  // ============================================================

  async moveToNextChannel(notification) {
    if (!notification || typeof notification.moveToNextChannel !== "function") {
      return false;
    }

    const moved = notification.moveToNextChannel();

    if (!moved) {
      return false;
    }

    await notification.save();

    logger.warn(
      {
        notificationId: notification._id,

        businessType: notification.type,

        channel: notification.channel,

        channelIndex: notification.channelIndex,

        requestId: notification.requestId,

        event: "NOTIFICATION_FALLBACK_CHANNEL_SELECTED",
      },

      "Notification fallback channel selected",
    );

    return true;
  }

  // ============================================================
  // RECORD DELIVERY ATTEMPT
  // ============================================================

  async recordAttempt(
    notification,
    { channel, status, attempt, startedAt, completedAt, provider, providerMessageId, error },
  ) {
    if (typeof notification.recordDeliveryAttempt === "function") {
      notification.recordDeliveryAttempt({
        channel,

        status,

        attempt,

        startedAt,

        completedAt,

        provider,

        providerMessageId,

        error,
      });

      await notification.save();
    }
  }

  // ============================================================
  // SKIP CURRENT CHANNEL
  // ============================================================

  async skipCurrentChannel(notification, channel, reason, message, fallbackEnabled) {
    // ==========================================================
    // RECORD SKIPPED ATTEMPT
    // ==========================================================

    await this.recordAttempt(notification, {
      channel,

      status: "skipped",

      attempt: (notification.attempts || 0) + 1,

      startedAt: new Date(),

      completedAt: new Date(),

      provider: channel,

      error: {
        code: reason,

        message,

        details: {
          reason,
        },
      },
    });

    logger.warn(
      {
        notificationId: notification._id,

        businessType: notification.type,

        channel,

        channelIndex: notification.channelIndex,

        requestId: notification.requestId,

        reason,

        message,

        event: "NOTIFICATION_CHANNEL_SKIPPED",
      },

      "Notification channel skipped",
    );

    // ==========================================================
    // FALLBACK DISABLED
    // ==========================================================

    if (!fallbackEnabled) {
      throw new Error(`${channel} unavailable: ${message}`);
    }

    // ==========================================================
    // NEXT CHANNEL
    // ==========================================================

    const nextIndex = Number.isInteger(notification.channelIndex)
      ? notification.channelIndex + 1
      : 1;

    const policy = this.getChannelPolicy(notification);

    if (nextIndex >= policy.length) {
      throw new Error(`No available notification channel after ${channel}`);
    }

    // ==========================================================
    // USE MODEL METHOD
    // ==========================================================

    if (typeof notification.moveToNextChannel === "function") {
      const moved = notification.moveToNextChannel();

      if (!moved) {
        throw new Error(`Unable to move notification from ${channel} to next channel`);
      }

      await notification.save();
    } else {
      // ========================================================
      // SAFETY FALLBACK
      // ========================================================

      notification.channelIndex = nextIndex;

      notification.channel = policy[nextIndex];

      await notification.save();
    }

    logger.warn(
      {
        notificationId: notification._id,

        businessType: notification.type,

        skippedChannel: channel,

        nextChannel: notification.channel,

        channelIndex: notification.channelIndex,

        reason,

        requestId: notification.requestId,

        event: "NOTIFICATION_RECIPIENT_FALLBACK",
      },

      "Recipient unavailable - moving to next notification channel",
    );

    return true;
  }

  // ============================================================
  // MAIN DISPATCH
  // ============================================================

  /**
   * Main delivery flow.
   *
   * Example:
   *
   * PAYMENT
   *
   * channels:
   *
   *   PUSH
   *   WHATSAPP
   *   SMS
   *
   * Result:
   *
   *   PUSH success
   *       -> DONE
   *
   *   PUSH unavailable
   *       -> WHATSAPP
   *
   *   PUSH failed
   *       -> WHATSAPP
   *
   *   WHATSAPP unavailable
   *       -> SMS
   *
   *   WHATSAPP failed
   *       -> SMS
   *
   *   SMS success
   *       -> DONE
   */
  async dispatch(notification) {
    const start = Date.now();

    if (!notification) {
      throw new Error("Notification is required.");
    }

    // ==========================================================
    // POLICY
    // ==========================================================

    const policy = this.getChannelPolicy(notification);

    if (!policy.length) {
      throw new Error("Notification has no delivery channel policy.");
    }

    const fallbackEnabled = notification?.channelPolicy?.fallback !== false;

    // ==========================================================
    // CURRENT INDEX
    // ==========================================================

    let currentIndex = Number.isInteger(notification.channelIndex) ? notification.channelIndex : 0;

    // ==========================================================
    // SAFETY
    // ==========================================================

    if (currentIndex < 0) {
      currentIndex = 0;
    }

    if (currentIndex >= policy.length) {
      currentIndex = policy.length - 1;
    }

    // ==========================================================
    // DELIVERY LOOP
    // ==========================================================

    while (currentIndex < policy.length) {
      const channel = policy[currentIndex].trim().toUpperCase();

      // ========================================================
      // UPDATE CURRENT CHANNEL
      // ========================================================

      notification.channel = channel;

      notification.channelIndex = currentIndex;

      // ========================================================
      // RECIPIENT AVAILABILITY
      // ========================================================

      const recipientStatus = this.getChannelRecipientStatus(notification, channel);

      if (!recipientStatus.available) {
        await this.skipCurrentChannel(
          notification,

          channel,

          recipientStatus.reason,

          recipientStatus.message,

          fallbackEnabled,
        );

        currentIndex = notification.channelIndex;

        continue;
      }

      // ========================================================
      // PROVIDER CHECK
      // ========================================================

      if (!this.hasProvider(channel)) {
        logger.warn(
          {
            notificationId: notification._id,

            businessType: notification.type,

            channel,

            channelIndex: currentIndex,

            requestId: notification.requestId,

            event: "NOTIFICATION_PROVIDER_NOT_AVAILABLE",
          },

          "Notification provider unavailable - trying fallback",
        );

        await this.recordAttempt(notification, {
          channel,

          status: "skipped",

          attempt: (notification.attempts || 0) + 1,

          startedAt: new Date(),

          completedAt: new Date(),

          provider: channel,

          error: {
            code: "PROVIDER_NOT_REGISTERED",

            message: `No provider registered for ${channel}`,
          },
        });

        if (!fallbackEnabled) {
          throw new Error(`No provider registered for ${channel}`);
        }

        const nextIndex = currentIndex + 1;

        if (nextIndex >= policy.length) {
          throw new Error(`No notification provider available after ${channel}`);
        }

        if (typeof notification.moveToNextChannel === "function") {
          const moved = notification.moveToNextChannel();

          if (!moved) {
            throw new Error(`Unable to move notification from ${channel} to next channel`);
          }

          await notification.save();

          currentIndex = notification.channelIndex;
        } else {
          currentIndex = nextIndex;

          notification.channelIndex = currentIndex;

          notification.channel = policy[currentIndex];

          await notification.save();
        }

        continue;
      }

      // ========================================================
      // ATTEMPT START
      // ========================================================

      const attemptStartedAt = new Date();

      const attemptNumber = (notification.attempts || 0) + 1;

      try {
        // ======================================================
        // SEND
        // ======================================================

        const result = await this.dispatchChannel(notification, channel);

        // ======================================================
        // RECORD SUCCESS
        // ======================================================

        await this.recordAttempt(notification, {
          channel,

          status: "sent",

          attempt: attemptNumber,

          startedAt: attemptStartedAt,

          completedAt: new Date(),

          provider: channel,

          providerMessageId:
            result?.response?.providerMessageId ||
            result?.response?.messageId ||
            result?.response?.id ||
            null,
        });

        // ======================================================
        // UPDATE DELIVERY INFO
        // ======================================================

        notification.channel = channel;

        notification.delivery = notification.delivery || {};

        notification.delivery.provider = channel;

        notification.delivery.providerMessageId =
          result?.response?.providerMessageId ||
          result?.response?.messageId ||
          result?.response?.id ||
          null;

        notification.delivery.deliveredVia = channel;

        notification.delivery.deliveredAt = new Date();

        await notification.save();

        // ======================================================
        // SUCCESS
        // ======================================================

        logger.info(
          {
            notificationId: notification._id,

            businessType: notification.type,

            channel,

            channelIndex: currentIndex,

            requestId: notification.requestId,

            duration: `${Date.now() - start} ms`,

            event: "NOTIFICATION_DELIVERY_SUCCESS",
          },

          "Notification delivered successfully",
        );

        return result.response;
      } catch (err) {
        // ======================================================
        // RECORD FAILURE
        // ======================================================

        await this.recordAttempt(notification, {
          channel,

          status: "failed",

          attempt: attemptNumber,

          startedAt: attemptStartedAt,

          completedAt: new Date(),

          provider: channel,

          error: {
            code: err?.code || "PROVIDER_ERROR",

            message: err?.message || "Notification provider failed",

            details: {
              provider: channel,
            },
          },
        });

        logger.warn(
          {
            notificationId: notification._id,

            businessType: notification.type,

            channel,

            channelIndex: currentIndex,

            requestId: notification.requestId,

            error: err?.message,

            errorCode: err?.code,

            retryable: err?.retryable,

            event: "NOTIFICATION_CHANNEL_FAILED",
          },

          "Notification channel failed",
        );

        // ======================================================
        // NO FALLBACK
        // ======================================================

        if (!fallbackEnabled) {
          throw err;
        }

        // ======================================================
        // NEXT CHANNEL
        // ======================================================

        const nextIndex = currentIndex + 1;

        if (nextIndex >= policy.length) {
          throw err;
        }

        // ======================================================
        // UPDATE MODEL
        // ======================================================

        if (typeof notification.moveToNextChannel === "function") {
          const moved = notification.moveToNextChannel();

          if (!moved) {
            throw err;
          }

          await notification.save();

          currentIndex = notification.channelIndex;
        } else {
          currentIndex = nextIndex;

          notification.channelIndex = currentIndex;

          notification.channel = policy[currentIndex];

          await notification.save();
        }

        logger.warn(
          {
            notificationId: notification._id,

            businessType: notification.type,

            failedChannel: channel,

            nextChannel: notification.channel,

            channelIndex: notification.channelIndex,

            requestId: notification.requestId,

            event: "NOTIFICATION_FALLBACK_STARTED",
          },

          "Moving to next notification delivery channel",
        );

        // Continue loop.
      }
    }

    throw new Error("Notification delivery failed on all available channels.");
  }

  // ============================================================
  // LIST PROVIDERS
  // ============================================================

  listProviders() {
    return [...this.providers.keys()];
  }
}

module.exports = new NotificationDispatcher();
