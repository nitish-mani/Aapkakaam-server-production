"use strict";

const mongoose = require("mongoose");
const { Schema } = mongoose;
const logger = require("../src/logger/logger"); // ✅ Import logger

// Constants
const VALID_NOTIFICATION_TYPES = ["SMS", "EMAIL", "PUSH", "TELEGRAM", "WHATSAPP", "IN_APP"];
const VALID_STATUSES = [
  "created",
  "queued",
  "processing",
  "retrying",
  "sent",
  "failed",
  "cancelled",
];
const VALID_SOURCES = [
  "payment",
  "booking",
  "auth",
  "wallet",
  "admin",
  "system",
  "marketing",
  "monitoring",
  "referral",
  "webhook",
  "cron",
];
const MAX_FAILURE_HISTORY = 10;
const NOTIFICATION_TTL_DAYS = 90;

const notificationSchema = new Schema(
  {
    /**
     * Owner - Optional, at least one should be present
     */
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      index: true,
    },
    vendorId: {
      type: Schema.Types.ObjectId,
      ref: "Vendor",
      index: true,
    },

    /**
     * Notification Type - Uppercase normalized
     */
    type: {
      type: String,
      enum: VALID_NOTIFICATION_TYPES,
      required: true,
      index: true,
      set: function (value) {
        if (value) {
          return value.toUpperCase();
        }
        return value;
      },
    },

    /**
     * Recipient Information
     */
    recipient: {
      userId: {
        type: Schema.Types.ObjectId,
        ref: "User",
      },
      vendorId: {
        type: Schema.Types.ObjectId,
        ref: "Vendor",
      },
      phoneNumber: String,
      email: String,
      pushToken: String,
      telegramChatId: String,
    },

    /**
     * Template Name
     * Examples: payment_success, booking_confirmed, otp, withdrawal_success
     */
    template: {
      type: String,
      required: true,
      index: true,
    },

    /**
     * Content and Template Data
     */
    content: {
      subject: String, // For emails
      body: String, // For push and in-app
      templateData: {
        type: Schema.Types.Mixed,
        default: {},
      },
      attachments: [
        {
          filename: String,
          url: String,
          mimeType: String,
          size: Number,
        },
      ],
    },

    /**
     * Status - State machine
     */
    status: {
      type: String,
      enum: VALID_STATUSES,
      default: "created",
      index: true,
    },

    /**
     * Retry Configuration
     */
    attempts: {
      type: Number,
      default: 0,
      min: 0,
    },
    maxAttempts: {
      type: Number,
      default: 5,
      min: 1,
      max: 20,
    },
    lastAttempt: Date,
    nextRetry: Date,

    /**
     * Processing Results
     */
    success: {
      type: Boolean,
      default: false,
    },
    error: {
      code: String,
      message: String,
      details: Schema.Types.Mixed,
    },
    response: {
      providerMessageId: String,
      requestId: String,
      deliveryId: String,
      accepted: Boolean,
      status: String,
      timestamp: Date,
      latency: Number,
      provider: String,
      sid: String,
      messageId: String,
      msgId: String,
    },

    /**
     * Failure History - Limited to prevent document bloat
     */
    failureHistory: [
      {
        attempt: {
          type: Number,
          required: true,
        },
        error: {
          code: String,
          message: String,
          details: Schema.Types.Mixed,
        },
        timestamp: {
          type: Date,
          default: Date.now,
        },
      },
    ],

    /**
     * Performance Metrics
     */
    performance: {
      queuedAt: Date,
      processingStartedAt: Date,
      processingEndedAt: Date,
      totalProcessingTime: Number, // milliseconds
      providerLatency: Number, // milliseconds
    },

    /**
     * Delivery Tracking
     */
    delivery: {
      sentAt: Date,
      deliveredAt: Date,
      readAt: Date,
      attempts: Number,
      providerLatency: Number,
      deliveredVia: String,
    },

    /**
     * Metadata and Context
     */
    requestId: {
      type: String,
      // index: true, // REMOVED - Will be defined in schema.index() below
    },
    source: {
      type: String,
      enum: VALID_SOURCES,
      default: "system",
      index: true,
    },
    sourceId: {
      type: String,
      index: true,
    },
    /**
     * Business-level idempotency key.
     *
     * Identifies one logical notification.
     *
     * Examples:
     *
     * booking:<bookingId>:created:vendor:sms
     * booking:<bookingId>:cancelled:vendor:sms
     * booking:<bookingId>:self-created:vendor:sms
     *
     * This prevents duplicate Notification documents when the
     * same business event is processed more than once.
     */
    idempotencyKey: {
      type: String,
      required: true,
      trim: true,
    },

    /**
     * Priority - Higher number = higher priority
     */
    priority: {
      type: Number,
      default: 5,
      min: 1,
      max: 10,
      index: true,
    },

    /**
     * Scheduling
     */
    scheduledAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
    expiresAt: {
      type: Date,
      // index: true, // REMOVED - Will be defined in schema.index() below
    },

    /**
     * Audit Trail
     */
    queuedAt: {
      type: Date,
      default: null,
    },
    sentAt: Date,
    processedAt: Date,
    cancelledAt: Date,
    failureReason: {
      type: String,
      enum: [
        "permanent_error",
        "retries_exhausted",
        "timeout",
        "cancelled",
        "expired",
        "invalid_type",
        "retry_scheduled",
      ],
    },

    /**
     * Tags for filtering and analytics
     */
    tags: [
      {
        type: String,
        index: true,
      },
    ],
  },
  {
    timestamps: {
      createdAt: "createdAt",
      updatedAt: "updatedAt",
    },
    versionKey: "__v",
    optimisticConcurrency: true,
    collation: { locale: "en", strength: 2 },
  },
);

