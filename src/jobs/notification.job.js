"use strict";

const { NotificationLogger } = require("../logger/index");
const NotificationDispatcher = require("../services/notification/NotificationDispatcher");
const { RetryableError } = require("../utils/retryableErrors");
const CONFIG = require("../config/notification.config");

// Import refactored services
const LockManager = require("../services/NotificationJob/LockManager");
const NotificationRepository = require("../services/NotificationJob/NotificationRepository");
const NotificationValidator = require("../services/NotificationJob/NotificationValidator");
const FailureHandler = require("../services/NotificationJob/FailureHandler");
const MetricsService = require("../services/NotificationJob/MetricsService");
const ResponseSanitizer = require("../services/NotificationJob/ResponseSanitizer");
const NotificationStateMachine = require("../services/NotificationJob/NotificationStateMachine");

/**
 * NotificationJob - Pure Orchestration Layer
 * Single Responsibility: Coordinate the notification processing workflow
 * All logic is delegated to specialized services
 */
class NotificationJob {
  /**
   * Execute Notification with production-grade fault tolerance
   */
  async execute(notificationId, job = null) {
    const startedAt = Date.now();
    const requestId = job?.data?.requestId || notificationId;

    // === Phase 1: Lock Acquisition ===
    const lockResult = await LockManager.acquireLock(notificationId, job);
    if (!lockResult.acquired) {
      MetricsService.recordDuplicatePrevented(notificationId, lockResult.lockKey, requestId);
      NotificationLogger.warn(
        {
          notificationId,
          jobId: job?.id,
          requestId,
          event: "DUPLICATE_NOTIFICATION_SKIPPED",
        },
        "Duplicate notification skipped - lock already held",
      );
      return;
    }

    const { lockKey, lockToken, lockTTL } = lockResult;
    let notification = null;
    let lockRenewal = null;
    const abortController = new AbortController();

    try {
      // === Phase 2: Lock Renewal ===
      lockRenewal = LockManager.startRenewal(lockKey, lockTTL, lockToken, abortController);

      // === Phase 3: Acquire Notification ===
      const attemptsMade = job ? job.attemptsMade + 1 : 1;
      notification = await NotificationRepository.acquireForProcessing(
        notificationId,
        attemptsMade,
      );

      if (!notification) {
        const existing = await NotificationRepository.getWithVersion(notificationId);
        if (existing && NotificationStateMachine.isTerminal(existing.status)) {
          NotificationLogger.info(
            {
              notificationId,
              status: existing.status,
              requestId,
              event: "NOTIFICATION_ALREADY_TERMINAL",
            },
            "Notification already in terminal state",
          );
        } else {
          NotificationLogger.warn(
            {
              notificationId,
              requestId,
              event: "NOTIFICATION_ALREADY_PROCESSING",
            },
            "Notification is being processed by another worker",
          );
        }
        return;
      }

      // === Phase 4: Log Processing Start ===
      NotificationLogger.info(
        {
          notificationId,
          jobId: job?.id,
          attempt: notification.attempts,
          provider: notification.type,
          template: notification.template,
          source: notification.source,
          requestId: notification.requestId || requestId,
          event: "NOTIFICATION_PROCESSING_STARTED",
        },
        "Notification processing started",
      );

      MetricsService.recordProcessingStarted(
        notificationId,
        notification.type,
        notification.template,
        requestId,
      );

      // === Phase 5: Validate ===
      NotificationValidator.validate(notification);

      // === Phase 6: Dispatch ===
      const response = await this.dispatchWithCancellation(notification, abortController.signal);

      if (abortController.signal.aborted) {
        NotificationLogger.warn(
          {
            notificationId,
            requestId,
            event: "NOTIFICATION_CANCELLED_BEFORE_SUCCESS",
          },
          "Notification cancelled before success handling",
        );
        throw new RetryableError("Notification cancelled - will retry");
      }

      // === Phase 7: Mark Success ===
      const duration = Date.now() - startedAt;
      const sanitizedResponse = ResponseSanitizer.sanitizeProviderResponse(response);

      await NotificationRepository.markSent(
        notification._id,
        sanitizedResponse,
        duration,
        notification.attempts,
        notification.__v, // ✅ __v is present from acquireForProcessing
      );

      // === Phase 8: Log Success ===
      const finalDuration = Date.now() - startedAt;
      MetricsService.recordProviderLatency(
        notificationId,
        notification.type,
        finalDuration,
        requestId,
      );

      MetricsService.recordDeliverySuccess(
        notificationId,
        notification.type,
        finalDuration,
        requestId,
      );

      NotificationLogger.info(
        {
          notificationId,
          jobId: job?.id,
          provider: notification.type,
          template: notification.template,
          source: notification.source,
          duration: finalDuration,
          attempts: notification.attempts,
          requestId: notification.requestId || requestId,
          event: "NOTIFICATION_DELIVERED_SUCCESSFULLY",
        },
        "Notification delivered successfully",
      );

      return response;
    } catch (err) {
      // === Phase 9: Error Handling ===

      // Check cancellation
      if (err.message?.includes("cancelled") || err.message?.includes("aborted")) {
        NotificationLogger.warn(
          {
            notificationId,
            requestId,
            error: err.message,
            event: "NOTIFICATION_CANCELLED",
          },
          "Notification processing cancelled due to lock ownership loss",
        );
        throw new RetryableError("Notification cancelled - will retry");
      }

      // Stop lock renewal on error
      if (lockRenewal) {
        lockRenewal.stop();
        lockRenewal = null;
      }

      // ✅ FIX: Ensure notification is loaded with version for error handling
      if (!notification) {
        try {
          // ✅ Include __v and status in the projection
          notification = await NotificationRepository.findById(
            notificationId,
            "type template source recipient requestId attempts status __v",
          );
        } catch (fetchErr) {
          NotificationLogger.error(
            {
              err: fetchErr,
              notificationId,
              requestId,
              event: "NOTIFICATION_FETCH_FOR_ERROR_FAILED",
            },
            "Failed to fetch notification for error handling",
          );
        }
      }

      // ✅ FIX: If notification still doesn't have __v, reload it
      if (notification && notification.__v === undefined) {
        NotificationLogger.warn(
          {
            notificationId,
            event: "VERSION_MISSING_RELOADING",
          },
          "Version missing from notification, reloading with version",
        );

        const versionedNotification = await NotificationRepository.getWithVersion(notificationId);
        if (versionedNotification) {
          notification = {
            ...notification,
            __v: versionedNotification.__v,
            status: versionedNotification.status,
          };
        }
      }

      const duration = Date.now() - startedAt;
      const attemptsMade = job ? job.attemptsMade + 1 : notification?.attempts || 1;
      const maxAttempts = job?.opts?.attempts ?? CONFIG.MAX_ATTEMPTS;
      const requestIdForError = notification?.requestId || requestId || notificationId;

      // ✅ FIX: Ensure version is a number, fallback to 0 if still undefined
      let version = notification?.__v;
      if (version === undefined || version === null) {
        NotificationLogger.error(
          {
            notificationId,
            event: "VERSION_STILL_MISSING_USING_FALLBACK",
          },
          "Version still missing after reload, using fallback (this should not happen in production)",
        );
        version = 0;
      }

      // Delegate error handling
      await FailureHandler.handleError({
        notificationId,
        notification,
        err,
        attemptsMade,
        maxAttempts,
        duration,
        requestId: requestIdForError,
        version, // ✅ Now guaranteed to be a number
      });

      throw err;
    } finally {
      // === Phase 10: Cleanup ===

      if (abortController && !abortController.signal.aborted) {
        abortController.abort();
      }

      if (lockRenewal) {
        try {
          lockRenewal.stop();
          lockRenewal = null;
        } catch (clearErr) {
          // Ignore cleanup errors
        }
      }

      try {
        const releaseResult = await LockManager.releaseLock(lockKey, lockToken);
        if (!releaseResult.released) {
          NotificationLogger.warn(
            {
              notificationId,
              lockKey,
              requestId: requestId || notificationId,
              event: "LOCK_RELEASE_FAILED",
            },
            "Failed to release notification lock - manual cleanup may be needed",
          );
          MetricsService.recordLockReleaseFailed(
            notificationId,
            lockKey,
            requestId,
            "Lock release failed",
          );
        }
      } catch (releaseErr) {
        MetricsService.recordLockReleaseFailed(
          notificationId,
          lockKey,
          requestId,
          releaseErr.message,
        );
        NotificationLogger.error(
          {
            err: releaseErr,
            notificationId,
            lockKey,
            requestId: requestId || notificationId,
            event: "LOCK_RELEASE_FAILED",
          },
          "Failed to release notification lock - manual cleanup may be needed",
        );
      }
    }
  }

