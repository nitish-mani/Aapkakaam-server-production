"use strict";

const NotificationOutbox = require("../../models/notificationOutbox");
const NotificationService = require("./NotificationService");

const { BookingLogger } = require("../logger/index");

// ============================================================
// CONFIG
// ============================================================

const POLL_INTERVAL_MS = Number(process.env.NOTIFICATION_OUTBOX_POLL_INTERVAL_MS) || 1000;

const ERROR_RETRY_DELAY_MS = Number(process.env.NOTIFICATION_OUTBOX_RETRY_DELAY_MS) || 5000;

const STUCK_PROCESSING_TIMEOUT_MS =
  Number(process.env.NOTIFICATION_OUTBOX_STUCK_TIMEOUT_MS) || 10 * 60 * 1000;

const BATCH_SIZE = Math.max(1, Number(process.env.NOTIFICATION_OUTBOX_BATCH_SIZE) || 50);

const CONCURRENCY = Math.max(1, Number(process.env.NOTIFICATION_OUTBOX_CONCURRENCY) || 10);

// ============================================================
// SERVICE
// ============================================================

class NotificationOutboxService {
  static running = false;

  static stopping = false;

  static loopPromise = null;

  // ============================================================
  // SLEEP
  // ============================================================

  static sleep(ms) {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  // ============================================================
  // PROCESS ONE
  // ============================================================

  static async processOne(outbox) {
    if (!outbox?._id) {
      return {
        success: false,
        reason: "OUTBOX_ID_MISSING",
      };
    }

    const outboxId = outbox._id.toString();

    try {
      // ========================================================
      // ATOMIC CLAIM
      // ========================================================

      const claimed = await NotificationOutbox.findOneAndUpdate(
        {
          _id: outbox._id,

          status: "PENDING",

          availableAt: {
            $lte: new Date(),
          },
        },

        {
          $set: {
            status: "PROCESSING",
          },

          $inc: {
            attempts: 1,
          },
        },

        {
          new: true,
        },
      ).lean();

      // Another worker already claimed it.
      if (!claimed) {
        return {
          success: true,
          skipped: true,
          reason: "ALREADY_CLAIMED",
          outboxId,
        };
      }

      BookingLogger.info(
        {
          event: "NOTIFICATION_OUTBOX_CLAIMED",

          outboxId,

          eventType: claimed.eventType,

          bookingId: claimed.bookingId,

          userId: claimed.userId,

          vendorId: claimed.vendorId,

          attempt: claimed.attempts,
        },

        "Notification outbox record claimed",
      );

      // ========================================================
      // LOAD BOOKING + USER + VENDOR
      // ========================================================

      /**
       * NotificationService.bookingCreated() expects:
       *
       * {
       *   booking,
       *   user,
       *   vendor,
       *   requestId
       * }
       *
       * So we reconstruct those objects here.
       */

      const Bookings = require("../../models/bookings");
      const User = require("../../models/user");
      const Vendor = require("../../models/vendor");

      const booking = await Bookings.findById(claimed.bookingId).lean();

      if (!booking) {
        throw new Error(`Booking not found for notification outbox ${outboxId}`);
      }

      let user = null;

      if (claimed.userId) {
        user = await User.findById(claimed.userId).lean();
      }

      let vendor = null;

      if (claimed.vendorId) {
        vendor = await Vendor.findById(claimed.vendorId).lean();
      }

      // ========================================================
      // DISPATCH BUSINESS EVENT
      // ========================================================

      let notificationResult;

      switch (claimed.eventType) {
        case "BOOKING_CREATED": {
          notificationResult = await NotificationService.bookingCreated({
            booking,
            user,
            vendor,
            requestId: claimed.payload?.requestId || null,
          });

          break;
        }

        case "BOOKING_CANCELLED": {
          notificationResult = await NotificationService.bookingCancelled({
            booking,
            user,
            vendor,
            formattedDate: claimed.payload?.formattedDate || "",
            requestId: claimed.payload?.requestId || null,
          });

          break;
        }

        case "BOOKING_COMPLETED": {
          notificationResult = await NotificationService.bookingCompleted({
            booking,
            user,
            vendor,
            amount: claimed.payload?.amount ?? null,
            requestId: claimed.payload?.requestId || null,
          });

          break;
        }

        default:
          throw new Error(`Unsupported notification outbox event: ${claimed.eventType}`);
      }
      // ========================================================
      // COMPLETED
      // ========================================================

      const completed = await NotificationOutbox.updateOne(
        {
          _id: claimed._id,

          status: "PROCESSING",
        },

        {
          $set: {
            status: "COMPLETED",

            processedAt: new Date(),
          },

          $unset: {
            lastError: 1,
          },
        },
      );

      if (completed.modifiedCount !== 1) {
        BookingLogger.warn(
          {
            event: "NOTIFICATION_OUTBOX_COMPLETION_UPDATE_FAILED",

            outboxId,

            notificationId: notificationResult?._id || null,
          },

          "Notification was processed but outbox completion update did not modify the record",
        );
      }

      BookingLogger.info(
        {
          event: "NOTIFICATION_OUTBOX_COMPLETED",

          outboxId,

          eventType: claimed.eventType,

          bookingId: claimed.bookingId,

          notificationId: notificationResult?._id || null,

          attempts: claimed.attempts,
        },

        "Notification outbox processed successfully",
      );

      return {
        success: true,

        outboxId,

        notificationId: notificationResult?._id?.toString?.() || null,
      };
    } catch (error) {
      // ========================================================
      // FAILURE
      // ========================================================

      BookingLogger.error(
        {
          event: "NOTIFICATION_OUTBOX_FAILED",

          outboxId,

          error: error.message,

          stack: error.stack,
        },

        "Notification outbox processing failed",
      );

      // ========================================================
      // RETURN TO PENDING
      // ========================================================

      try {
        await NotificationOutbox.updateOne(
          {
            _id: outbox._id,

            status: "PROCESSING",
          },

          {
            $set: {
              status: "PENDING",

              availableAt: new Date(Date.now() + ERROR_RETRY_DELAY_MS),

              lastError: this.sanitizeErrorMessage(error.message),
            },
          },
        );
      } catch (updateError) {
        BookingLogger.error(
          {
            event: "NOTIFICATION_OUTBOX_RESET_FAILED",

            outboxId,

            error: updateError.message,
          },

          "Failed to reset notification outbox record",
        );
      }

      return {
        success: false,

        outboxId,

        error: error.message,
      };
    }
  }

  // ============================================================
  // SANITIZE ERROR
  // ============================================================

  static sanitizeErrorMessage(message) {
    if (!message) {
      return "Unknown outbox error";
    }

    return String(message)
      .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
      .replace(/token[=:]\s*[^\s,]+/gi, "token=[REDACTED]")
      .replace(/api[_-]?key[=:]\s*[^\s,]+/gi, "apiKey=[REDACTED]")
      .substring(0, 500);
  }

  // ============================================================
  // GET PENDING
  // ============================================================

  static async getPendingRecords() {
    return NotificationOutbox.find({
      status: "PENDING",

      availableAt: {
        $lte: new Date(),
      },
    })
      .sort({
        createdAt: 1,
      })
      .limit(BATCH_SIZE)
      .lean();
  }

  // ============================================================
  // PROCESS BATCH
  // ============================================================

  static async processBatch() {
    const records = await this.getPendingRecords();

    if (!records.length) {
      return {
        found: 0,
        processed: 0,
      };
    }

    let processed = 0;

    for (let i = 0; i < records.length; i += CONCURRENCY) {
      if (this.stopping) {
        break;
      }

      const batch = records.slice(i, i + CONCURRENCY);

      const results = await Promise.allSettled(batch.map((record) => this.processOne(record)));

      processed += results.filter(
        (result) => result.status === "fulfilled" && result.value?.success === true,
      ).length;
    }

    return {
      found: records.length,

      processed,
    };
  }

  // ============================================================
  // RECOVER STUCK RECORDS
  // ============================================================

  static async recoverStuckRecords() {
    const cutoff = new Date(Date.now() - STUCK_PROCESSING_TIMEOUT_MS);

    try {
      const result = await NotificationOutbox.updateMany(
        {
          status: "PROCESSING",

          updatedAt: {
            $lt: cutoff,
          },
        },

        {
          $set: {
            status: "PENDING",

            availableAt: new Date(),

            lastError: "Recovered stale PROCESSING notification",
          },
        },
      );

      if (result.modifiedCount > 0) {
        BookingLogger.warn(
          {
            event: "NOTIFICATION_OUTBOX_STUCK_RECORDS_RECOVERED",

            count: result.modifiedCount,
          },

          "Recovered stale notification outbox records",
        );
      }

      return result.modifiedCount;
    } catch (error) {
      BookingLogger.error(
        {
          event: "NOTIFICATION_OUTBOX_RECOVERY_FAILED",

          error: error.message,
        },

        "Failed to recover stuck notification outbox records",
      );

      return 0;
    }
  }

  // ============================================================
  // START
  // ============================================================

  static async run() {
    if (this.running) {
      BookingLogger.warn(
        {
          event: "NOTIFICATION_OUTBOX_WORKER_ALREADY_RUNNING",
        },

        "Notification outbox worker is already running",
      );

      return this.loopPromise;
    }

    this.running = true;

    this.stopping = false;

    BookingLogger.info(
      {
        event: "NOTIFICATION_OUTBOX_WORKER_STARTED",

        pollInterval: POLL_INTERVAL_MS,

        batchSize: BATCH_SIZE,

        concurrency: CONCURRENCY,

        stuckTimeout: STUCK_PROCESSING_TIMEOUT_MS,
      },

      "Notification outbox worker started",
    );

    this.loopPromise = this.workerLoop();

    return this.loopPromise;
  }

  // ============================================================
  // WORKER LOOP
  // ============================================================

  static async workerLoop() {
    let lastRecovery = 0;

    try {
      while (!this.stopping) {
        try {
          const now = Date.now();

          // Recover stale records every 30 seconds.
          if (now - lastRecovery >= 30_000) {
            await this.recoverStuckRecords();

            lastRecovery = now;
          }

          const result = await this.processBatch();

          if (result.found === 0) {
            await this.sleep(POLL_INTERVAL_MS);
          }
        } catch (error) {
          BookingLogger.error(
            {
              event: "NOTIFICATION_OUTBOX_WORKER_LOOP_ERROR",

              error: error.message,

              stack: error.stack,
            },

            "Notification outbox worker loop failed",
          );

          await this.sleep(5000);
        }
      }
    } finally {
      this.running = false;

      this.loopPromise = null;

      BookingLogger.info(
        {
          event: "NOTIFICATION_OUTBOX_WORKER_STOPPED",
        },

        "Notification outbox worker stopped",
      );
    }
  }

  // ============================================================
  // STOP
  // ============================================================

  static async stop() {
    if (!this.running) {
      return;
    }

    BookingLogger.info(
      {
        event: "NOTIFICATION_OUTBOX_WORKER_STOPPING",
      },

      "Stopping notification outbox worker...",
    );

    this.stopping = true;

    if (this.loopPromise) {
      await this.loopPromise;
    }

    this.running = false;

    this.stopping = false;
  }

  // ============================================================
  // HEALTH
  // ============================================================

  static isRunning() {
    return this.running;
  }
}

module.exports = NotificationOutboxService;