// ============================================
// INDEXES - All indexes defined here
// ============================================

// Queue processing - priority queue
notificationSchema.index({
  status: 1,
  priority: -1,
  scheduledAt: 1,
});

// Retry processing - scheduled retries
notificationSchema.index(
  {
    status: 1,
    nextRetry: 1,
  },
  {
    partialFilterExpression: {
      status: "retrying",
      nextRetry: { $exists: true },
    },
  },
);
notificationSchema.index(
  {
    idempotencyKey: 1,
  },
  {
    unique: true,
    name: "unique_notification_idempotency_key",
  },
);
// User history queries
notificationSchema.index({
  userId: 1,
  createdAt: -1,
});

// Vendor history queries
notificationSchema.index({
  vendorId: 1,
  createdAt: -1,
});

// Source tracking
notificationSchema.index({
  source: 1,
  sourceId: 1,
});

// Request tracking
notificationSchema.index({
  requestId: 1,
});

// Type and template analytics
notificationSchema.index({
  type: 1,
  template: 1,
  status: 1,
});

// Composite recipient lookup
notificationSchema.index({
  "recipient.phoneNumber": 1,
  "recipient.email": 1,
});

// Recipient userId lookup
notificationSchema.index({
  "recipient.userId": 1,
});

// Recipient vendorId lookup
notificationSchema.index({
  "recipient.vendorId": 1,
});

// Status and createdAt for cleanup
notificationSchema.index({
  status: 1,
  createdAt: 1,
});

// Expiry cleanup - Only index if expiresAt exists
notificationSchema.index(
  { expiresAt: 1 },
  {
    partialFilterExpression: {
      expiresAt: { $exists: true },
    },
  },
);

// TTL index for auto-deletion after 90 days
// Only applies to terminal states (sent, failed, cancelled)
notificationSchema.index(
  { createdAt: 1 },
  {
    expireAfterSeconds: NOTIFICATION_TTL_DAYS * 24 * 60 * 60,
    partialFilterExpression: {
      status: { $in: ["sent", "failed", "cancelled"] },
    },
  },
);

// ============================================
// PRE-VALIDATE HOOK - Normalize Types
// ============================================

notificationSchema.pre("validate", function (next) {
  // Normalize type to uppercase
  if (this.type) {
    this.type = this.type.toUpperCase();
  }

  // Ensure at least one owner is set
  if (!this.userId && !this.vendorId && !this.recipient?.userId && !this.recipient?.vendorId) {
    return next(new Error("At least one owner (userId, vendorId, or recipient) is required"));
  }

  // Validate retry configuration
  if (this.attempts > this.maxAttempts) {
    return next(
      new Error(`Attempts (${this.attempts}) cannot exceed maxAttempts (${this.maxAttempts})`),
    );
  }

  next();
});

