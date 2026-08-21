"use strict";

const mongoose = require("mongoose");

const { Schema } = mongoose;

// ============================================
// ENUMS / CONSTANTS
// ============================================

const VALID_NOTIFICATION_TYPES = [
  "SMS",
  "EMAIL",
  "PUSH",
  "TELEGRAM",
  "WHATSAPP",
  "IN_APP",
  "OTP",
  "BOOKING",
  "CANCELLED",
  "PAYMENT",
];

const VALID_CHANNELS = ["SMS", "EMAIL", "PUSH", "TELEGRAM", "WHATSAPP", "IN_APP"];

const VALID_DELIVERY_STATUSES = ["pending", "processing", "sent", "failed", "skipped"];

const DEFAULT_CHANNEL_POLICIES = {
  OTP: ["SMS", "WHATSAPP"],
  BOOKING: ["PUSH", "WHATSAPP", "SMS"],
  CANCELLED: ["PUSH", "WHATSAPP", "SMS"],
  PAYMENT: ["PUSH", "WHATSAPP", "SMS"],
};

const VALID_STATUSES = [
  "created",
  "queued",
  "processing",
  "retrying",
  "sent",
  "failed",
  "cancelled",
];

const VALID_PRIORITIES = [1, 2, 3, 4, 5];

// ============================================
// NOTIFICATION SCHEMA
// ============================================

const notificationSchema = new Schema(
  {
    // ==========================================
    // BUSINESS / LEGACY TYPE
    // ==========================================

    /**
     * IMPORTANT:
     *
     * `type` is kept backward compatible.
     *
     * Existing code can continue using:
     *
     *   type: "SMS"
     *   type: "PUSH"
     *   type: "WHATSAPP"
     *
     * New business notification code can eventually
     * use:
     *
     *   type: "BOOKING"
     *   type: "PAYMENT"
     *   type: "CANCELLED"
     *   type: "OTP"
     *
     * after NotificationService is migrated.
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

    // ==========================================
    // DELIVERY CHANNEL
    // ==========================================

    /**
     * Actual channel currently being attempted.
     *
     * Example:
     *
     * BOOKING
     *   channel = PUSH
     *
     * PUSH fails:
     *   channel = WHATSAPP
     *
     * WhatsApp fails:
     *   channel = SMS
     */
    channel: {
      type: String,
      enum: VALID_CHANNELS,
      default: null,
      index: true,
    },

    // ==========================================
    // CHANNEL POLICY
    // ==========================================

    /**
     * Defines delivery order and fallback behavior.
     *
     * Example:
     *
     * {
     *   channels: ["PUSH", "WHATSAPP", "SMS"],
     *   fallback: true
     * }
     */
    channelPolicy: {
      channels: {
        type: [String],
        enum: VALID_CHANNELS,
        default: [],
      },

      fallback: {
        type: Boolean,
        default: true,
      },
    },

    /**
     * Current index inside channelPolicy.channels.
     *
     * 0 = PUSH
     * 1 = WHATSAPP
     * 2 = SMS
     */
    channelIndex: {
      type: Number,
      default: 0,
      min: 0,
    },

    // ==========================================
    // DELIVERY ATTEMPTS
    // ==========================================

    /**
     * Tracks every provider/channel attempt.
     *
     * Example:
     *
     * PUSH      -> failed
     * WHATSAPP  -> failed
     * SMS       -> sent
     */
    deliveryAttempts: [
      {
        channel: {
          type: String,
          enum: VALID_CHANNELS,
          required: true,
        },

        status: {
          type: String,
          enum: VALID_DELIVERY_STATUSES,
          required: true,
        },

        attempt: {
          type: Number,
          min: 1,
        },

        startedAt: {
          type: Date,
        },

        completedAt: {
          type: Date,
        },

        provider: {
          type: String,
        },

        providerMessageId: {
          type: String,
        },

        error: {
          code: {
            type: String,
          },

          message: {
            type: String,
          },

          details: {
            type: Schema.Types.Mixed,
          },
        },
      },
    ],

    // ==========================================
    // RECIPIENT
    // ==========================================

    recipient: {
      userId: {
        type: Schema.Types.ObjectId,
        ref: "User",
        default: null,
      },

      vendorId: {
        type: Schema.Types.ObjectId,
        ref: "Vendor",
        default: null,
      },

      phoneNumber: {
        type: String,
        default: null,
      },

      email: {
        type: String,
        default: null,
      },

      pushToken: {
        type: String,
        default: null,
      },

      telegramChatId: {
        type: String,
        default: null,
      },

      whatsappNumber: {
        type: String,
        default: null,
      },
    },

    // ==========================================
    // TEMPLATE
    // ==========================================

    template: {
      type: String,
      required: true,
      index: true,
      trim: true,
    },

    // ==========================================
    // CONTENT
    // ==========================================

    content: {
      subject: {
        type: String,
        default: null,
      },

      body: {
        type: String,
        default: null,
      },

      templateData: {
        type: Schema.Types.Mixed,
        default: {},
      },
    },

    // ==========================================
    // SOURCE
    // ==========================================

    source: {
      type: String,
      default: "system",
      index: true,
      trim: true,
    },

    sourceId: {
      type: String,
      default: null,
      index: true,
    },

    // ==========================================
    // REQUEST / TRACE
    // ==========================================

    requestId: {
      type: String,
      default: null,
      index: true,
    },

    // ==========================================
    // PRIORITY
    // ==========================================

    priority: {
      type: Number,
      enum: VALID_PRIORITIES,
      default: 5,
      index: true,
    },

    // ==========================================
    // STATUS
    // ==========================================

    status: {
      type: String,
      enum: VALID_STATUSES,
      default: "created",
      index: true,
    },

    // ==========================================
    // SUCCESS
    // ==========================================

    success: {
      type: Boolean,
      default: false,
      index: true,
    },

    // ==========================================
    // RETRY
    // ==========================================

    attempts: {
      type: Number,
      default: 0,
      min: 0,
    },

    maxAttempts: {
      type: Number,
      default: 3,
      min: 0,
    },

    nextRetry: {
      type: Date,
      default: null,
    },

    // ==========================================
    // SCHEDULING
    // ==========================================

    scheduledAt: {
      type: Date,
      default: Date.now,
      index: true,
    },

    expiresAt: {
      type: Date,
      default: null,
      index: true,
    },

    // ==========================================
    // DELIVERY INFORMATION
    // ==========================================

    delivery: {
      provider: {
        type: String,
        default: null,
      },

      providerMessageId: {
        type: String,
        default: null,
      },

      deliveredAt: {
        type: Date,
        default: null,
      },

      deliveredVia: {
        type: String,
        default: null,
      },
    },

    // ==========================================
    // FAILURE HISTORY
    // ==========================================

    failureHistory: [
      {
        attempt: {
          type: Number,
        },

        channel: {
          type: String,
          default: null,
        },

        errorCode: {
          type: String,
          default: null,
        },

        errorMessage: {
          type: String,
          default: null,
        },

        occurredAt: {
          type: Date,
          default: Date.now,
        },
      },
    ],

    // ==========================================
    // TAGS
    // ==========================================

    tags: {
      type: [String],
      default: [],
      index: true,
    },

    // ==========================================
    // IDEMPOTENCY
    // ==========================================

    /**
     * IMPORTANT:
     *
     * Use ONE idempotency key per business event.
     *
     * Correct:
     *
     * booking:123:created:vendor
     *
     * Incorrect:
     *
     * booking:123:created:vendor:sms
     * booking:123:created:vendor:push
     *
     * SMS/PUSH/WhatsApp are fallback attempts for
     * the same logical notification.
     */
    idempotencyKey: {
      type: String,
      required: true,
      unique: true,
      index: true,
      trim: true,
    },

    // ==========================================
    // TIMESTAMPS
    // ==========================================

    createdAt: {
      type: Date,
      default: Date.now,
      index: true,
    },

    updatedAt: {
      type: Date,
      default: Date.now,
    },

    queuedAt: {
      type: Date,
      default: null,
    },

    processingStartedAt: {
      type: Date,
      default: null,
    },

    sentAt: {
      type: Date,
      default: null,
    },

    failedAt: {
      type: Date,
      default: null,
    },

    cancelledAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: false,

    strict: true,

    minimize: false,
  },
);

