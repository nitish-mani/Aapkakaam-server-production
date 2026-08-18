"use strict";

const { RetryableError, PermanentError } = require("../../utils/retryableErrors");
const CONFIG = require("../../config/notification.config");

/**
 * ErrorClassifier - Pure error classification
 * Single Responsibility: Determine if error is retryable and its category
 */
class ErrorClassifier {
  /**
   * Classify error with detailed categories
   * Returns: { type, retryable, category }
   */
  classify(err) {
    // Permanent errors (programming bugs, validation)
    if (err instanceof PermanentError) {
      return { type: "PERMANENT", retryable: false, category: "permanent" };
    }

    // Retryable errors (temporary issues)
    if (err instanceof RetryableError) {
      return { type: "RETRYABLE", retryable: true, category: "retryable" };
    }

    // Network errors
    if (err.code && CONFIG.NETWORK_ERROR_CODES.includes(err.code)) {
      return { type: "NETWORK", retryable: true, category: "network" };
    }

    // HTTP status codes
    if (err.statusCode || err.status) {
      const status = err.statusCode || err.status;

      if (status === 429) {
        return { type: "RATE_LIMIT", retryable: true, category: "rate_limit" };
      }

      if (status >= 500 && status < 600) {
        return { type: "SERVER_ERROR", retryable: true, category: "server" };
      }

      if (status >= 400 && status < 500) {
        if ([401, 403, 404, 422, 400].includes(status)) {
          return { type: "CLIENT_ERROR", retryable: false, category: "client" };
        }
      }
    }

    // MongoDB errors
    if (err.name === "MongoError" || err.name === "MongoServerError") {
      const codes = [11000, 121];
      if (codes.includes(err.code)) {
        return { type: "DATABASE_CONSTRAINT", retryable: false, category: "database" };
      }
      return { type: "DATABASE_ERROR", retryable: true, category: "database" };
    }

    // Programming errors - NEVER retry
    if (
      err instanceof TypeError ||
      err instanceof ReferenceError ||
      err instanceof SyntaxError ||
      err instanceof RangeError
    ) {
      return { type: "PROGRAMMING_ERROR", retryable: false, category: "programming" };
    }

    // Validation errors
    if (err.name === "ValidationError" || err.name === "ValidatorError") {
      return { type: "VALIDATION_ERROR", retryable: false, category: "validation" };
    }

    // Unknown - treat as retryable
    return { type: "UNKNOWN", retryable: true, category: "unknown" };
  }

  /**
   * Check if error is retryable
   */
  isRetryable(err) {
    return this.classify(err).retryable;
  }

  /**
   * Get error category
   */
  getCategory(err) {
    return this.classify(err).category;
  }
}

module.exports = new ErrorClassifier();