// ============================================
// PRE-SAVE HOOK - Auto-set fields
// ============================================

notificationSchema.pre("save", function (next) {
  // Auto-set queuedAt if status is queued and not set
  if (this.status === "queued" && !this.queuedAt) {
    this.queuedAt = new Date();
  }

  // Auto-set performance queuedAt
  if (!this.performance) {
    this.performance = {};
  }

  // Limit failureHistory to prevent document bloat
  if (this.failureHistory && this.failureHistory.length > MAX_FAILURE_HISTORY) {
    this.failureHistory = this.failureHistory.slice(-MAX_FAILURE_HISTORY);
  }

  // Ensure nextRetry is valid if status is retrying
  if (this.status === "retrying" && this.nextRetry && this.nextRetry < new Date()) {
    this.nextRetry = new Date(Date.now() + 60000); // Set to 1 minute from now
  }

  next();
});

// ============================================
// INSTANCE METHODS
// ============================================

notificationSchema.methods.markQueued = function () {
  const now = new Date();

  this.status = "queued";
  this.queuedAt = now;

  if (!this.performance) {
    this.performance = {};
  }

  this.performance.queuedAt = now;

  this.updatedAt = now;

  return this;
};

/**
 * Mark notification as processing
 */
notificationSchema.methods.markProcessing = function () {
  const now = new Date();

  if (!this.performance) {
    this.performance = {};
  }

  this.status = "processing";
  this.lastAttempt = now;
  this.attempts += 1;

  this.performance.processingStartedAt = now;

  this.updatedAt = now;

  return this;
};

/**
 * Mark notification as sent
 */
notificationSchema.methods.markSent = function (providerResponse) {
  this.status = "sent";
  this.success = true;
  this.sentAt = new Date();
  this.processedAt = new Date();
  this.performance.processingEndedAt = new Date();
  this.performance.totalProcessingTime =
    this.performance.processingEndedAt - this.performance.processingStartedAt;

  if (providerResponse) {
    this.response = providerResponse;
    this.delivery = {
      sentAt: new Date(),
      attempts: this.attempts,
      providerLatency: this.performance.totalProcessingTime,
      deliveredVia: this.type,
      ...providerResponse,
    };
  }

  this.updatedAt = new Date();
  return this;
};

/**
 * Mark notification as failed
 */
notificationSchema.methods.markFailed = function (error, reason = "permanent_error") {
  this.status = "failed";
  this.success = false;
  this.processedAt = new Date();
  this.performance.processingEndedAt = new Date();
  this.failureReason = reason;

  if (error) {
    this.error = {
      code: error.code || "UNKNOWN_ERROR",
      message: error.message || "Unknown error",
      details: error.details || {},
    };
  }

  // Add to failure history
  this.failureHistory.push({
    attempt: this.attempts,
    error: this.error,
    timestamp: new Date(),
  });

  this.updatedAt = new Date();
  return this;
};

/**
 * Mark notification as retrying
 */
notificationSchema.methods.markRetrying = function (error, nextRetryDelay) {
  this.status = "retrying";
  this.success = false;
  this.processedAt = new Date();
  this.performance.processingEndedAt = new Date();

  if (error) {
    this.error = {
      code: error.code || "RETRYABLE_ERROR",
      message: error.message || "Retryable error occurred",
      details: error.details || {},
    };
  }

  this.nextRetry = new Date(Date.now() + nextRetryDelay);

  // Add to failure history
  this.failureHistory.push({
    attempt: this.attempts,
    error: this.error,
    timestamp: new Date(),
  });

  this.updatedAt = new Date();
  return this;
};

/**
 * Mark notification as cancelled
 */
notificationSchema.methods.markCancelled = function () {
  this.status = "cancelled";
  this.cancelledAt = new Date();
  this.processedAt = new Date();
  this.failureReason = "cancelled";
  this.updatedAt = new Date();
  return this;
};

/**
 * Check if notification is in terminal state
 */
notificationSchema.methods.isTerminal = function () {
  return ["sent", "failed", "cancelled"].includes(this.status);
};

/**
 * Check if notification is pending
 */
