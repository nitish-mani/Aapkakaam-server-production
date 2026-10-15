"use strict";

const mongoose = require("mongoose");

const vendorSearchOutboxSchema = new mongoose.Schema(
  {
    eventId: {
      type: String,
      required: true,
      immutable: true,
    },

    eventType: {
      type: String,
      required: true,
      enum: ["VENDOR_SEARCHED"],
      default: "VENDOR_SEARCHED",
    },

    searchBy: {
      type: String,
      enum: ["User", "Vendor"],
      required: true,
    },

    searchById: {
      type: mongoose.Schema.Types.ObjectId,
      refPath: "searchBy",
      required: true,
    },

    sessionId: {
      type: String,
      default: null,
    },

    type: {
      type: String,
      required: true,
      trim: true,
    },

    pincode: {
      type: String,
      required: true,
      trim: true,
    },

    bookingDate: {
      type: Date,
      required: true,
    },

    minRating: {
      type: Number,
      default: 0,
      min: 0,
      max: 5,
    },

    minWageRate: {
      type: Number,
      default: 0,
      min: 0,
    },

    page: {
      type: Number,
      default: 1,
      min: 1,
    },

    resultCount: {
      type: Number,
      required: true,
      min: 0,
    },

    candidateCount: {
      type: Number,
      default: 0,
      min: 0,
    },

    vendorIds: {
      type: [
        {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Vendor",
        },
      ],
      default: [],
    },

    cacheHit: {
      type: Boolean,
      default: null,
    },

    durationMs: {
      type: Number,
      min: 0,
    },

    platform: {
      type: String,
    },

    status: {
      type: String,
      enum: ["PENDING", "PROCESSING", "COMPLETED", "FAILED"],
      default: "PENDING",
    },

    attempts: {
      type: Number,
      default: 0,
      min: 0,
    },

    availableAt: {
      type: Date,
      default: Date.now,
    },

    processedAt: {
      type: Date,
      default: null,
    },

    lastError: {
      type: String,
      default: null,
    },

    // Worker lease and ownership fields.
    lockedAt: {
      type: Date,
      default: null,
    },

    lockToken: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
    versionKey: false,
    collection: "vendor_search_outbox",
  },
);

// Prevent duplicate event IDs.
vendorSearchOutboxSchema.index({ eventId: 1 }, { unique: true });

// Efficient polling and retry scheduling.
vendorSearchOutboxSchema.index({
  status: 1,
  availableAt: 1,
  createdAt: 1,
});

// Recover stale PROCESSING events.
vendorSearchOutboxSchema.index({
  status: 1,
  lockedAt: 1,
});

// Support search analytics queries.
vendorSearchOutboxSchema.index({
  type: 1,
  pincode: 1,
  createdAt: -1,
});

module.exports = mongoose.model("VendorSearchOutbox", vendorSearchOutboxSchema);
