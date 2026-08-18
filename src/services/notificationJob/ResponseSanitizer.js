"use strict";

const CONFIG = require("../../config/notification.config");

/**
 * ResponseSanitizer - Sanitizes responses and errors for storage
 */
class ResponseSanitizer {
  /**
   * Sanitize provider response using whitelist approach (no mutation)
   */
  sanitizeProviderResponse(response) {
    if (!response) return null;

    const allowedFields = [
      "providerMessageId",
      "requestId",
      "deliveryId",
      "accepted",
      "status",
      "timestamp",
      "latency",
      "provider",
      "sid",
      "messageId",
      "msgId",
      "recipient",
      "sender",
    ];

    const sanitized = {};

    const sourceMap = {
      providerMessageId: response.messageId || response.id || response.message_id,
      requestId: response.requestId || response.request_id,
      deliveryId: response.deliveryId || response.delivery_id || response.receiptId,
      status: response.status || response.state,
      accepted: response.accepted || response.success || false,
      timestamp: response.timestamp || new Date().toISOString(),
      provider: response.provider || "unknown",
      sid: response.sid,
      messageId: response.messageId,
      msgId: response.msgId,
      recipient: response.to || response.recipient,
      sender: response.from || response.sender,
    };

    if (response.latency || response.duration) {
      sanitized.latency = response.latency || response.duration;
    }

    for (const field of allowedFields) {
      if (sourceMap[field] !== undefined && sourceMap[field] !== null) {
        sanitized[field] = sourceMap[field];
      }
    }

    const sensitiveFields = [
      "auth",
      "authorization",
      "token",
      "apiKey",
      "secret",
      "password",
      "credential",
      "accessToken",
      "refreshToken",
      "request",
      "headers",
      "config",
      "axios",
      "data",
    ];

    for (const field of sensitiveFields) {
      delete sanitized[field];
    }

    return sanitized;
  }

  /**
   * Sanitize error message for safe storage and logging
   */
  sanitizeError(err) {
    const sanitized = {
      message: err.message?.substring(0, CONFIG.ERROR_MESSAGE_MAX_LENGTH) || "Unknown error",
      code: err.code || "UNKNOWN_ERROR",
      name: err.name || "Error",
    };

    if (err.stack && process.env.NODE_ENV !== "production") {
      sanitized.stack = err.stack.substring(0, 1000);
    }

    if (CONFIG.SENSITIVE_PATTERNS.some((pattern) => pattern.test(sanitized.message))) {
      sanitized.message = CONFIG.REDACTED_ERROR_MESSAGE;
      sanitized.redacted = true;
    }

    return sanitized;
  }
}

module.exports = new ResponseSanitizer();
