"use strict";

const logger = require("../../logger/logger");
const NotificationRepository = require("./NotificationRepository");
const RetryPolicy = require("./RetryPolicy");
const MetricsService = require("./MetricsService");
const ResponseSanitizer = require("./ResponseSanitizer");
const ErrorClassifier = require("./ErrorClassifier");
const NotificationStateMachine = require("./NotificationStateMachine");
const { addDeadLetterJob } = require("../../queues/deadLetter.queue");
const CONFIG = require("../../config/notification.config");

/**
 * FailureHandler - Handles all failure scenarios
 * Single Responsibility: Process failures with appropriate actions
 */
class FailureHandler {
  /**
   * Handle permanent error (no retry)
   */
  async handlePermanent({
    notificationId,
    notification,
    err,
    attemptsMade,
    duration,
    requestId,
    version,
  }) {
    // ✅ Ensure version is valid
    const validVersion = await this.ensureVersion(notificationId, version);

    const errorInfo = ResponseSanitizer.sanitizeError(err);

    // Update database
    await NotificationRepository.markFailed(
      notificationId,
      errorInfo,
      attemptsMade,
      "permanent_error",
      validVersion, // ✅ Now guaranteed to be a number
    );

    // Add to Dead Letter Queue
    try {
      await addDeadLetterJob({
        notificationId,
        requestId,
        provider: notification?.type || "unknown",
        template: notification?.template || "unknown",
        recipient: notification?.recipient || {},
        payload: notification?.content || {},
        attempts: attemptsMade,
        error: err.message,
        retryable: false,
        errorCode: err.code,
        errorCategory: "permanent",
        timestamp: new Date(),
      });
    } catch (dlqErr) {
      logger.error(
        {
          err: dlqErr,
          notificationId,
          requestId,
          event: "DLQ_ADD_FAILED",
        },
        "Failed to add permanent error to dead letter queue",
      );
    }

    // Log
    logger.error(
      {
        notificationId,
        requestId,
        attempts: attemptsMade,
        duration,
        error: errorInfo,
        event: "NOTIFICATION_PERMANENT_ERROR",
      },
      "Permanent notification failure - no retry scheduled",
    );

    // Metrics
    MetricsService.recordMetric("PERMANENT_FAILURE", {
      notificationId,
      requestId,
      attempts: attemptsMade,
    });
  }

  /**
   * Handle retryable error (schedule retry)
   */
  async handleRetryable({
    notificationId,
    notification,
    err,
    attemptsMade,
    maxAttempts,
    duration,
    requestId,
    version,
  }) {
    // ✅ Ensure version is valid
    const validVersion = await this.ensureVersion(notificationId, version);

    const errorInfo = ResponseSanitizer.sanitizeError(err);
    const retryDelay = RetryPolicy.calculateDelay(attemptsMade);
    const nextRetryAt = new Date(Date.now() + retryDelay);

    // Update database
    await NotificationRepository.markRetrying(
      notificationId,
      errorInfo,
      attemptsMade,
      nextRetryAt,
      validVersion, // ✅ Now guaranteed to be a number
    );

    // Log
    logger.warn(
      {
        notificationId,
        requestId,
        attempt: attemptsMade,
        maxAttempts,
        retryAfter: retryDelay,
        nextRetryAt,
        duration,
        error: errorInfo,
        event: "NOTIFICATION_RETRY_SCHEDULED",
      },
      "Notification scheduled for retry with exponential backoff",
    );

    // Metrics
    MetricsService.recordMetric("RETRY_SCHEDULED", {
      notificationId,
      requestId,
      attempt: attemptsMade,
      maxAttempts,
    });
  }

  /**
   * Handle final failure (retries exhausted)
   */
  async handleFinal({
    notificationId,
    notification,
    err,
    attemptsMade,
    maxAttempts,
    duration,
    requestId,
    version,
  }) {
    // ✅ Ensure version is valid
    const validVersion = await this.ensureVersion(notificationId, version);

    const errorInfo = ResponseSanitizer.sanitizeError(err);

    // Update database
    await NotificationRepository.markFailed(
      notificationId,
      errorInfo,
      attemptsMade,
      "retries_exhausted",
      validVersion, // ✅ Now guaranteed to be a number
    );

    // Add to Dead Letter Queue
    try {
      await addDeadLetterJob({
        notificationId,
        requestId,
        provider: notification?.type || "unknown",
        template: notification?.template || "unknown",
        recipient: notification?.recipient || {},
        payload: notification?.content || {},
        attempts: attemptsMade,
        error: err.message,
        retryable: true,
        errorCode: err.code,
        errorCategory: "retries_exhausted",
        maxAttempts: CONFIG.MAX_ATTEMPTS,
        timestamp: new Date(),
      });
    } catch (dlqErr) {
      logger.error(
        {
          err: dlqErr,
          notificationId,
          requestId,
          event: "DLQ_ADD_FAILED",
        },
        "Failed to add final failure to dead letter queue",
      );
    }

    // Log
    logger.error(
      {
        notificationId,
        requestId,
        attempts: attemptsMade,
        maxAttempts: CONFIG.MAX_ATTEMPTS,
        duration,
        error: errorInfo,
        event: "NOTIFICATION_FINAL_FAILURE",
      },
      "Notification permanently failed after all retries exhausted",
    );

    // Metrics
    MetricsService.recordMetric("RETRY_EXHAUSTED", {
      notificationId,
      requestId,
      attempts: attemptsMade,
      maxAttempts,
    });
  }