  /**
   * Dispatch with cancellation support
   */
  async dispatchWithCancellation(notification, cancellationToken) {
    const cancellationPromise = new Promise((_, reject) => {
      cancellationToken.addEventListener("abort", () => {
        reject(new Error("Operation cancelled"));
      });
    });

    const dispatchPromise = NotificationDispatcher.dispatch(notification);
    return Promise.race([dispatchPromise, cancellationPromise]);
  }

  /**
   * Get notification status with full context
   * Delegated to admin service
   */
  async getNotificationStatus(notificationId) {
    const NotificationAdminService = require("../services/NotificationAdminService");
    return NotificationAdminService.getStatus(notificationId);
  }

  /**
   * Manually retry a failed notification (admin operation)
   * Delegated to admin service
   */
  async manualRetry(notificationId) {
    const NotificationAdminService = require("../services/NotificationAdminService");
    return NotificationAdminService.manualRetry(notificationId);
  }

  /**
   * Bulk retry failed notifications (admin operation)
   * Delegated to admin service
   */
  async bulkRetry(filter = {}, limit = 100) {
    const NotificationAdminService = require("../services/NotificationAdminService");
    return NotificationAdminService.bulkRetry(filter, limit);
  }

  /**
   * Get notification statistics
   * Delegated to admin service
   */
  async getStats(filter = {}) {
    const NotificationAdminService = require("../services/NotificationAdminService");
    return NotificationAdminService.getStats(filter);
  }
}

// Export singleton instance
module.exports = new NotificationJob();
