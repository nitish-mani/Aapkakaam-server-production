"use strict";

const Notification = require("../../models/notification");
const { addNotificationJob } = require("../queues/notification.queue");

const { NotificationLogger } = require("../logger/index");
/**
 * NotificationService
 *
 * Responsibilities:
 *
 * 1. Create notification records in MongoDB
 * 2. Push notification jobs to BullMQ
 * 3. Provide channel-specific helpers
 * 4. Provide business-level notification orchestration
 *
 * IMPORTANT:
 *
 * NotificationService should normally be called AFTER the main
 * business transaction has committed.
 *
 * Example:
 *
 * MongoDB Transaction
 *      ↓
 * Booking Created
 *      ↓
 * Transaction Commit
 *      ↓
 * NotificationService.bookingCreated()
 *      ↓
 * MongoDB Notification Record
 *      ↓
 * BullMQ / Redis
 *      ↓
 * Notification Worker
 *      ↓
 * Provider
 */

function isDuplicateIdempotencyError(error) {
  return (
    error?.code === 11000 &&
    (error?.keyPattern?.idempotencyKey === 1 || error?.keyValue?.idempotencyKey)
  );
}

class NotificationService {
  /**
   * Generic Notification Creator
   *
   * This is the central entry point for creating notifications.
   *
   * Flow:
   *
   * Notification.create()
   *        ↓
   * addNotificationJob()
   *        ↓
   * BullMQ
   *        ↓
   * Worker
   */
  static async createNotification({
    type,
    userId = null,
    vendorId = null,
    recipient = {},
    template,
    templateData = {},
    source = "system",
    sourceId = null,
    requestId = null,
    priority = 5,
    scheduledAt = new Date(),
    expiresAt = null,
    tags = [],
    idempotencyKey,
  }) {
    if (!type) {
      throw new Error("Notification type is required");
    }

    if (!template) {
      throw new Error("Notification template is required");
    }

    if (!templateData || typeof templateData !== "object" || Array.isArray(templateData)) {
      throw new Error("templateData must be an object");
    }

    if (typeof idempotencyKey !== "string" || !idempotencyKey.trim()) {
      throw new Error("Notification idempotencyKey is required");
    }

    const normalizedType = String(type).trim().toUpperCase();

    const normalizedIdempotencyKey = idempotencyKey.trim();

    let notification;

    try {
      try {
        notification = await Notification.create({
          userId,
          vendorId,

          type: normalizedType,

          recipient,

          template,

          content: {
            templateData,
          },

          source,
          sourceId,

          requestId,

          priority,

          scheduledAt,
          expiresAt,

          tags,

          idempotencyKey: normalizedIdempotencyKey,

          status: "created",
        });
      } catch (error) {
        if (!isDuplicateIdempotencyError(error)) {
          throw error;
        }

        notification = await Notification.findOne({
          idempotencyKey: normalizedIdempotencyKey,
        });

        if (!notification) {
          throw error;
        }

        NotificationLogger.info(
          {
            event: "NOTIFICATION_DUPLICATE_REUSED",

            notificationId: notification._id,

            idempotencyKey: normalizedIdempotencyKey,

            requestId,
          },
          "Existing notification reused for duplicate business event",
        );
      }
      if (notification.status === "sent" || notification.status === "cancelled") {
        NotificationLogger.info(
          {
            event: "NOTIFICATION_ALREADY_TERMINAL",
            notificationId: notification._id,
            idempotencyKey: normalizedIdempotencyKey,
            status: notification.status,
            requestId,
          },
          "Notification already reached terminal state; skipping enqueue",
        );

        return notification;
      }

      await addNotificationJob(
        {
          notificationId: notification._id.toString(),
        },
        {
          priority: notification.priority,

          jobId: notification._id.toString(),
        },
      );

      if (notification.status === "created") {
        notification.markQueued();

        await notification.save();
      }

      NotificationLogger.info(
        {
          event: "NOTIFICATION_QUEUED",

          notificationId: notification._id,

          idempotencyKey: normalizedIdempotencyKey,

          type: notification.type,

          template: notification.template,

          source: notification.source,

          sourceId: notification.sourceId,

          userId,
          vendorId,

          requestId,

          priority: notification.priority,
        },
        "Notification queued successfully",
      );

      return notification;
    } catch (error) {
      NotificationLogger.error(
        {
          err: error,

          event: "NOTIFICATION_QUEUE_FAILED",

          notificationId: notification?._id,

          idempotencyKey: normalizedIdempotencyKey,

          type: normalizedType,

          template,

          source,
          sourceId,

          userId,
          vendorId,

          requestId,
        },
        "Failed to create or queue notification",
      );

      throw error;
    }
  }

