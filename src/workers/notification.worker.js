"use strict";

const { Worker } = require("bullmq");

const { connection } = require("../config/bullmq");
const NotificationJob = require("../jobs/notification.job");
const { WorkerLogger } = require("../logger/index");

const QUEUE_NAME = "notification";

const WORKER_CONCURRENCY = Math.max(1, Number(process.env.NOTIFICATION_WORKER_CONCURRENCY) || 10);

const notificationWorker = new Worker(
  QUEUE_NAME,

  async (job) => {
    const startTime = Date.now();

    const notificationId = job.data?.notificationId;

    if (!notificationId) {
      throw new Error("Notification job is missing notificationId");
    }

    WorkerLogger.debug(
      {
        queue: QUEUE_NAME,
        jobId: job.id,
        notificationId,
        attempt: job.attemptsMade + 1,
      },
      "Processing notification job",
    );

    try {
      await NotificationJob.execute(notificationId, job);

      WorkerLogger.info(
        {
          queue: QUEUE_NAME,
          jobId: job.id,
          notificationId,
          duration: Date.now() - startTime,
        },
        "Notification processed successfully",
      );
    } catch (err) {
      WorkerLogger.error(
        {
          queue: QUEUE_NAME,
          jobId: job.id,
          notificationId,
          attempt: job.attemptsMade + 1,
          duration: Date.now() - startTime,
          err,
        },
        "Notification processing failed",
      );

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

/**
 * Worker Events
 */

notificationWorker.on("ready", () => {
  WorkerLogger.info(
    {
      queue: QUEUE_NAME,
      concurrency: WORKER_CONCURRENCY,
    },
    "Notification worker is ready",
  );
});

notificationWorker.on("active", (job) => {
  WorkerLogger.debug(
    {
      queue: QUEUE_NAME,
      jobId: job.id,
      notificationId: job.data?.notificationId,
    },
    "Notification job started",
  );
});

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

notificationWorker.on("error", (err) => {
  WorkerLogger.error(
    {
      queue: QUEUE_NAME,
      err,
    },
    "Notification worker error",
  );
});

/**
 * Graceful Shutdown
 */

let shuttingDown = false;

async function shutdown() {
  if (shuttingDown) return;

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

module.exports = notificationWorker;
