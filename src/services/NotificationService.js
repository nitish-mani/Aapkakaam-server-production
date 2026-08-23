"use strict";

const Notification = require("../../models/notification");
const { addNotificationJob } = require("../queues/notification.queue");
const { NotificationLogger } = require("../logger/index");

// IMPORTANT:
// Change this path if notification.policy.js is in another folder.
const { getNotificationPolicy } = require("./notification/notification.policy");

// ============================================================
// HELPERS
// ============================================================

function isDuplicateIdempotencyError(error) {
  return (
    error?.code === 11000 &&
    (error?.keyPattern?.idempotencyKey === 1 || error?.keyValue?.idempotencyKey)
  );
}

// ============================================================
// SERVICE
// ============================================================

class NotificationService {
  // ============================================================
  // GENERIC NOTIFICATION CREATOR
  // ============================================================

  /**
   * Central notification creation method.
   *
   * Flow:
   *
   * Notification.create()
   *        ↓
   * addNotificationJob()
   *        ↓
   * BullMQ
   *        ↓
   * Notification Worker
   *
   * IMPORTANT:
   *
   * This method does NOT send SMS/PUSH/WhatsApp directly.
   *
   * It creates ONE logical notification.
   *
   * The Worker/Dispatcher is responsible for actually
   * delivering it through the channel policy.
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
    channelPolicy = null,
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
      // ========================================================
      // CREATE NOTIFICATION
      // ========================================================

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

          channelPolicy,

          idempotencyKey: normalizedIdempotencyKey,

          status: "created",
        });
      } catch (error) {
        // ======================================================
        // IDEMPOTENCY
        // ======================================================

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

      // ========================================================
      // TERMINAL STATE
      // ========================================================

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

      // ========================================================
      // QUEUE
      // ========================================================

      await addNotificationJob(
        {
          notificationId: notification._id.toString(),
        },
        {
          priority: notification.priority,

          jobId: notification._id.toString(),
        },
      );

      // ========================================================
      // MARK QUEUED
      // ========================================================

      if (notification.status === "created") {
        notification.markQueued();

        await notification.save();
      }

      // ========================================================
      // LOG
      // ========================================================

      NotificationLogger.info(
        {
          event: "NOTIFICATION_QUEUED",

          notificationId: notification._id,

          idempotencyKey: normalizedIdempotencyKey,

          type: notification.type,

          channel: notification.channel,

          channelPolicy: notification.channelPolicy,

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
  // BUSINESS NOTIFICATION
  // ============================================================

  /**
   * Create ONE logical business notification.
   *
   * Policy comes from notification.policy.js.
   *
   * Example:
   *
   * BOOKING
   *   ↓
   * PUSH
   *   ↓ failure
   * WHATSAPP
   *   ↓ failure
   * SMS
   */
  static async createBusinessNotification({
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
    channelPolicy = null,
  }) {
    const normalizedType = String(type || "")
      .trim()
      .toUpperCase();

    if (!normalizedType) {
      throw new Error("Business notification type is required");
    }

    // ==========================================================
    // USE EXISTING POLICY FILE
    // ==========================================================

    const policy = channelPolicy || getNotificationPolicy(normalizedType);

    if (!policy || !Array.isArray(policy.channels) || policy.channels.length === 0) {
      throw new Error(`No delivery policy configured for notification type: ${normalizedType}`);
    }

    return this.createNotification({
      type: normalizedType,

      userId,

      vendorId,

      recipient,

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

      channelPolicy: {
        channels: policy.channels,

        fallback: policy.fallback !== false,
      },
    });
  }

  // ============================================================
  // SMS
  // ============================================================

  /**
   * Legacy/direct SMS helper.
   *
   * DO NOT remove this yet.
   *
   * Other parts of your application may still use it.
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
   * Legacy/direct PUSH helper.
   *
   * DO NOT remove this yet.
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
  // BOOKING CREATED
  // ============================================================

  /**
   * Booking Created
   *
   * ONE logical notification is created.
   *
   * Policy:
   *
   * PUSH
   *   ↓ failure
   * WHATSAPP
   *   ↓ failure
   * SMS
   *
   * IMPORTANT:
   *
   * Call after booking transaction commits.
   */