  /**
   * Handle error with full flow
   */
  async handleError({
    notificationId,
    notification,
    err,
    attemptsMade,
    maxAttempts,
    duration,
    requestId,
    version,
  }) {
    // ✅ Ensure version is valid before proceeding
    const validVersion = await this.ensureVersion(notificationId, version);

    // Classify error
    const classification = ErrorClassifier.classify(err);

    // Log the error with full context
    logger.error(
      {
        err,
        notificationId,
        attempt: attemptsMade,
        maxAttempts,
        duration,
        requestId,
        classification,
        version: validVersion,
        event: "NOTIFICATION_ERROR",
      },
      "Notification processing error",
    );

    // Route to appropriate handler
    if (!classification.retryable) {
      await this.handlePermanent({
        notificationId,
        notification,
        err,
        attemptsMade,
        duration,
        requestId,
        version: validVersion, // ✅ Pass validated version
      });
      return;
    }

    if (RetryPolicy.shouldRetry(attemptsMade, maxAttempts)) {
      await this.handleRetryable({
        notificationId,
        notification,
        err,
        attemptsMade,
        maxAttempts,
        duration,
        requestId,
        version: validVersion, // ✅ Pass validated version
      });
      return;
    }

    await this.handleFinal({
      notificationId,
      notification,
      err,
      attemptsMade,
      maxAttempts,
      duration,
      requestId,
      version: validVersion, // ✅ Pass validated version
    });
  }

  /**
   * ✅ Ensure version is valid - reload if missing
   * This is the critical fix for the optimistic concurrency bug
   */
  async ensureVersion(notificationId, version) {
    // If version is already a valid number, return it
    if (version !== undefined && version !== null && typeof version === "number") {
      return version;
    }

    // If version is a string that can be parsed, try that
    if (typeof version === "string") {
      const parsed = parseInt(version, 10);
      if (!isNaN(parsed)) {
        logger.warn(
          {
            notificationId,
            originalVersion: version,
            parsedVersion: parsed,
            event: "VERSION_PARSED_FROM_STRING",
          },
          "Version was a string, parsed to number",
        );
        return parsed;
      }
    }

    // Version is missing or invalid - reload from database
    logger.warn(
      {
        notificationId,
        version,
        event: "VERSION_MISSING_RELOADING",
      },
      "Version is missing or invalid, reloading from database",
    );

    try {
      const reloaded = await NotificationRepository.getWithVersion(notificationId);

      if (reloaded && reloaded.__v !== undefined) {
        logger.info(
          {
            notificationId,
            reloadedVersion: reloaded.__v,
            event: "VERSION_RELOADED_SUCCESSFULLY",
          },
          "Version reloaded successfully from database",
        );
        return reloaded.__v;
      }

      // If the notification no longer exists, this is a critical error
      logger.error(
        {
          notificationId,
          event: "VERSION_RELOAD_FAILED_NOT_FOUND",
        },
        "Notification not found when reloading version",
      );

      // Return 0 as last resort - this should never happen in production
      return 0;
    } catch (error) {
      logger.error(
        {
          error: error.message,
          notificationId,
          event: "VERSION_RELOAD_ERROR",
        },
        "Error reloading version from database",
      );

      // Return 0 as fallback to prevent worker crash
      // This is a safety net - the optimistic concurrency will fail
      // and the operation will be retried
      return 0;
    }
  }

  /**
   * Get notification status for external callers
   */
  async getStatus(notificationId) {
    return NotificationRepository.getStatus(notificationId);
  }

  /**
   * Force retry a failed notification (admin operation)
   */
  async forceRetry(notificationId) {
    // Get current version
    const current = await NotificationRepository.getWithVersion(notificationId);
    if (!current) {
      throw new Error(`Notification not found: ${notificationId}`);
    }

    if (!NotificationStateMachine.isTerminal(current.status)) {
      throw new Error(`Notification is not in terminal state: ${current.status}`);
    }

    // Reset to queued state
    const update = {
      $set: {
        status: "queued",
        attempts: 0,
        lastAttempt: null,
        nextRetry: null,
        error: null,
        updatedAt: new Date(),
      },
      $inc: { __v: 1 },
    };

    return NotificationRepository.updateWithConcurrency(notificationId, update, current.__v);
  }
}

module.exports = new FailureHandler();