// ============================================
// INDEXES
// ============================================

notificationSchema.index({
  status: 1,
  priority: 1,
  scheduledAt: 1,
});

notificationSchema.index({
  userId: 1,
  createdAt: -1,
});

notificationSchema.index({
  vendorId: 1,
  createdAt: -1,
});

notificationSchema.index({
  source: 1,
  sourceId: 1,
});

notificationSchema.index({
  type: 1,
  template: 1,
  status: 1,
});

notificationSchema.index({
  type: 1,
  channel: 1,
  status: 1,
});

notificationSchema.index({
  channel: 1,
  status: 1,
  scheduledAt: 1,
});

// ============================================
// INSTANCE METHODS
// ============================================

/**
 * Get the effective channel policy.
 *
 * Legacy notification:
 *
 * type = SMS
 * -> SMS only
 *
 * type = PUSH
 * -> PUSH only
 *
 * New business notification:
 *
 * type = BOOKING
 * channelPolicy =
 * PUSH -> WHATSAPP -> SMS
 */
notificationSchema.methods.getChannelPolicy = function () {
  if (this.channelPolicy?.channels?.length) {
    return {
      channels: this.channelPolicy.channels,
      fallback: this.channelPolicy.fallback !== false,
    };
  }

  // Backward compatibility.
  if (VALID_CHANNELS.includes(this.type)) {
    return {
      channels: [this.type],
      fallback: false,
    };
  }

  // Future business-event support.
  return {
    channels: DEFAULT_CHANNEL_POLICIES[this.type] || ["PUSH"],
    fallback: true,
  };
};

/**
 * Get the channel currently being attempted.
 */