  static async bookingCreated({ booking, user, vendor, requestId = null }) {
    const bookingId = booking?._id?.toString();

    if (!bookingId) {
      throw new Error("booking._id is required for booking notification");
    }

    // ============================================================
    // BOOKING DATE
    // ============================================================

    let bookingDate = "";
    let month = null;
    let year = null;

    if (booking?.bookingDate) {
      const date = new Date(booking.bookingDate);

      if (!Number.isNaN(date.getTime())) {
        // Human-readable date for notification body/template
        bookingDate = date.toDateString();

        // MongoDB/JavaScript month is zero-based.
        // January = 0
        // September = 8
        month = date.getMonth();
        year = date.getFullYear();
      }
    }

    // ============================================================
    // IDS
    // ============================================================

    const userId =
      user?._id?.toString() ||
      booking?.userId?._id?.toString() ||
      booking?.userId?.toString() ||
      null;

    const vendorId =
      vendor?._id?.toString() ||
      booking?.vendorId?._id?.toString() ||
      booking?.vendorId?.toString() ||
      null;

    // ============================================================
    // USER CONTACT
    // ============================================================

    // const userPhoneNumber = user?.phoneNo || booking?.userId?.phoneNo || null;

    const userFcmToken = user?.fcmToken || booking?.userId?.fcmToken || null;

    // ============================================================
    // VENDOR CONTACT
    // ============================================================

    const vendorPhoneNumber = vendor?.phoneNo || booking?.vendorId?.phoneNo || null;

    const vendorFcmToken = vendor?.fcmToken || booking?.vendorId?.fcmToken || null;

    const userName = user?.name || booking?.userId?.name || "Customer";

    const results = [];

    // ============================================================
    // LOG
    // ============================================================

    NotificationLogger.info(
      {
        event: "BOOKING_CREATED_NOTIFICATION_STARTED",

        bookingId,

        userId,

        vendorId,

        bookingDate,

        month,

        year,

        hasUserFcmToken: Boolean(userFcmToken),

        hasVendorFcmToken: Boolean(vendorFcmToken),

        requestId,
      },

      "Preparing booking created notifications",
    );

    // ============================================================
    // VENDOR
    // ============================================================

    if (vendorPhoneNumber || vendorFcmToken) {
      try {
        const notification = await this.createBusinessNotification({
          type: "BOOKING",

          userId,

          vendorId,

          recipient: {
            phoneNumber: vendorPhoneNumber || null,
            whatsappNumber: vendorPhoneNumber || null,
            pushToken: vendorFcmToken || null,
          },

          template: "booking_created_vendor",

          templateData: {
            name: userName,

            userPhoneNo: user?.phoneNo || "",

            bookingDate,

            title: "New Booking",

            body: `${userName} has booked your service on ${bookingDate}.`,

            type: "booking",

            screen: "bookings",

            data: {
              // IMPORTANT:
              // Keep both for compatibility.
              id: bookingId,

              bookingId,

              // Booking date
              bookingDate,

              month: String(month),

              year: String(year),

              recipientRole: "vendor",

              notificationType: "new_booking",
            },
          },

          source: "booking",

          sourceId: bookingId,

          requestId,

          priority: 2,

          tags: ["booking", "booking_created", "vendor"],

          idempotencyKey: `booking:${bookingId}:created:vendor`,
        });

        results.push({
          recipientType: "vendor",

          success: true,

          notificationId: notification?._id?.toString() || null,
        });

        NotificationLogger.info(
          {
            event: "BOOKING_CREATED_VENDOR_NOTIFICATION_QUEUED",

            bookingId,

            vendorId,

            notificationId: notification?._id,

            bookingDate,

            requestId,
          },

          "Booking created notification queued for vendor",
        );
      } catch (error) {
        NotificationLogger.error(
          {
            err: error,

            event: "BOOKING_CREATED_VENDOR_NOTIFICATION_FAILED",

            bookingId,

            vendorId,

            requestId,

            error: error?.message,

            stack: error?.stack,
          },

          "Failed to queue booking created notification for vendor",
        );

        results.push({
          recipientType: "vendor",

          success: false,

          error: error?.message || "Failed to queue vendor notification",
        });
      }
    } else {
      NotificationLogger.warn(
        {
          event: "BOOKING_CREATED_VENDOR_NOTIFICATION_SKIPPED",

          bookingId,

          vendorId,

          reason: "VENDOR_PHONE_AND_FCM_TOKEN_MISSING",

          requestId,
        },

        "Vendor has no notification channel",
      );
    }

    // ============================================================
    // USER
    // ============================================================

    if (userFcmToken) {
      try {
        const notification = await this.createBusinessNotification({
          type: "BOOKING",

          userId,

          vendorId,

          recipient: {
            pushToken: userFcmToken || null,
          },

          template: "booking_created_user",

          templateData: {
            name: userName,

            bookingDate,

            title: "Booking Confirmed",

            body: `Your booking for ${bookingDate} has been confirmed.`,

            type: "booking",

            screen: "orders",

            data: {
              // IMPORTANT:
              // Keep both for compatibility.
              id: bookingId,

              bookingId,

              // Booking date
              bookingDate,

              month: String(month),

              year: String(year),

              recipientRole: "user",

              notificationType: "booking_confirmed",
            },
          },

          source: "booking",

          sourceId: bookingId,

          requestId,

          priority: 2,

          tags: ["booking", "booking_created", "user"],

          idempotencyKey: `booking:${bookingId}:created:user`,
        });

        results.push({
          recipientType: "user",

          success: true,

          notificationId: notification?._id?.toString() || null,
        });

        NotificationLogger.info(
          {
            event: "BOOKING_CREATED_USER_NOTIFICATION_QUEUED",

            bookingId,

            userId,

            notificationId: notification?._id,

            bookingDate,

            requestId,
          },

          "Booking created notification queued for user",
        );
      } catch (error) {
        NotificationLogger.error(
          {
            err: error,

            event: "BOOKING_CREATED_USER_NOTIFICATION_FAILED",

            bookingId,

            userId,

            requestId,

            error: error?.message,

            stack: error?.stack,
          },

          "Failed to queue booking created notification for user",
        );

        results.push({
          recipientType: "user",

          success: false,

          error: error?.message || "Failed to queue user notification",
        });
      }
    } else {
      NotificationLogger.warn(
        {
          event: "BOOKING_CREATED_USER_NOTIFICATION_SKIPPED",

          bookingId,

          userId,

          reason: "USER_PHONE_AND_FCM_TOKEN_MISSING",

          requestId,
        },

        "User has no notification channel",
      );
    }

    // ============================================================
    // RESULT
    // ============================================================

    const queued = results.filter((result) => result.success).length;

    const failed = results.filter((result) => !result.success).length;

    NotificationLogger.info(
      {
        event: "BOOKING_CREATED_NOTIFICATION_FINISHED",

        bookingId,

        attempted: results.length,

        queued,

        failed,

        bookingDate,

        requestId,
      },

      "Booking created notifications finished",
    );

    return {
      attempted: results.length,

      queued,

      failed,

      results,
    };
  }

