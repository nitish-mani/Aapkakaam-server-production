"use strict";

const { Worker } = require("bullmq");

const { connection } = require("../config/bullmq");

const Vendor = require("../../models/vendor");
const User = require("../../models/user");

const NotificationService = require("../services/NotificationService");
const { WorkerLogger } = require("../logger/index");

const QUEUE_NAME = "low-balance";

// ============================================================
// Balance thresholds
// ============================================================

// Vendor threshold comes from .env
// Example:
// LOW_BALANCE_THRESHOLD=100
const VENDOR_LOW_BALANCE_THRESHOLD = Number(process.env.LOW_BALANCE_THRESHOLD) || 100;

// User threshold is fixed at ₹30
const USER_LOW_BALANCE_THRESHOLD = 30;

/**
 * ============================================================
 * Get current calendar date in Asia/Kolkata
 * ============================================================
 *
 * Example:
 * 2026-08-19
 *
 * IMPORTANT:
 * Do not use:
 *
 * new Date().toISOString().slice(0, 10)
 *
 * because that uses UTC.
 */
function getISTDateKey() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

const worker = new Worker(
  QUEUE_NAME,

  async (job) => {
    const started = Date.now();

    const dateKey = getISTDateKey();

    WorkerLogger.info(
      {
        queue: QUEUE_NAME,
        jobId: job.id,

        vendorThreshold: VENDOR_LOW_BALANCE_THRESHOLD,
        userThreshold: USER_LOW_BALANCE_THRESHOLD,

        dateKey,
      },
      "Starting low balance check",
    );

    let vendorsFound = 0;
    let usersFound = 0;

    let notificationsQueued = 0;
    let notificationsSkipped = 0;
    let notificationsFailed = 0;

    // ============================================================
    // VENDORS
    // ============================================================

    const vendors = await Vendor.find({
      status: "active",

      balance: {
        $lt: VENDOR_LOW_BALANCE_THRESHOLD,
      },

      fcmToken: {
        $exists: true,
        $nin: [null, ""],
      },
    })
      .select("_id name phoneNo balance fcmToken")
      .lean();

    vendorsFound = vendors.length;

    WorkerLogger.info(
      {
        queue: QUEUE_NAME,
        jobId: job.id,
        dateKey,
        vendorsFound,
        threshold: VENDOR_LOW_BALANCE_THRESHOLD,
      },
      "Low balance vendors found",
    );

    // ============================================================
    // Send vendor notifications
    // ============================================================

    for (const vendor of vendors) {
      const vendorId = vendor._id.toString();

      try {
        const pushToken = String(vendor.fcmToken || "").trim();

        // --------------------------------------------------------
        // Validate FCM token
        // --------------------------------------------------------

        if (!pushToken) {
          notificationsSkipped++;

          WorkerLogger.warn(
            {
              queue: QUEUE_NAME,
              jobId: job.id,
              vendorId,
              balance: vendor.balance,
              reason: "FCM_TOKEN_MISSING",
            },
            "Vendor low balance notification skipped",
          );

          continue;
        }

        // --------------------------------------------------------
        // One notification per vendor per IST day
        // --------------------------------------------------------

        const idempotencyKey = `low-balance:vendor:${vendorId}:${dateKey}`;

        WorkerLogger.debug(
          {
            queue: QUEUE_NAME,
            jobId: job.id,
            vendorId,
            balance: vendor.balance,
            dateKey,
            idempotencyKey,
          },
          "Queueing vendor low balance notification",
        );

        // --------------------------------------------------------
        // Queue vendor push notification
        // --------------------------------------------------------

        const notification = await NotificationService.sendPush({
          vendorId,

          pushToken,

          template: "low_balance",

          templateData: {
            title: "Low Wallet Balance",

            body:
              `Your wallet balance is ₹${vendor.balance}. ` +
              `Please recharge your wallet to continue receiving bookings.`,

            type: "low_balance",

            screen: "profile",

            data: {
              vendorId,
              balance: String(vendor.balance),
            },
          },

          source: "system",

          sourceId: vendorId,

          priority: 3,

          tags: ["wallet", "low_balance", "vendor"],

          idempotencyKey,
        });

        notificationsQueued++;

        WorkerLogger.info(
          {
            queue: QUEUE_NAME,
            jobId: job.id,
            vendorId,
            balance: vendor.balance,

            notificationId: notification?._id?.toString() || null,

            idempotencyKey,
          },
          "Vendor low balance notification queued",
        );
      } catch (error) {
        notificationsFailed++;

        WorkerLogger.error(
          {
            queue: QUEUE_NAME,
            jobId: job.id,
            vendorId,
            balance: vendor.balance,
            err: error,
          },
          "Failed to queue vendor low balance notification",
        );
      }
    }

    // ============================================================
    // USERS
    // ============================================================
    //
    // Users receive notification when:
    //
    // balance < ₹30
    //
    // One notification per user per IST calendar day.
    // ============================================================

    const users = await User.find({
      balance: {
        $lt: USER_LOW_BALANCE_THRESHOLD,
      },

      fcmToken: {
        $exists: true,
        $nin: [null, ""],
      },
    })
      .select("_id name balance fcmToken")
      .lean();

    usersFound = users.length;

    WorkerLogger.info(
      {
        queue: QUEUE_NAME,
        jobId: job.id,
        dateKey,
        usersFound,
        threshold: USER_LOW_BALANCE_THRESHOLD,
      },
      "Low balance users found",
    );

    // ============================================================
    // Send user notifications
    // ============================================================

    for (const user of users) {
      const userId = user._id.toString();

      try {
        const pushToken = String(user.fcmToken || "").trim();

        // --------------------------------------------------------
        // Validate FCM token
        // --------------------------------------------------------

        if (!pushToken) {
          notificationsSkipped++;

          WorkerLogger.warn(
            {
              queue: QUEUE_NAME,
              jobId: job.id,
              userId,
              balance: user.balance,
              reason: "FCM_TOKEN_MISSING",
            },
            "User low balance notification skipped",
          );

          continue;
        }

        // --------------------------------------------------------
        // One notification per user per IST day
        // --------------------------------------------------------

        const idempotencyKey = `low-balance:user:${userId}:${dateKey}`;

        WorkerLogger.debug(
          {
            queue: QUEUE_NAME,
            jobId: job.id,
            userId,
            balance: user.balance,
            dateKey,
            idempotencyKey,
          },
          "Queueing user low balance notification",
        );

        // --------------------------------------------------------
        // Queue user push notification
        // --------------------------------------------------------

        const notification = await NotificationService.sendPush({
          userId,

          pushToken,

          template: "low_balance",

          templateData: {
            title: "Low Wallet Balance",

            body:
              `Your wallet balance is ₹${user.balance}. ` +
              `Please recharge your wallet to continue using Aapkakaam.`,

            type: "low_balance",

            screen: "profile",

            data: {
              userId,
              balance: String(user.balance),
            },
          },

          source: "system",

          sourceId: userId,

          priority: 3,

          tags: ["wallet", "low_balance", "user"],

          idempotencyKey,
        });

        notificationsQueued++;

        WorkerLogger.info(
          {
            queue: QUEUE_NAME,
            jobId: job.id,
            userId,
            balance: user.balance,

            notificationId: notification?._id?.toString() || null,

            idempotencyKey,
          },
          "User low balance notification queued",
        );
      } catch (error) {
        notificationsFailed++;

        WorkerLogger.error(
          {
            queue: QUEUE_NAME,
            jobId: job.id,
            userId,
            balance: user.balance,
            err: error,
          },
          "Failed to queue user low balance notification",
        );
      }
    }

    // ============================================================
    // Completed
    // ============================================================

    const duration = Date.now() - started;

    WorkerLogger.info(
      {
        queue: QUEUE_NAME,
        jobId: job.id,

        dateKey,

        vendorThreshold: VENDOR_LOW_BALANCE_THRESHOLD,
        userThreshold: USER_LOW_BALANCE_THRESHOLD,

        vendorsFound,
        usersFound,

        notificationsQueued,
        notificationsSkipped,
        notificationsFailed,

        duration,
      },
      "Low balance check completed",
    );

    return {
      dateKey,

      vendorThreshold: VENDOR_LOW_BALANCE_THRESHOLD,
      userThreshold: USER_LOW_BALANCE_THRESHOLD,

      vendorsFound,
      usersFound,

      notificationsQueued,
      notificationsSkipped,
      notificationsFailed,
    };
  },

  {
    connection,

    // Only one low-balance check at a time.
    concurrency: 1,
  },
);

// ============================================================
// Worker Events
// ============================================================

worker.on("ready", () => {
  WorkerLogger.info(
    {
      queue: QUEUE_NAME,

      vendorThreshold: VENDOR_LOW_BALANCE_THRESHOLD,
      userThreshold: USER_LOW_BALANCE_THRESHOLD,
    },
    "Low balance worker ready",
  );
});

worker.on("active", (job) => {
  WorkerLogger.debug(
    {
      queue: QUEUE_NAME,
      jobId: job.id,
    },
    "Low balance job started",
  );
});

worker.on("completed", (job, result) => {
  WorkerLogger.info(
    {
      queue: QUEUE_NAME,
      jobId: job.id,
      result,
    },
    "Low balance job completed",
  );
});

worker.on("failed", (job, error) => {
  WorkerLogger.error(
    {
      queue: QUEUE_NAME,
      jobId: job?.id,
      attemptsMade: job?.attemptsMade,
      err: error,
    },
    "Low balance job failed",
  );
});

worker.on("error", (error) => {
  WorkerLogger.error(
    {
      queue: QUEUE_NAME,
      err: error,
    },
    "Low balance worker error",
  );
});

// ============================================================
// Export
// ============================================================

module.exports = worker;
