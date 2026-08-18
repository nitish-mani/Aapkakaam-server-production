"use strict";

const SmsProvider = require("./SmsProvider");
const PushProvider = require("./PushProvider");
const EmailProvider = require("./EmailProvider");
const TelegramProvider = require("./TelegramProvider");

const logger = require("../../logger/logger");

const DEFAULT_TIMEOUT = Number(process.env.NOTIFICATION_DISPATCH_TIMEOUT) || 30000;

class NotificationDispatcher {
  constructor() {
    this.providers = new Map();

    this.register("sms", SmsProvider);
    this.register("push", PushProvider);
    this.register("email", EmailProvider);
    this.register("telegram", TelegramProvider);
  }

  /**
   * Register Provider
   */
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

  /**
   * Get Provider
   */
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
  /**
   * Dispatch Notification
   */
  async dispatch(notification) {
    const start = Date.now();

    const provider = this.getProvider(notification.type);

    logger.debug(
      {
        notificationId: notification._id,
        type: notification.type,
        requestId: notification.requestId,
      },
      "Notification dispatch started",
    );

    try {
      const response = await Promise.race([
        provider.send(notification),

        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error(`Notification dispatch timeout after ${DEFAULT_TIMEOUT} ms`)),
            DEFAULT_TIMEOUT,
          ),
        ),
      ]);

      logger.info(
        {
          notificationId: notification._id,
          type: notification.type,
          requestId: notification.requestId,
          duration: `${Date.now() - start} ms`,
        },
        "Notification dispatched successfully",
      );

      return response;
    } catch (err) {
      logger.error(
        {
          err,
          notificationId: notification._id,
          type: notification.type,
          requestId: notification.requestId,
          duration: `${Date.now() - start} ms`,
        },
        "Notification dispatch failed",
      );

      err.provider = notification.type;
      err.dispatchDuration = Date.now() - start;

      throw err;
    }
  }

  /**
   * Check if provider exists
   */
  hasProvider(type) {
    if (!type) return false;

    return this.providers.has(type.trim().toLowerCase());
  }

  /**
   * List registered providers
   */
  listProviders() {
    return [...this.providers.keys()];
  }
}

module.exports = new NotificationDispatcher();
