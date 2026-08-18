"use strict";

const { Queue, QueueEvents } = require("bullmq");
const { connection } = require("../config/bullmq");
const { NotificationLogger } = require("../logger/index");

const QUEUE_NAME = "notification";

const notificationQueue = new Queue(QUEUE_NAME, {
  connection,

  defaultJobOptions: {
    attempts: 5,

    backoff: {
      type: "exponential",
      delay: 5000,
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
  },
  "Notification Queue initialized",
);
const queueEvents = new QueueEvents(QUEUE_NAME, {
  connection,
});

/**
 * Queue Event Listeners
 */
queueEvents.on("completed", ({ jobId }) => {
  NotificationLogger.info(
    {
      queue: QUEUE_NAME,
      jobId,
    },
    "Notification job completed",
  );
});

queueEvents.on("failed", ({ jobId, failedReason }) => {
  NotificationLogger.error(
    {
      queue: QUEUE_NAME,
      jobId,
      failedReason,
    },
    "Notification job failed",
  );
});

queueEvents.on("stalled", ({ jobId }) => {
  NotificationLogger.warn(
    {
      queue: QUEUE_NAME,
      jobId,
    },
    "Notification job stalled",
  );
});

queueEvents.on("waiting", ({ jobId }) => {
  NotificationLogger.debug(
    {
      queue: QUEUE_NAME,
      jobId,
    },
    "Notification waiting",
  );
});

queueEvents.on("active", ({ jobId }) => {
  NotificationLogger.debug(
    {
      queue: QUEUE_NAME,
      jobId,
    },
    "Notification processing",
  );
});

queueEvents.on("error", (err) => {
  NotificationLogger.error(
    {
      queue: QUEUE_NAME,
      err,
    },
    "QueueEvents error",
  );
});

/**
 * Add Job
 */
async function addNotificationJob(data, options = {}) {
  if (!data?.notificationId) {
    throw new Error("notificationId is required to queue a notification");
  }

  const job = await notificationQueue.add("send-notification", data, {
    ...options,

    priority: options.priority ?? 5,

    delay: options.delay ?? 0,

    jobId: options.jobId ?? String(data.notificationId),
  });

  return job;
}

/**
 * Add Multiple Jobs
 */
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

    return {
      name: "send-notification",

      data: job.data,

      opts: {
        ...(job.opts || {}),

        priority: job.priority ?? job.opts?.priority ?? 5,

        delay: job.delay ?? job.opts?.delay ?? 0,

        jobId: job.jobId ?? job.opts?.jobId ?? String(job.data.notificationId),
      },
    };
  });

  return notificationQueue.addBulk(normalizedJobs);
}

/**
 * Queue Stats
 */
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

/**
 * Health Check
 */
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

/**
 * Pause Queue
 */
async function pause() {
  await notificationQueue.pause();

  NotificationLogger.warn("Notification Queue Paused");
}

/**
 * Resume Queue
 */
async function resume() {
  await notificationQueue.resume();

  NotificationLogger.info("Notification Queue Resumed");
}

/**
 * Graceful Shutdown
 */
let shuttingDown = false;

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;

  NotificationLogger.info("Closing Notification Queue...");

  try {
    queueEvents.removeAllListeners();

    await queueEvents.close();
    await notificationQueue.close();

    NotificationLogger.info("Notification Queue Closed");
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

process.on("SIGINT", shutdown);

process.on("SIGTERM", shutdown);

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
