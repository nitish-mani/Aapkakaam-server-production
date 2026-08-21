"use strict";

const { NotificationLogger } = require("../logger/index");

const NotificationDispatcher = require("../services/notification/NotificationDispatcher");

const { RetryableError } = require("../utils/retryableErrors");

const CONFIG = require("../config/notification.config");

// ============================================================
// REFACTORED SERVICES
// ============================================================

const LockManager = require("../services/NotificationJob/LockManager");

const NotificationRepository = require("../services/NotificationJob/NotificationRepository");

const NotificationValidator = require("../services/NotificationJob/NotificationValidator");

const FailureHandler = require("../services/NotificationJob/FailureHandler");

const MetricsService = require("../services/NotificationJob/MetricsService");

const ResponseSanitizer = require("../services/NotificationJob/ResponseSanitizer");

const NotificationStateMachine = require("../services/NotificationJob/NotificationStateMachine");

// ============================================================
// NOTIFICATION JOB
// ============================================================

class NotificationJob {
  /**
   * Execute notification.
   *
   * Architecture:
   *
   * BullMQ
   *   ↓
   * NotificationJob
   *   ↓
   * Lock
   *   ↓
   * Mongo notification claim
   *   ↓
   * Validation
   *   ↓
   * NotificationDispatcher
   *   ↓
   * PUSH
   *   ↓ failure
   * WHATSAPP
   *   ↓ failure
   * SMS
   *   ↓
   * Mark SENT
   *
   * The Dispatcher owns channel fallback.
   * This class owns job lifecycle/state management.
   */
  async execute(notificationId, job = null) {
    const startedAt = Date.now();

    const requestId = job?.data?.requestId || notificationId;

    // ==========================================================
    // PHASE 1
    // LOCK ACQUISITION
    // ==========================================================

    const lockResult = await LockManager.acquireLock(notificationId, job);

    // ==========================================================
    // ANOTHER WORKER OWNS THIS NOTIFICATION
    // ==========================================================

    if (!lockResult.acquired) {
      MetricsService.recordDuplicatePrevented(notificationId, lockResult.lockKey, requestId);

      NotificationLogger.warn(
        {
          notificationId,

          jobId: job?.id,

          requestId,

          lockKey: lockResult.lockKey,

          event: "DUPLICATE_NOTIFICATION_SKIPPED",
        },

        "Duplicate notification skipped - lock already held",
      );

      /**
       * IMPORTANT:
       *
       * Do NOT throw here.
       *
       * The other worker owns the notification and
       * is already processing it.
       *
       * Throwing would make BullMQ retry the same job
       * unnecessarily.
       */
      return {
        skipped: true,

        reason: "LOCK_ALREADY_HELD",

        notificationId,
      };
    }

    // ==========================================================
    // LOCK INFORMATION
    // ==========================================================

    const { lockKey, lockToken, lockTTL } = lockResult;

    let notification = null;

    let lockRenewal = null;

    const abortController = new AbortController();

    try {
      // ========================================================
      // PHASE 2
      // LOCK RENEWAL
      // ========================================================

      lockRenewal = LockManager.startRenewal(lockKey, lockTTL, lockToken, abortController);

      // ========================================================
      // PHASE 3
      // ACQUIRE NOTIFICATION
      // ========================================================

      const attemptsMade = job ? job.attemptsMade + 1 : 1;

      notification = await NotificationRepository.acquireForProcessing(
        notificationId,
        attemptsMade,
      );

      // ========================================================
      // NOTIFICATION COULD NOT BE CLAIMED
      // ========================================================

      if (!notification) {
        const existing = await NotificationRepository.getWithVersion(notificationId);

        // ------------------------------------------------------
        // TERMINAL
        // ------------------------------------------------------

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

          return {
            skipped: true,

            reason: "ALREADY_TERMINAL",

            notificationId,

            status: existing.status,
          };
        }

        // ------------------------------------------------------
        // CURRENTLY PROCESSING
        // ------------------------------------------------------

        NotificationLogger.warn(
          {
            notificationId,

            jobId: job?.id,

            requestId,

            status: existing?.status,

            event: "NOTIFICATION_ALREADY_PROCESSING",
          },

          "Notification is being processed by another worker",
        );

        return {
          skipped: true,

          reason: "ALREADY_PROCESSING",

          notificationId,
        };
      }

      // ========================================================
      // PHASE 4
      // PROCESSING START
      // ========================================================

      NotificationLogger.info(
        {
          notificationId,

          jobId: job?.id,

          attempt: notification.attempts,

          businessType: notification.type,

          channel: notification.channel,

          channelIndex: notification.channelIndex,

          channelPolicy: notification.channelPolicy,

          template: notification.template,

          source: notification.source,

          requestId: notification.requestId || requestId,

          event: "NOTIFICATION_PROCESSING_STARTED",
        },

        "Notification processing started",
      );

      // ========================================================
      // METRICS
      // ========================================================

      MetricsService.recordProcessingStarted(
        notificationId,

        notification.type,

        notification.template,

        requestId,
      );

      // ========================================================
      // PHASE 5
      // VALIDATE
      // ========================================================

      NotificationValidator.validate(notification);

      // ========================================================
      // PHASE 6
      // DISPATCH
      // ========================================================
      //
      // IMPORTANT:
      //
      // NotificationDispatcher handles:
      //
      // PUSH
      //   ↓ failure
      // WHATSAPP
      //   ↓ failure
      // SMS
      //
      // So NotificationJob should NOT manually call
      // each provider.
      //
      // ========================================================

      const response = await this.dispatchWithCancellation(notification, abortController.signal);

      // ========================================================
      // CHECK LOCK/CANCELLATION
      // ========================================================

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

      // ========================================================
      // PHASE 7
      // MARK SUCCESS
      // ========================================================

      const duration = Date.now() - startedAt;

      const sanitizedResponse = ResponseSanitizer.sanitizeProviderResponse(response);

      await NotificationRepository.markSent(
        notification._id,

        sanitizedResponse,

        duration,

        notification.attempts,

        notification.__v,
      );

      // ========================================================
      // PHASE 8
      // SUCCESS METRICS
      // ========================================================

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

      // ========================================================
      // SUCCESS LOG
      // ========================================================

      NotificationLogger.info(
        {
          notificationId,

          jobId: job?.id,

          businessType: notification.type,

          deliveredChannel: notification.channel,

          channelIndex: notification.channelIndex,

          channelPolicy: notification.channelPolicy,

          template: notification.template,

          source: notification.source,

          duration: finalDuration,

          attempts: notification.attempts,

          requestId: notification.requestId || requestId,

          event: "NOTIFICATION_DELIVERED_SUCCESSFULLY",
        },

        "Notification delivered successfully",
      );

      // ========================================================
      // RETURN
      // ========================================================

      return {
        success: true,

        notificationId,

        channel: notification.channel,

        businessType: notification.type,

        response: sanitizedResponse,
      };
    } catch (err) {
      // ========================================================
      // PHASE 9
      // ERROR HANDLING
      // ========================================================

      // ========================================================
      // CANCELLATION / LOCK LOSS
      // ========================================================

      if (
        err?.message?.toLowerCase().includes("cancelled") ||
        err?.message?.toLowerCase().includes("aborted")
      ) {
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

      // ========================================================
      // STOP LOCK RENEWAL
      // ========================================================

      if (lockRenewal) {
        try {
          lockRenewal.stop();
        } catch (stopError) {
          NotificationLogger.warn(
            {
              notificationId,

              err: stopError,
            },

            "Failed to stop notification lock renewal",
          );
        }

        lockRenewal = null;
      }

      // ========================================================
      // LOAD NOTIFICATION FOR ERROR HANDLING
      // ========================================================

      if (!notification) {
        try {
          notification = await NotificationRepository.findById(
            notificationId,

            "type template source recipient requestId attempts status __v channel channelIndex channelPolicy",
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

      // ========================================================
      // ENSURE VERSION
      // ========================================================

      if (notification && notification.__v === undefined) {
        NotificationLogger.warn(
          {
            notificationId,

            event: "VERSION_MISSING_RELOADING",
          },

          "Version missing from notification, reloading with version",
        );

        try {
          const versionedNotification = await NotificationRepository.getWithVersion(notificationId);

          if (versionedNotification) {
            notification = versionedNotification;
          }
        } catch (reloadError) {
          NotificationLogger.error(
            {
              err: reloadError,

              notificationId,

              requestId,

              event: "NOTIFICATION_VERSION_RELOAD_FAILED",
            },

            "Failed to reload notification with version",
          );
        }
      }

      // ========================================================
      // ERROR CONTEXT
      // ========================================================

      const duration = Date.now() - startedAt;

      const attemptsMade = job ? job.attemptsMade + 1 : notification?.attempts || 1;

      const maxAttempts = job?.opts?.attempts ?? CONFIG.MAX_ATTEMPTS;

      const requestIdForError = notification?.requestId || requestId || notificationId;

      // ========================================================
      // VERSION
      // ========================================================

      let version = notification?.__v;

      if (version === undefined || version === null) {
        NotificationLogger.error(
          {
            notificationId,

            event: "VERSION_STILL_MISSING_USING_FALLBACK",
          },

          "Version still missing after reload, using fallback",
        );

        version = 0;
      }

      // ========================================================
      // FAILURE HANDLER
      // ========================================================

      try {
        await FailureHandler.handleError({
          notificationId,

          notification,

          err,

          attemptsMade,

          maxAttempts,

          duration,

          requestId: requestIdForError,

          version,
        });
      } catch (failureHandlerError) {
        NotificationLogger.error(
          {
            err: failureHandlerError,

            originalError: err,

            notificationId,

            requestId: requestIdForError,

            event: "NOTIFICATION_FAILURE_HANDLER_FAILED",
          },

          "Notification failure handler failed",
        );
      }

      // ========================================================
      // RE-THROW
      // ========================================================
      //
      // BullMQ needs the error so that its retry mechanism
      // can handle the job if the complete notification
      // delivery failed.
      //
      // ========================================================

      throw err;
    } finally {
      // ========================================================
      // PHASE 10
      // CLEANUP
      // ========================================================

      // ========================================================
      // ABORT
      // ========================================================

      if (abortController && !abortController.signal.aborted) {
        abortController.abort();
      }

      // ========================================================
      // STOP LOCK RENEWAL
      // ========================================================

      if (lockRenewal) {
        try {
          lockRenewal.stop();

          lockRenewal = null;
        } catch (clearErr) {
          NotificationLogger.warn(
            {
              err: clearErr,

              notificationId,

              event: "LOCK_RENEWAL_STOP_FAILED",
            },

            "Failed to stop notification lock renewal",
          );
        }
      }

      // ========================================================
      // RELEASE LOCK
      // ========================================================

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

  // ============================================================
  // DISPATCH WITH CANCELLATION
  // ============================================================

  /**
   * Dispatch with cancellation support.
   *
   * The dispatcher itself handles:
   *
   * PUSH
   *   ↓ failure
   * WHATSAPP
   *   ↓ failure
   * SMS
   *
   * This method only adds cancellation support.
   */
  async dispatchWithCancellation(notification, cancellationToken) {
    const cancellationPromise = new Promise((_, reject) => {
      cancellationToken.addEventListener(
        "abort",
        () => {
          reject(new Error("Operation cancelled"));
        },
        {
          once: true,
        },
      );
    });

    const dispatchPromise = NotificationDispatcher.dispatch(notification);

    return Promise.race([dispatchPromise, cancellationPromise]);
  }

  // ============================================================
  // ADMIN
  // ============================================================

  /**
   * Get notification status.
   */
  async getNotificationStatus(notificationId) {
    const NotificationAdminService = require("../services/NotificationAdminService");

    return NotificationAdminService.getStatus(notificationId);
  }

  /**
   * Manually retry notification.
   */
  async manualRetry(notificationId) {
    const NotificationAdminService = require("../services/NotificationAdminService");

    return NotificationAdminService.manualRetry(notificationId);
  }

  /**
   * Bulk retry failed notifications.
   */
  async bulkRetry(filter = {}, limit = 100) {
    const NotificationAdminService = require("../services/NotificationAdminService");

    return NotificationAdminService.bulkRetry(filter, limit);
  }

  /**
   * Get notification statistics.
   */
  async getStats(filter = {}) {
    const NotificationAdminService = require("../services/NotificationAdminService");

    return NotificationAdminService.getStats(filter);
  }
}

// ============================================================
// EXPORT SINGLETON
// ============================================================

module.exports = new NotificationJob();