notificationSchema.methods.isPending = function () {
  return ["queued", "processing", "retrying"].includes(this.status);
};

/**
 * Check if notification is retryable
 */
notificationSchema.methods.isRetryable = function () {
  return (
    this.status === "failed" &&
    this.attempts < this.maxAttempts &&
    (!this.expiresAt || this.expiresAt > new Date())
  );
};

/**
 * Check if notification is expired
 */
notificationSchema.methods.isExpired = function () {
  if (!this.expiresAt) return false;
  return new Date() > this.expiresAt;
};

// ============================================
// STATIC METHODS
// ============================================

/**
 * Get pending notifications ready for processing
 */
notificationSchema.statics.getPendingNotifications = function (limit = 100) {
  const now = new Date();

  return this.find({
    status: { $in: ["queued", "retrying"] },
    scheduledAt: { $lte: now },
    $or: [{ expiresAt: { $exists: false } }, { expiresAt: { $gt: now } }],
  })
    .sort({ priority: -1, scheduledAt: 1 })
    .limit(limit)
    .lean();
};

/**
 * Get notification statistics
 */
notificationSchema.statics.getStats = function (filter = {}) {
  const match = { ...filter };

  if (filter.startDate || filter.endDate) {
    match.createdAt = {};
    if (filter.startDate) match.createdAt.$gte = new Date(filter.startDate);
    if (filter.endDate) match.createdAt.$lte = new Date(filter.endDate);
    delete filter.startDate;
    delete filter.endDate;
  }

  return this.aggregate([
    { $match: match },
    {
      $facet: {
        statusCounts: [
          {
            $group: {
              _id: "$status",
              count: { $sum: 1 },
            },
          },
        ],
        typeCounts: [
          {
            $group: {
              _id: "$type",
              count: { $sum: 1 },
            },
          },
        ],
        sourceCounts: [
          {
            $group: {
              _id: "$source",
              count: { $sum: 1 },
            },
          },
        ],
        performance: [
          {
            $group: {
              _id: null,
              avgProcessingTime: { $avg: "$performance.totalProcessingTime" },
              maxProcessingTime: { $max: "$performance.totalProcessingTime" },
              totalAttempts: { $sum: "$attempts" },
              avgAttempts: { $avg: "$attempts" },
            },
          },
        ],
        total: [
          {
            $group: {
              _id: null,
              total: { $sum: 1 },
            },
          },
        ],
        successRate: [
          {
            $group: {
              _id: null,
              successful: {
                $sum: { $cond: [{ $eq: ["$status", "sent"] }, 1, 0] },
              },
              failed: {
                $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] },
              },
              retrying: {
                $sum: { $cond: [{ $eq: ["$status", "retrying"] }, 1, 0] },
              },
            },
          },
        ],
      },
    },
  ]);
};

/**
 * Clean up old notifications
 */
notificationSchema.statics.cleanupOldNotifications = function (daysToKeep = 30) {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

  return this.deleteMany({
    status: { $in: ["sent", "failed", "cancelled"] },
    createdAt: { $lt: cutoffDate },
  });
};

// ============================================
// VIRTUAL PROPERTIES
// ============================================

notificationSchema.virtual("displayName").get(function () {
  const name = this.recipient?.name || this.recipient?.phoneNumber || this.recipient?.email;
  return name || "Unknown";
});

notificationSchema.virtual("isQueued").get(function () {
  return this.status === "queued";
});

notificationSchema.virtual("isProcessing").get(function () {
  return this.status === "processing";
});

notificationSchema.virtual("isRetrying").get(function () {
  return this.status === "retrying";
});

notificationSchema.virtual("isSent").get(function () {
  return this.status === "sent";
});

notificationSchema.virtual("isFailed").get(function () {
  return this.status === "failed";
});

notificationSchema.virtual("isCancelled").get(function () {
  return this.status === "cancelled";
});

// ============================================
// JSON TRANSFORM
// ============================================

notificationSchema.set("toJSON", {
  virtuals: true,
  transform: function (doc, ret) {
    delete ret.__v;
    return ret;
  },
});

notificationSchema.set("toObject", {
  virtuals: true,
});

// ============================================
// EXPORT
// ============================================

module.exports = mongoose.model("Notification", notificationSchema);
