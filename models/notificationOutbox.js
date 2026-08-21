const mongoose = require("mongoose");

const notificationOutboxSchema = new mongoose.Schema(
  {
    eventType: {
      type: String,
      required: true,
      enum: ["BOOKING_CREATED", "BOOKING_CANCELLED", "BOOKING_COMPLETED"],
      index: true,
    },

    bookingId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },

    userId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },

    vendorId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },

    payload: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },

    status: {
      type: String,
      enum: ["PENDING", "PROCESSING", "COMPLETED", "FAILED"],
      default: "PENDING",
      index: true,
    },

    attempts: {
      type: Number,
      default: 0,
    },

    availableAt: {
      type: Date,
      default: Date.now,
      index: true,
    },

    processedAt: {
      type: Date,
      default: null,
    },

    lastError: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

/**
 * Worker query:
 *
 * Find pending notifications that are ready.
 */
notificationOutboxSchema.index({
  status: 1,
  availableAt: 1,
});

/**
 * Prevent the same booking event from being inserted twice.
 *
 * This is extremely important because MongoDB transactions can
 * retry their callback.
 */
notificationOutboxSchema.index(
  {
    eventType: 1,
    bookingId: 1,
  },
  {
    unique: true,
  },
);

module.exports = mongoose.model("NotificationOutbox", notificationOutboxSchema);