  // ============================================================
  // BOOKING CANCELLED
  // ============================================================

  /**
   * Booking Cancelled
   *
   * ONE logical notification.
   *
   * Policy:
   *
   * PUSH
   *   ↓ failure
   * WHATSAPP
   *   ↓ failure
   * SMS
   *
   * Notification failure NEVER affects the already committed
   * cancellation.
   */
  static async bookingCancelled({ booking, user, vendor, formattedDate, requestId = null }) {
    const bookingId = booking?._id?.toString();

    if (!bookingId) {
      throw new Error("booking._id is required for booking cancellation notification");
    }

    // ============================================================
    // IDS
    // ============================================================

    const userId =
      user?._id?.toString() ||
      booking?.userId?._id?.toString() ||
      booking?.userId?.toString() ||
      null;

    const vendorId =
      vendor?._id?.toString() ||
      booking?.vendorId?._id?.toString() ||
      booking?.vendorId?.toString() ||
      null;

    // ============================================================
    // VENDOR CONTACT
    // ============================================================

    const vendorPhoneNumber = vendor?.phoneNo || booking?.vendorId?.phoneNo || null;

    const vendorFcmToken = vendor?.fcmToken || booking?.vendorId?.fcmToken || null;

    // ============================================================
    // USER NAME
    // ============================================================

    const userName = user?.name || booking?.userId?.name || "User";

    // ============================================================
    // CANCELLATION DATE
    // ============================================================

    let cancellationDate = formattedDate || "";

    if (!cancellationDate && booking?.bookingDate) {
      const bookingDateObj = new Date(booking.bookingDate);

      if (!Number.isNaN(bookingDateObj.getTime())) {
        cancellationDate =
          `${bookingDateObj.getDate()}/` +
          `${bookingDateObj.getMonth() + 1}/` +
          `${bookingDateObj.getFullYear()}`;
      }
    }

    // ============================================================
    // FLUTTER BOOKING DATE DATA
    // ============================================================

    let month = "";
    let year = "";

    if (booking?.bookingDate) {
      const bookingDateObj = new Date(booking.bookingDate);

      if (!Number.isNaN(bookingDateObj.getTime())) {
        month = bookingDateObj.getMonth().toString();

        year = bookingDateObj.getFullYear().toString();
      }
    }

    // ============================================================
    // LOG
    // ============================================================

    NotificationLogger.info(
      {
        event: "BOOKING_CANCEL_NOTIFICATION_STARTED",

        bookingId,

        userId,

        vendorId,

        bookingDate: booking?.bookingDate,

        formattedDate: cancellationDate,

        hasVendorPhone: Boolean(vendorPhoneNumber),

        hasVendorFcmToken: Boolean(vendorFcmToken),

        requestId,
      },

      "Preparing booking cancellation notification",
    );

    // ============================================================
    // RECIPIENT VALIDATION
    // ============================================================

    if (!vendorPhoneNumber && !vendorFcmToken) {
      NotificationLogger.warn(
        {
          event: "BOOKING_CANCEL_NOTIFICATION_SKIPPED",

          bookingId,

          userId,

          vendorId,

          requestId,

          reason: "VENDOR_PHONE_AND_FCM_TOKEN_MISSING",
        },

        "No booking cancellation notification channel available",
      );

      return {
        attempted: 0,

        queued: 0,

        failed: 0,

        results: [],
      };
    }

    // ============================================================
    // CREATE VENDOR NOTIFICATION
    // ============================================================

    try {
      const notification = await this.createBusinessNotification({
        // Business notification type
        type: "CANCELLED",

        userId,

        vendorId,

        // IMPORTANT:
        // PushProvider expects recipient.token
        recipient: {
          phoneNumber: vendorPhoneNumber,

          whatsappNumber: vendorPhoneNumber,

          pushToken: vendorFcmToken,
        },

        template: "booking_cancelled",

        templateData: {
          // Used by SMS / WhatsApp templates
          name: userName,

          formattedDate: cancellationDate,

          // Push notification
          title: "Booking Cancelled",

          body: `${userName} has cancelled the booking for ${cancellationDate}.`,

          // Flutter notification type
          type: "cancelled",

          // Flutter navigation
          screen: "orders",

          // IMPORTANT:
          // Everything inside `data` is forwarded
          // to Firebase by PushProvider.
          data: {
            // Existing Flutter fields
            id: bookingId,

            bookingId: bookingId,

            month,

            year,

            // NEW: identify recipient
            recipientRole: "vendor",

            // NEW: identify exact notification
            notificationType: "booking_cancelled",
          },
        },

        source: "booking",

        sourceId: bookingId,

        requestId,

        priority: 1,

        tags: ["booking", "booking_cancelled", "vendor"],

        // Idempotent logical notification
        idempotencyKey: `booking:${bookingId}:cancelled:vendor`,
      });

      // ============================================================
      // SUCCESS LOG
      // ============================================================

      NotificationLogger.info(
        {
          event: "BOOKING_CANCEL_NOTIFICATION_QUEUED",

          bookingId,

          notificationId: notification?._id?.toString() || null,

          userId,

          vendorId,

          channel: notification?.channel || null,

          channelPolicy: notification?.channelPolicy || null,

          recipientRole: "vendor",

          notificationType: "booking_cancelled",

          requestId,
        },

        "Booking cancellation notification queued",
      );

      // ============================================================
      // RESULT
      // ============================================================

      return {
        attempted: 1,

        queued: 1,

        failed: 0,

        results: [
          {
            recipientType: "vendor",

            success: true,

            notificationId: notification?._id?.toString() || null,

            channel: notification?.channel || null,

            recipientRole: "vendor",

            notificationType: "booking_cancelled",
          },
        ],
      };
    } catch (error) {
      // ============================================================
      // ERROR
      // ============================================================

      NotificationLogger.error(
        {
          err: error,

          event: "BOOKING_CANCEL_NOTIFICATION_QUEUE_FAILED",

          bookingId,

          userId,

          vendorId,

          requestId,

          error: error?.message,

          errorCode: error?.code,
        },

        "Failed to queue booking cancellation notification",
      );

      // IMPORTANT:
      // Booking cancellation has already been committed.
      //
      // Notification failure must NOT make the
      // cancellation API fail.
      return {
        attempted: 1,

        queued: 0,

        failed: 1,

        results: [
          {
            recipientType: "vendor",

            success: false,

            error: error?.message || "Failed to queue booking cancellation notification",

            recipientRole: "vendor",

            notificationType: "booking_cancelled",
          },
        ],
      };
    }
  }