notificationSchema.methods.getCurrentChannel = function () {
  const policy = this.getChannelPolicy();

  return policy.channels[this.channelIndex] || null;
};

/**
 * Move to next fallback channel.
 *
 * Returns:
 *
 * true  = fallback available
 * false = no fallback available
 */
notificationSchema.methods.moveToNextChannel = function () {
  const policy = this.getChannelPolicy();

  if (!policy.fallback) {
    return false;
  }

  const nextIndex = this.channelIndex + 1;

  if (nextIndex >= policy.channels.length) {
    return false;
  }

  this.channelIndex = nextIndex;

  this.channel = policy.channels[nextIndex];

  this.status = "queued";

  this.success = false;

  this.nextRetry = null;

  this.updatedAt = new Date();

  return true;
};

/**
 * Record provider/channel attempt.
 */
notificationSchema.methods.recordDeliveryAttempt = function ({
  channel,
  status,
  attempt,
  startedAt,
  completedAt,
  provider,
  providerMessageId,
  error,
}) {
  this.deliveryAttempts.push({
    channel,
    status,
    attempt,
    startedAt,
    completedAt,
    provider,
    providerMessageId,

    error: error
      ? {
          code: error.code || "UNKNOWN_ERROR",

          message: error.message || "Unknown notification provider error",

          details: error.details || {},
        }
      : undefined,
  });

  return this;
};

/**
 * Mark notification queued.
 */
notificationSchema.methods.markQueued = function () {
  const now = new Date();

  // Determine initial channel.
  if (!this.channel) {
    if (this.channelPolicy?.channels?.length) {
      this.channel =
        this.channelPolicy.channels[this.channelIndex] || this.channelPolicy.channels[0];
    } else if (VALID_CHANNELS.includes(this.type)) {
      // Backward compatibility.
      this.channel = this.type;
    }
  }

  this.status = "queued";

  this.queuedAt = now;

  this.updatedAt = now;

  return this;
};

/**
 * Mark notification processing.
 */
notificationSchema.methods.markProcessing = function () {
  const now = new Date();

  this.status = "processing";

  this.processingStartedAt = now;

  this.updatedAt = now;

  return this;
};

/**
 * Mark notification sent.
 */
notificationSchema.methods.markSent = function ({
  provider = null,
  providerMessageId = null,
  deliveredVia = null,
} = {}) {
  const now = new Date();

  this.status = "sent";

  this.success = true;

  this.sentAt = now;

  this.updatedAt = now;

  this.delivery.provider = provider;

  this.delivery.providerMessageId = providerMessageId;

  this.delivery.deliveredAt = now;

  this.delivery.deliveredVia = deliveredVia || this.channel || this.type;

  return this;
};

/**
 * Mark notification failed.
 */
notificationSchema.methods.markFailed = function ({ errorCode = null, errorMessage = null } = {}) {
  const now = new Date();

  this.status = "failed";

  this.success = false;

  this.failedAt = now;

  this.updatedAt = now;

  if (errorCode || errorMessage) {
    this.failureHistory.push({
      attempt: this.attempts,

      channel: this.channel || this.type,

      errorCode,

      errorMessage,

      occurredAt: now,
    });
  }

  return this;
};

/**
 * Mark notification cancelled.
 */
notificationSchema.methods.markCancelled = function () {
  const now = new Date();

  this.status = "cancelled";

  this.success = false;

  this.cancelledAt = now;

  this.updatedAt = now;

  return this;
};

// ============================================
// PRE VALIDATE
// ============================================

notificationSchema.pre("validate", function (next) {
  // Validate retry configuration.
  if (this.attempts > this.maxAttempts) {
    return next(
      new Error(`Attempts (${this.attempts}) cannot exceed maxAttempts (${this.maxAttempts})`),
    );
  }

  // Existing notifications:
  //
  // type = SMS
  // type = PUSH
  //
  // automatically get the matching channel.
  if (!this.channel && VALID_CHANNELS.includes(this.type)) {
    this.channel = this.type;
  }

  // Validate channel policy.
  if (this.channelPolicy?.channels?.length) {
    if (this.channelIndex >= this.channelPolicy.channels.length) {
      return next(new Error(`channelIndex (${this.channelIndex}) is outside channelPolicy range`));
    }

    if (!this.channel) {
      this.channel =
        this.channelPolicy.channels[this.channelIndex] || this.channelPolicy.channels[0];
    }
  }

  next();
});

// ============================================
// PRE SAVE
// ============================================

notificationSchema.pre("save", function (next) {
  this.updatedAt = new Date();

  next();
});

// ============================================
// MODEL
// ============================================

const Notification = mongoose.model("Notification", notificationSchema);

// Export constants for worker/dispatcher.
Notification.VALID_CHANNELS = VALID_CHANNELS;

Notification.VALID_DELIVERY_STATUSES = VALID_DELIVERY_STATUSES;

Notification.DEFAULT_CHANNEL_POLICIES = DEFAULT_CHANNEL_POLICIES;

module.exports = Notification;