  // ============================================================
  // SMS
  // ============================================================

  /**
   * Queue SMS Notification
   */
  static async sendSMS({
    userId = null,
    vendorId = null,
    phoneNumber,
    template,
    templateData = {},
    source = "system",
    sourceId = null,
    requestId = null,
    priority = 5,
    scheduledAt = new Date(),
    expiresAt = null,
    tags = [],
    idempotencyKey,
  }) {
    if (!phoneNumber) {
      throw new Error("phoneNumber is required");
    }

    return this.createNotification({
      type: "SMS",

      userId,
      vendorId,

      recipient: {
        phoneNumber,
      },

      template,
      templateData,

      source,
      sourceId,
      requestId,
      priority,
      scheduledAt,
      expiresAt,
      tags,
      idempotencyKey,
    });
  }
  // ============================================================
  // PUSH
  // ============================================================

  /**
   * Queue Push Notification
   */
  static async sendPush({
    userId = null,
    vendorId = null,

    pushToken,

    template,
    templateData = {},

    source = "system",
    sourceId = null,

    requestId = null,

    priority = 5,

    scheduledAt = new Date(),
    expiresAt = null,

    tags = [],
    idempotencyKey,
  }) {
    if (!pushToken) {
      throw new Error("pushToken is required");
    }

    return this.createNotification({
      type: "PUSH",

      userId,
      vendorId,

      recipient: {
        pushToken,
      },

      template,
      templateData,

      source,
      sourceId,

      requestId,

      priority,

      scheduledAt,
      expiresAt,

      tags,
      idempotencyKey,
    });
  }

  // ============================================================
  // EMAIL
  // ============================================================

  /**
   * Queue Email Notification
   */
  static async sendEmail({
    userId = null,
    vendorId = null,

    email,

    template,
    templateData = {},

    source = "system",
    sourceId = null,

    requestId = null,

    priority = 5,

    scheduledAt = new Date(),
    expiresAt = null,

    tags = [],
    idempotencyKey,
  }) {
    if (!email) {
      throw new Error("email is required");
    }

    return this.createNotification({
      type: "EMAIL",

      userId,
      vendorId,

      recipient: {
        email,
      },

      template,
      templateData,

      source,
      sourceId,

      requestId,

      priority,

      scheduledAt,
      expiresAt,

      tags,
      idempotencyKey,
    });
  }

  // ============================================================
  // TELEGRAM
  // ============================================================

  /**
   * Queue Telegram Notification
   */
  static async sendTelegram({
    telegramChatId,

    template,
    templateData = {},

    source = "system",
    sourceId = null,

    requestId = null,

    priority = 5,

    scheduledAt = new Date(),
    expiresAt = null,

    tags = [],
    idempotencyKey,
  }) {
    if (!telegramChatId) {
      throw new Error("telegramChatId is required");
    }

    return this.createNotification({
      type: "TELEGRAM",

      recipient: {
        telegramChatId,
      },

      template,
      templateData,

      source,
      sourceId,

      requestId,

      priority,

      scheduledAt,
      expiresAt,

      tags,
      idempotencyKey,
    });
  }

  // ============================================================
  // BOOKING NOTIFICATIONS
  // ============================================================

