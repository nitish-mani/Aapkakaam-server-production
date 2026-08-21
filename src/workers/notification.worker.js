"use strict";

const { Worker } = require("bullmq");

const { connection } = require("../config/bullmq");

const NotificationJob = require("../jobs/notification.job");

const { WorkerLogger } = require("../logger/index");

const { PermanentError } = require("../utils/retryableErrors");

const QUEUE_NAME = "notification";

const WORKER_CONCURRENCY = Math.max(1, Number(process.env.NOTIFICATION_WORKER_CONCURRENCY) || 10);

// ============================================================
// WORKER
// ============================================================

const notificationWorker = new Worker(
  QUEUE_NAME,

  async (job) => {
    const startTime = Date.now();

    const notificationId = job.data?.notificationId;

    if (!notificationId) {
      throw new Error("Notification job is missing notificationId");
    }

    const attempt = job.attemptsMade + 1;

    WorkerLogger.debug(
      {
        queue: QUEUE_NAME,

        jobId: job.id,

        notificationId,

        attempt,
      },

      "Processing notification job",
    );

    try {
      // ========================================================
      // EXECUTE
      // ========================================================

      const result = await NotificationJob.execute(notificationId, job);

      // ========================================================
      // SUCCESS / SKIPPED
      // ========================================================

      WorkerLogger.info(
        {
          queue: QUEUE_NAME,

          jobId: job.id,

          notificationId,

          duration: Date.now() - startTime,

          result: result || null,
        },

        "Notification processed successfully",
      );

      return result;
    } catch (err) {
      // ========================================================
      // PERMANENT ERROR
      // ========================================================
      //
      // IMPORTANT:
      //
      // PermanentError means:
      //
      //   Do NOT let BullMQ retry.
      //
      // Examples:
      //
      //   invalid notification type
      //   invalid channel
      //   missing required recipient
      //   expired notification
      //   invalid template/config
      //
      // FailureHandler inside NotificationJob is responsible
      // for marking the notification as failed.
      //
      // ========================================================

      if (err instanceof PermanentError) {
        WorkerLogger.error(
          {
            queue: QUEUE_NAME,

            jobId: job.id,

            notificationId,

            attempt,

            duration: Date.now() - startTime,

            permanent: true,

            err,
          },

          "Permanent notification error - BullMQ retry skipped",
        );

        /**
         * Returning a result makes BullMQ consider the job
         * completed instead of failed.
         */
        return {
          success: false,

          permanent: true,

          notificationId,

          reason: err.message,
        };
      }

      // ========================================================
      // RETRYABLE / UNKNOWN ERROR
      // ========================================================

      WorkerLogger.error(
        {
          queue: QUEUE_NAME,

          jobId: job.id,

          notificationId,

          attempt,

          duration: Date.now() - startTime,

          permanent: false,

          err,
        },

        "Notification processing failed - BullMQ will retry",
      );

      /**
       * IMPORTANT:
       *
       * Throwing tells BullMQ:
       *
       *   This job failed.
       *
       * BullMQ then applies:
       *
       *   attempts
       *   backoff
       *   retry
       */
      throw err;
    }
  },

  {
    connection,

    concurrency: WORKER_CONCURRENCY,

    limiter: {
      max: 100,

      duration: 1000,
    },
  },
);

// ============================================================
// READY
// ============================================================

notificationWorker.on("ready", () => {
  WorkerLogger.info(
    {
      queue: QUEUE_NAME,

      concurrency: WORKER_CONCURRENCY,
    },

    "Notification worker is ready",
  );
});

// ============================================================
// ACTIVE
// ============================================================

notificationWorker.on("active", (job) => {
  WorkerLogger.debug(
    {
      queue: QUEUE_NAME,

      jobId: job.id,

      notificationId: job.data?.notificationId,

      attempt: job.attemptsMade + 1,
    },

    "Notification job started",
  );
});

// ============================================================
// COMPLETED
// ============================================================

notificationWorker.on("completed", (job) => {
  WorkerLogger.info(
    {
      queue: QUEUE_NAME,

      jobId: job.id,

      notificationId: job.data?.notificationId,
    },

    "Notification job completed",
  );
});

// ============================================================
// FAILED
// ============================================================

notificationWorker.on("failed", (job, err) => {
  WorkerLogger.error(
    {
      queue: QUEUE_NAME,

      jobId: job?.id,

      notificationId: job?.data?.notificationId,

      attemptsMade: job?.attemptsMade,

      err,
    },

    "Notification job failed",
  );
});

// ============================================================
// WORKER ERROR
// ============================================================

notificationWorker.on("error", (err) => {
  WorkerLogger.error(
    {
      queue: QUEUE_NAME,

      err,
    },

    "Notification worker error",
  );
});

// ============================================================
// GRACEFUL SHUTDOWN
// ============================================================

let shuttingDown = false;

async function shutdown() {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  WorkerLogger.info(
    {
      queue: QUEUE_NAME,
    },

    "Shutting down notification worker...",
  );

  try {
    await notificationWorker.close();

    WorkerLogger.info(
      {
        queue: QUEUE_NAME,
      },

      "Notification worker stopped",
    );
  } catch (err) {
    WorkerLogger.error(
      {
        queue: QUEUE_NAME,

        err,
      },

      "Failed to shutdown notification worker",
    );
  }
}

process.on("SIGINT", shutdown);

process.on("SIGTERM", shutdown);

// ============================================================
// UNCAUGHT EXCEPTION
// ============================================================

process.on("uncaughtException", (err) => {
  WorkerLogger.fatal(
    {
      queue: QUEUE_NAME,

      err,
    },

    "Uncaught exception in notification worker",
  );

  shutdown().finally(() => process.exit(1));
});

// ============================================================
// UNHANDLED REJECTION
// ============================================================

process.on("unhandledRejection", (reason) => {
  WorkerLogger.fatal(
    {
      queue: QUEUE_NAME,

      reason,
    },

    "Unhandled promise rejection in notification worker",
  );

  shutdown().finally(() => process.exit(1));
});

// ============================================================
// EXPORT
// ============================================================

module.exports = notificationWorker;