  // ============================================================
  // BOOKING COMPLETED
  // ============================================================

  /**
   * Booking Completed
   *
   * ONE logical notification.
   *
   * Policy:
   *
   * PUSH
   *   ↓ failure
   * WHATSAPP
   *   ↓ failure
   * SMS
   *
   * IMPORTANT:
   *
   * This method should be called AFTER the booking completion
   * transaction has successfully committed.
   *
   * Notification failure must NEVER make the completed booking
   * transaction fail.
   */
  static async bookingCompleted({ booking, user, vendor, amount = null, requestId = null }) {
    const bookingId = booking?._id?.toString();

    if (!bookingId) {
      throw new Error("booking._id is required for booking completion notification");
    }

    // ==========================================================
    // IDs
    // ==========================================================

    const userId =
      user?._id?.toString() ||
      booking?.userId?._id?.toString() ||
      booking?.userId?.toString() ||
      null;

    const vendorId =
      vendor?._id?.toString() ||
      booking?.vendorId?._id?.toString() ||
      booking?.vendorId?.toString() ||
      null;

    // ==========================================================
    // VENDOR CONTACT
    // ==========================================================

    const vendorPhoneNumber = vendor?.phoneNo || booking?.vendorId?.phoneNo || null;

    const vendorFcmToken = vendor?.fcmToken || booking?.vendorId?.fcmToken || null;

    // ==========================================================
    // USER CONTACT
    // ==========================================================

    const userPhoneNumber = user?.phoneNo || booking?.userId?.phoneNo || null;

    const userFcmToken = user?.fcmToken || booking?.userId?.fcmToken || null;

    // ==========================================================
    // USER / VENDOR NAME
    // ==========================================================

    const userName = user?.name || booking?.userId?.name || "Customer";

    const vendorName = vendor?.name || booking?.vendorId?.name || "Service Provider";

    // ==========================================================
    // BOOKING DATE
    // ==========================================================

    let bookingDate = "";

    if (booking?.bookingDate) {
      const date = new Date(booking.bookingDate);

      if (!Number.isNaN(date.getTime())) {
        bookingDate = date.toDateString();
      }
    }

    // ==========================================================
    // AMOUNT
    // ==========================================================

    const notificationAmount =
      amount ?? booking?.amount ?? booking?.totalAmount ?? booking?.wage ?? 0;

    // ==========================================================
    // FLUTTER DATA
    // ==========================================================

    let month = "";
    let year = "";

    if (booking?.bookingDate) {
      const date = new Date(booking.bookingDate);

      if (!Number.isNaN(date.getTime())) {
        month = date.getMonth().toString();
        year = date.getFullYear().toString();
      }
    }

    // ==========================================================
    // LOG
    // ==========================================================

    NotificationLogger.info(
      {
        event: "BOOKING_COMPLETED_NOTIFICATION_STARTED",

        bookingId,

        userId,

        vendorId,

        bookingDate,

        amount: notificationAmount,

        hasUserPhone: Boolean(userPhoneNumber),

        hasUserFcmToken: Boolean(userFcmToken),

        hasVendorPhone: Boolean(vendorPhoneNumber),

        hasVendorFcmToken: Boolean(vendorFcmToken),

        requestId,
      },

      "Preparing booking completion notification",
    );

    // ==========================================================
    // RECIPIENT VALIDATION
    // ==========================================================

    if (!userPhoneNumber && !userFcmToken && !vendorPhoneNumber && !vendorFcmToken) {
      NotificationLogger.warn(
        {
          event: "BOOKING_COMPLETED_NOTIFICATION_SKIPPED",

          bookingId,

          userId,

          vendorId,

          requestId,

          reason: "NO_NOTIFICATION_RECIPIENT",
        },

        "No valid booking completion notification recipient",
      );

      return {
        attempted: 0,
        queued: 0,
        failed: 0,
        results: [],
      };
    }

    const results = [];

    // ==========================================================
    // USER NOTIFICATION
    // ==========================================================

    if (userPhoneNumber || userFcmToken) {
      try {
        const notification = await this.createBusinessNotification({
          type: "BOOKING_COMPLETED",

          userId,

          vendorId,

          recipient: {
            phoneNumber: null,

            whatsappNumber: userPhoneNumber || null,

            pushToken: userFcmToken || null,
          },

          template: "booking_completed_user",

          templateData: {
            // SMS / WhatsApp
            name: userName,

            bookingDate,

            amount: notificationAmount,

            bookingId,

            // PUSH
            title: "Booking Completed",

            body: `Your booking has been completed successfully.`,

            type: "booking_completed",

            screen: "orders",

            data: {
              id: bookingId,

              bookingId,

              month,

              year,
            },
          },

          source: "booking",

          sourceId: bookingId,

          requestId,

          priority: 2,

          tags: ["booking", "booking_completed", "user"],

          idempotencyKey: `booking:${bookingId}:completed:user`,
        });

        results.push({
          recipientType: "user",

          success: true,

          notificationId: notification?._id?.toString() || null,

          channel: notification?.channel || null,
        });

        NotificationLogger.info(
          {
            event: "BOOKING_COMPLETED_USER_NOTIFICATION_QUEUED",

            bookingId,

            notificationId: notification?._id,

            userId,

            requestId,
          },

          "Booking completion notification queued for user",
        );
      } catch (error) {
        results.push({
          recipientType: "user",

          success: false,

          error: error?.message || "Failed to queue booking completion notification",
        });

        NotificationLogger.error(
          {
            err: error,

            event: "BOOKING_COMPLETED_USER_NOTIFICATION_FAILED",

            bookingId,

            userId,

            requestId,

            errorCode: error?.code,
          },

          "Failed to queue booking completion notification for user",
        );
      }
    }

    // ==========================================================
    // VENDOR NOTIFICATION
    // ==========================================================

    if (vendorPhoneNumber || vendorFcmToken) {
      try {
        const notification = await this.createBusinessNotification({
          type: "BOOKING_COMPLETED",

          userId,

          vendorId,

          recipient: {
            phoneNumber: vendorPhoneNumber || null,

            whatsappNumber: vendorPhoneNumber || null,

            pushToken: vendorFcmToken || null,
          },

          template: "booking_completed_vendor",

          templateData: {
            // SMS / WhatsApp
            name: vendorName,

            customerName: userName,

            bookingDate,

            amount: notificationAmount,

            bookingId,

            // PUSH
            title: "Booking Completed",

            body: `Booking for ${userName} has been completed.`,

            type: "booking_completed",

            screen: "orders",

            data: {
              id: bookingId,

              bookingId,

              month,

              year,
            },
          },

          source: "booking",

          sourceId: bookingId,

          requestId,

          priority: 2,

          tags: ["booking", "booking_completed", "vendor"],

          idempotencyKey: `booking:${bookingId}:completed:vendor`,
        });

        results.push({
          recipientType: "vendor",

          success: true,

          notificationId: notification?._id?.toString() || null,

          channel: notification?.channel || null,
        });

        NotificationLogger.info(
          {
            event: "BOOKING_COMPLETED_VENDOR_NOTIFICATION_QUEUED",

            bookingId,

            notificationId: notification?._id,

            vendorId,

            requestId,
          },

          "Booking completion notification queued for vendor",
        );
      } catch (error) {
        results.push({
          recipientType: "vendor",

          success: false,

          error: error?.message || "Failed to queue booking completion notification",
        });

        NotificationLogger.error(
          {
            err: error,

            event: "BOOKING_COMPLETED_VENDOR_NOTIFICATION_FAILED",

            bookingId,

            vendorId,

            requestId,

            errorCode: error?.code,
          },

          "Failed to queue booking completion notification for vendor",
        );
      }
    }

    // ==========================================================
    // FINAL RESULT
    // ==========================================================

    const queued = results.filter((result) => result.success).length;

    const failed = results.filter((result) => !result.success).length;

    NotificationLogger.info(
      {
        event: "BOOKING_COMPLETED_NOTIFICATIONS_COMPLETED",

        bookingId,

        userId,

        vendorId,

        requestId,

        attempted: results.length,

        queued,

        failed,
      },

      "Booking completion notifications completed",
    );

    return {
      attempted: results.length,

      queued,

      failed,

      results,
    };
  }

  // ============================================================
  // SELF BOOKING
  // ============================================================

  /**
   * Self booking is intentionally left as direct SMS
   * for now.
   *
   * We can migrate it separately after the main
   * BOOKING/CANCELLED flow is working.
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

          bookingId,
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

      // Booking already committed.
      // Notification failure must not make booking fail.

      return null;
    }
  }
}

// ============================================================
// EXPORT
// ============================================================

module.exports = NotificationService;