  /**
   * Booking Created
   *
   * Business-level booking notification orchestration.
   *
   * IMPORTANT:
   *
   * Call this AFTER the booking MongoDB transaction commits.
   *
   * Example:
   *
   * await session.withTransaction(...)
   *
   * // transaction committed
   *
   * await NotificationService.bookingCreated(...)
   *
   *
   * Current behavior:
   *
   * 1. Notify vendor that a customer booked them.
   * 2. Notify customer that booking was successfully created.
   *
   * Failure of one notification does NOT prevent the other
   * notification from being queued.
   */
  static async bookingCreated({ booking, user, vendor, requestId = null }) {
    const bookingId = booking?._id?.toString();
    const bookingDate = booking?.bookingDate.toDateString();
    if (!bookingId) {
      throw new Error("booking._id is required for booking notification");
    }

    const jobs = [];

    NotificationLogger.info(
      {
        event: "BOOKING_NOTIFICATION_STARTED",
        bookingId,
        userId: user?._id,
        vendorId: vendor?._id,
        bookingDate: bookingDate,
        type: booking?.type,
        pincode: booking?.pincode,
        requestId,
      },
      "Preparing booking notifications",
    );

    /**
     * Vendor notification
     *
     * Preserves OLD behavior:
     *
     * Name - CUSTOMER_NAME and Mob - CUSTOMER_PHONE
     * BOOKING_DATE
     *
     * SMS destination = vendor.phoneNo
     */
    if (vendor?.phoneNo) {
      jobs.push({
        recipientType: "vendor",

        promise: this.sendSMS({
          vendorId: vendor._id,

          phoneNumber: vendor.phoneNo,

          template: "booking_created_vendor",

          templateData: {
            name: user?.name || "Customer",

            userPhoneNo: user?.phoneNo || "",

            bookingDate: bookingDate || "",
          },

          source: "booking",
          sourceId: bookingId,

          requestId,

          priority: 2,

          tags: ["booking", "booking_created", "vendor"],

          idempotencyKey: `booking:${bookingId}:created:vendor:sms`,
        }),
      });
    } else {
      NotificationLogger.warn(
        {
          event: "BOOKING_VENDOR_NOTIFICATION_SKIPPED",
          bookingId,
          vendorId: vendor?._id,
          requestId,
          reason: "VENDOR_PHONE_MISSING",
        },
        "Vendor booking notification skipped",
      );
    }

    if (jobs.length === 0) {
      NotificationLogger.warn(
        {
          event: "BOOKING_NOTIFICATION_NO_RECIPIENT",
          bookingId,
          userId: user?._id,
          vendorId: vendor?._id,
          requestId,
        },
        "No valid recipients for booking notifications",
      );

      return {
        attempted: 0,
        queued: 0,
        failed: 0,
        results: [],
      };
    }

    const results = await Promise.allSettled(jobs.map((job) => job.promise));

    let queued = 0;
    let failed = 0;

    const processedResults = results.map((result, index) => {
      const job = jobs[index];

      if (result.status === "fulfilled") {
        queued += 1;

        NotificationLogger.info(
          {
            event: "BOOKING_NOTIFICATION_QUEUED",
            bookingId,
            recipientType: job.recipientType,
            notificationId: result.value?._id,
            requestId,
          },
          "Booking notification queued",
        );

        return {
          recipientType: job.recipientType,
          success: true,
          notificationId: result.value?._id?.toString() || null,
        };
      }

      failed += 1;

      NotificationLogger.error(
        {
          err: result.reason,
          event: "BOOKING_NOTIFICATION_QUEUE_FAILED",
          bookingId,
          recipientType: job.recipientType,
          userId: user?._id,
          vendorId: vendor?._id,
          requestId,
          error: result.reason?.message,
          errorCode: result.reason?.code,
        },
        "Failed to queue booking notification",
      );

      return {
        recipientType: job.recipientType,
        success: false,
        error: result.reason?.message || "Failed to queue notification",
      };
    });

    NotificationLogger.info(
      {
        event: "BOOKING_NOTIFICATIONS_COMPLETED",
        bookingId,
        userId: user?._id,
        vendorId: vendor?._id,
        requestId,
        attempted: jobs.length,
        queued,
        failed,
      },
      "Booking notification enqueue completed",
    );

    return {
      attempted: jobs.length,
      queued,
      failed,
      results: processedResults,
    };
  }

  // ============================================================
  // BOOKING CANCELLATION NOTIFICATIONS
  // ============================================================

