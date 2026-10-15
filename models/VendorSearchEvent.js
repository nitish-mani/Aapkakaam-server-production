"use strict";

const mongoose = require("mongoose");

const vendorSearchEventSchema = new mongoose.Schema(
  {
    eventId: {
      type: String,
      required: true,
      immutable: true,
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

    selectedVendorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Vendor",
      default: null,
    },

    bookingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Booking",
      default: null,
    },
  },
  {
    timestamps: {
      createdAt: true,
      updatedAt: false,
    },
    versionKey: false,
    collection: "vendor_search_events",
  },
);

// Unique event ID makes worker retries idempotent.
vendorSearchEventSchema.index({ eventId: 1 }, { unique: true });

// Recent analytics.
vendorSearchEventSchema.index({
  createdAt: -1,
});

// Service and location performance.
vendorSearchEventSchema.index({
  type: 1,
  pincode: 1,
  createdAt: -1,
});

// Service demand over time.
vendorSearchEventSchema.index({
  type: 1,
  createdAt: -1,
});

// Actor activity history.
vendorSearchEventSchema.index({
  searchById: 1,
  createdAt: -1,
});

module.exports = mongoose.model("VendorSearchEvent", vendorSearchEventSchema);
