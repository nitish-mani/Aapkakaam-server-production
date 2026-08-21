"use strict";

const { Queue, QueueEvents } = require("bullmq");

const { connection } = require("../config/bullmq");

const { NotificationLogger } = require("../logger/index");

// ============================================================
// CONSTANTS
// ============================================================

const QUEUE_NAME = "notification";

const DEFAULT_ATTEMPTS = Math.max(1, Number(process.env.NOTIFICATION_QUEUE_ATTEMPTS) || 5);

const DEFAULT_RETRY_DELAY = Math.max(
  1000,
  Number(process.env.NOTIFICATION_QUEUE_RETRY_DELAY) || 5000,
);

// ============================================================
// QUEUE
// ============================================================

const notificationQueue = new Queue(QUEUE_NAME, {
  connection,

  defaultJobOptions: {
    attempts: DEFAULT_ATTEMPTS,

    backoff: {
      type: "exponential",

      delay: DEFAULT_RETRY_DELAY,
    },

    removeOnComplete: {
      age: 24 * 60 * 60,

      count: 1000,
    },

    removeOnFail: {
      age: 7 * 24 * 60 * 60,

      count: 5000,
    },

    stackTraceLimit: 10,
  },
});

NotificationLogger.info(
  {
    queue: QUEUE_NAME,

    attempts: DEFAULT_ATTEMPTS,
  },

  "Notification Queue initialized",
);

// ============================================================
// QUEUE EVENTS
// ============================================================

const queueEvents = new QueueEvents(QUEUE_NAME, {
  connection,
});

// ============================================================
// STALLED
// ============================================================

queueEvents.on("stalled", ({ jobId }) => {
  NotificationLogger.warn(
    {
      queue: QUEUE_NAME,

      jobId,
    },

    "Notification job stalled",
  );
});

// ============================================================
// QUEUE EVENTS ERROR
// ============================================================

queueEvents.on("error", (err) => {
  NotificationLogger.error(
    {
      queue: QUEUE_NAME,

      err,
    },

    "QueueEvents error",
  );
});

// ============================================================
// ADD SINGLE NOTIFICATION JOB
// ============================================================

async function addNotificationJob(data, options = {}) {
  if (!data?.notificationId) {
    throw new Error("notificationId is required to queue a notification");
  }

  const notificationId = String(data.notificationId);

  /**
   * IMPORTANT
   *
   * Normal notification:
   *
   *     notification:<notificationId>
   *
   * Outbox notification:
   *
   *     notification:outbox:<outboxId>
   *
   * If an outbox job is retried, the same BullMQ jobId
   * prevents duplicate queue jobs.
   */

  const jobId = options.jobId || `notification:${notificationId}`;

  const priority = options.priority ?? 5;

  const delay = options.delay ?? 0;

  const jobOptions = {
    ...options,

    priority,

    delay,

    jobId,
  };

  try {
    const job = await notificationQueue.add(
      "send-notification",

      {
        notificationId,
      },

      jobOptions,
    );

    NotificationLogger.debug(
      {
        queue: QUEUE_NAME,

        jobId: job.id,

        notificationId,

        outboxId: data.outboxId || null,

        priority,

        delay,
      },

      "Notification job added",
    );

    return job;
  } catch (error) {
    NotificationLogger.error(
      {
        queue: QUEUE_NAME,

        notificationId,

        outboxId: data.outboxId || null,

        jobId,

        err: error,
      },

      "Failed to add notification job",
    );

    throw error;
  }
}

// ============================================================
// ADD BULK NOTIFICATION JOBS
// ============================================================

async function addBulkNotificationJobs(jobs = []) {
  if (!Array.isArray(jobs)) {
    throw new TypeError("Notification jobs must be an array");
  }

  if (jobs.length === 0) {
    return [];
  }

  const normalizedJobs = jobs.map((job, index) => {
    if (!job?.data?.notificationId) {
      throw new Error(`notificationId is required for notification job at index ${index}`);
    }

    const notificationId = String(job.data.notificationId);

    const outboxId = job.data.outboxId || null;

    const jobId =
      job.jobId ||
      job.opts?.jobId ||
      (outboxId ? `notification:outbox:${String(outboxId)}` : `notification:${notificationId}`);

    return {
      name: "send-notification",

      data: {
        notificationId,
      },

      opts: {
        ...(job.opts || {}),

        priority: job.priority ?? job.opts?.priority ?? 5,

        delay: job.delay ?? job.opts?.delay ?? 0,

        jobId,
      },
    };
  });

  try {
    const result = await notificationQueue.addBulk(normalizedJobs);

    NotificationLogger.debug(
      {
        queue: QUEUE_NAME,

        count: result.length,
      },

      "Bulk notification jobs added",
    );

    return result;
  } catch (error) {
    NotificationLogger.error(
      {
        queue: QUEUE_NAME,

        count: normalizedJobs.length,

        err: error,
      },

      "Failed to add bulk notification jobs",
    );

    throw error;
  }
}

// ============================================================
// GET QUEUE STATS
// ============================================================

async function getQueueStats() {
  const [waiting, active, completed, failed, delayed] = await Promise.all([
    notificationQueue.getWaitingCount(),

    notificationQueue.getActiveCount(),

    notificationQueue.getCompletedCount(),

    notificationQueue.getFailedCount(),

    notificationQueue.getDelayedCount(),
  ]);

  return {
    waiting,
    active,
    completed,
    failed,
    delayed,
  };
}

// ============================================================
// HEALTH CHECK
// ============================================================

async function isHealthy() {
  try {
    const client = await notificationQueue.client;

    const pong = await client.ping();

    return pong === "PONG";
  } catch (err) {
    NotificationLogger.error(
      {
        queue: QUEUE_NAME,

        err,
      },

      "Notification Queue health check failed",
    );

    return false;
  }
}

// ============================================================
// PAUSE
// ============================================================

async function pause() {
  await notificationQueue.pause();

  NotificationLogger.warn(
    {
      queue: QUEUE_NAME,
    },

    "Notification Queue Paused",
  );
}

// ============================================================
// RESUME
// ============================================================

async function resume() {
  await notificationQueue.resume();

  NotificationLogger.info(
    {
      queue: QUEUE_NAME,
    },

    "Notification Queue Resumed",
  );
}

// ============================================================
// GRACEFUL SHUTDOWN
// ============================================================

let shuttingDown = false;

async function shutdown() {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  NotificationLogger.info(
    {
      queue: QUEUE_NAME,
    },

    "Closing Notification Queue...",
  );

  try {
    queueEvents.removeAllListeners();

    await queueEvents.close();

    await notificationQueue.close();

    NotificationLogger.info(
      {
        queue: QUEUE_NAME,
      },

      "Notification Queue Closed",
    );
  } catch (err) {
    NotificationLogger.error(
      {
        queue: QUEUE_NAME,

        err,
      },

      "Failed to shutdown Notification Queue",
    );
  }
}

// ============================================================
// PROCESS SIGNALS
// ============================================================

process.on("SIGINT", shutdown);

process.on("SIGTERM", shutdown);

// ============================================================
// EXPORT
// ============================================================

module.exports = Object.freeze({
  notificationQueue,

  addNotificationJob,

  addBulkNotificationJobs,

  getQueueStats,

  pause,

  resume,

  isHealthy,

  shutdown,
});