  /**
   * Booking Cancelled
   *
   * Business-level cancellation notification orchestration.
   *
   * IMPORTANT:
   *
   * Call this ONLY after the booking MongoDB transaction commits.
   *
   * Flow:
   *
   * BookingService.cancelBooking()
   *        ↓
   * MongoDB Transaction
   *        ↓
   * Transaction Commit
   *        ↓
   * NotificationService.bookingCancelled()
   *        ↓
   * sendSMS()
   *        ↓
   * Notification MongoDB Record
   *        ↓
   * BullMQ / Redis
   *        ↓
   * Notification Worker
   *        ↓
   * SmsProvider
   *        ↓
   * FAST2SMSCANCEL
   *
   * OLD BEHAVIOR PRESERVED:
   *
   * SMS destination:
   *   vendor.phoneNo
   *
   * Template:
   *   booking_cancelled
   *
   * Fast2SMS variables:
   *   CUSTOMER_NAME | FORMATTED_DATE
   *
   * Notification failure NEVER affects the already committed
   * booking cancellation.
   */
  static async bookingCancelled({ booking, user, vendor, formattedDate, requestId = null }) {
    const bookingId = booking?._id?.toString();

    if (!bookingId) {
      throw new Error("booking._id is required for booking notification");
    }

    const userId = user?._id?.toString() || booking?.userId?._id?.toString() || null;

    const vendorId = vendor?._id?.toString() || booking?.vendorId?._id?.toString() || null;

    /**
     * Resolve vendor phone.
     *
     * Normally booking.vendorId is populated by
     * loadBookingForCancel().
     */
    const vendorPhoneNumber = vendor?.phoneNo || booking?.vendorId?.phoneNo || null;

    /**
     * Resolve customer / booking creator name.
     */
    const userName = user?.name || booking?.userId?.name || "User";

    /**
     * Resolve cancellation date.
     *
     * Prefer the already formatted date supplied by
     * BookingService so old SMS formatting is preserved.
     */
    let cancellationDate = formattedDate;

    if (!cancellationDate && booking?.bookingDate) {
      const bookingDateObj = new Date(booking.bookingDate);

      if (!Number.isNaN(bookingDateObj.getTime())) {
        cancellationDate =
          `${bookingDateObj.getDate()}/` +
          `${bookingDateObj.getMonth() + 1}/` +
          `${bookingDateObj.getFullYear()}`;
      }
    }

    NotificationLogger.info(
      {
        event: "BOOKING_CANCEL_NOTIFICATION_STARTED",

        bookingId,

        userId,

        vendorId,

        bookingDate: booking?.bookingDate,

        formattedDate: cancellationDate,

        requestId,
      },
      "Preparing booking cancellation notification",
    );

    /**
     * --------------------------------------------------
     * Validate recipient
     * --------------------------------------------------
     */
    if (!vendorPhoneNumber) {
      NotificationLogger.warn(
        {
          event: "BOOKING_CANCEL_NOTIFICATION_SKIPPED",

          bookingId,

          userId,

          vendorId,

          requestId,

          reason: "VENDOR_PHONE_MISSING",
        },
        "Booking cancellation notification skipped",
      );

      return {
        attempted: 0,
        queued: 0,
        failed: 0,
        results: [],
      };
    }

    /**
     * --------------------------------------------------
     * Validate date
     * --------------------------------------------------
     */
    if (!cancellationDate) {
      NotificationLogger.warn(
        {
          event: "BOOKING_CANCEL_NOTIFICATION_SKIPPED",

          bookingId,

          userId,

          vendorId,

          requestId,

          reason: "BOOKING_DATE_MISSING",
        },
        "Booking cancellation notification skipped",
      );

      return {
        attempted: 0,
        queued: 0,
        failed: 0,
        results: [],
      };
    }

    /**
     * --------------------------------------------------
     * Queue cancellation SMS
     * --------------------------------------------------
     *
     * SmsProvider handles the actual Fast2SMS request.
     *
     * DO NOT put:
     * - Fast2SMS URL
     * - Axios
     * - provider credentials
     *
     * in NotificationService.
     */
    try {
      const notification = await this.sendSMS({
        userId,

        vendorId,

        /**
         * OLD BEHAVIOR:
         *
         * Cancellation SMS goes to booked vendor.
         */
        phoneNumber: vendorPhoneNumber,

        /**
         * SmsProvider switch case:
         *
         * case "booking_cancelled"
         */
        template: "booking_cancelled",

        /**
         * SmsProvider expects:
         *
         * {
         *   name,
         *   formattedDate
         * }
         */
        templateData: {
          name: userName,
          formattedDate: cancellationDate,
        },

        source: "booking",

        sourceId: bookingId,

        requestId,

        priority: 2,

        tags: ["booking", "booking_cancelled", "vendor"],
        idempotencyKey: `booking:${bookingId}:cancelled:vendor:sms`,
      });

      NotificationLogger.info(
        {
          event: "BOOKING_CANCEL_NOTIFICATION_QUEUED",

          bookingId,

          notificationId: notification?._id?.toString() || null,

          userId,

          vendorId,

          requestId,
        },
        "Booking cancellation notification queued",
      );

      return {
        attempted: 1,
        queued: 1,
        failed: 0,

        results: [
          {
            recipientType: "vendor",

            success: true,

            notificationId: notification?._id?.toString() || null,
          },
        ],
      };
    } catch (error) {
      NotificationLogger.error(
        {
          err: error,

          event: "BOOKING_CANCEL_NOTIFICATION_QUEUE_FAILED",

          bookingId,

          userId,

          vendorId,

          requestId,

          error: error.message,

          errorCode: error.code,
        },
        "Failed to queue booking cancellation notification",
      );

      /**
       * IMPORTANT:
       *
       * Do NOT throw.
       *
       * Booking cancellation has already committed.
       *
       * Notification failure must never make the API
       * report that booking cancellation itself failed.
       */
      return {
        attempted: 1,
        queued: 0,
        failed: 1,

        results: [
          {
            recipientType: "vendor",

            success: false,

            error: error.message || "Failed to queue cancellation notification",
          },
        ],
      };
    }
  }
  // ============================================================
  // SELF BOOKING
  // ============================================================

