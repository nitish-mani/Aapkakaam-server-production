"use strict";

const mongoose = require("mongoose");
const { Schema } = mongoose;

const bookingSchema = new Schema({
  userId: {
    type: Schema.Types.ObjectId,
    ref: "User",
    index: true,
  },

  vendorId: {
    type: Schema.Types.ObjectId,
    ref: "Vendor",
    required: true,
  },

  type: {
    type: String,
    index: true,
  },

  pincode: {
    type: String,
    index: true,
  },
  bookingBy: {
    type: String,
    enum: ["User", "Vendor"],
    required: true,
  },

  bookedById: {
    type: Schema.Types.ObjectId,
    refPath: "bookingBy",
    required: true,
  },
  /**
   * Canonical booking day.
   *
   * BookingService normalizes bookingDate using:
   *
   * new Date(bookingDate).toDateString()
   *
   * Canonical format:
   *
   * Wed Jul 29 2026
   * Thu Jul 30 2026
   *
   * IMPORTANT:
   * Redis locking, availability checks and MongoDB uniqueness
   * must all use this same normalized representation.
   */

  bookingDate: {
    type: Date,
    required: true,
    index: true,
  },
  expenseUser: {
    type: Number,
    default: 0,
  },
  expenseVendor: {
    type: Number,
    default: 0,
  },
  previousBalanceUser: {
    type: Number,
    default: 0,
  },
  previousBalanceVendor: {
    type: Number,
    default: 0,
  },

  bookingTime: Number,

  cancelTime: Number,

  bookedOn: {
    type: Date,
    default: Date.now,
  },

  cancelOrder: {
    type: Boolean,
    default: false,
  },

  orderCompleted: {
    type: Boolean,
    default: false,
  },

  rating: {
    type: Number,
    default: 0,
    min: 0,
    max: 5,
  },
  review: {
    type: String,
    trim: true,
    maxlength: 1000,
  },
  reviewedOn: {
    type: Date,
  },
  isServed: {
    type: Boolean,
    default: false,
  },

  isBooked: {
    type: Boolean,
    default: false,
  },

  name: String,

  phoneNo: Number,

  vill: String,

  post: String,

  dist: String,
});

/**
 * ============================================================
 * ACTIVE BOOKING UNIQUENESS
 * ============================================================
 *
 * A vendor can have only ONE active booking for a bookingDate.
 *
 * Historical bookings are NOT affected.
 *
 * Example:
 *
 * Vendor A + Mon Aug 10 2026 + ACTIVE
 *              ↓
 * only one document allowed
 *
 * Once cancelled/completed:
 *
 * Vendor A + Mon Aug 10 2026 + CANCELLED
 *
 * another booking can be created for that date.
 */
bookingSchema.index(
  {
    vendorId: 1,
    bookingDate: 1,
  },
  {
    unique: true,

    partialFilterExpression: {
      cancelOrder: false,
      orderCompleted: false,
    },

    name: "unique_active_vendor_booking_date",
  },
);

/**
 * User booking-history query:
 *
 * Bookings.find({ userId })
 *   .sort({ bookedOn: -1 })
 */
bookingSchema.index({
  userId: 1,
  bookedOn: -1,
});

/**
 * Optional operational/history lookup.
 */
bookingSchema.index({
  vendorId: 1,
  bookedOn: -1,
});

module.exports = mongoose.models.Bookings || mongoose.model("Bookings", bookingSchema);