  /**
   * Vendor Self Booking Notification
   *
   * Self booking is different from normal booking because there
   * is no customer -> vendor notification pair.
   *
   * Usually the vendor only needs confirmation of the blocked date.
   */
  static async selfBookingCreated({ booking, vendor, requestId = null }) {
    const bookingId = booking?._id?.toString();

    if (!bookingId) {
      throw new Error("booking._id is required for booking notification");
    }

    if (!vendor?.phoneNo) {
      NotificationLogger.warn(
        {
          event: "SELF_BOOKING_NOTIFICATION_SKIPPED",

          bookingId,

          vendorId: vendor?._id,

          requestId,

          reason: "VENDOR_PHONE_MISSING",
        },
        "Self-booking notification skipped",
      );

      return null;
    }

    try {
      const notification = await this.sendSMS({
        vendorId: vendor._id,

        phoneNumber: vendor.phoneNo,

        template: "self_booking_created",

        templateData: {
          name: vendor?.name || "Service Provider",

          bookingDate: booking?.bookingDate || "",

          type: booking?.type || "",

          pincode: booking?.pincode || "",

          bookingId: bookingId || "",
        },

        source: "booking",

        sourceId: booking?._id || null,

        requestId,

        priority: 3,

        tags: ["booking", "self_booking", "vendor"],
        idempotencyKey: `booking:${bookingId}:self-created:vendor:sms`,
      });

      NotificationLogger.info(
        {
          event: "SELF_BOOKING_NOTIFICATION_QUEUED",

          bookingId,

          notificationId: notification?._id,

          vendorId: vendor._id,

          requestId,
        },
        "Self-booking notification queued",
      );

      return notification;
    } catch (error) {
      NotificationLogger.error(
        {
          err: error,

          event: "SELF_BOOKING_NOTIFICATION_FAILED",

          bookingId,

          vendorId: vendor?._id,

          requestId,
        },
        "Failed to queue self-booking notification",
      );

      /**
       * Do not rethrow.
       *
       * Booking is already committed.
       * Notification failure must not make the API report
       * that the booking itself failed.
       */
      return null;
    }
  }
}

module.exports = NotificationService;
