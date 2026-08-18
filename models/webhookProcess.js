const mongoose = require("mongoose");

const webhookProcessSchema = new mongoose.Schema(
  {
    webhookId: {
      type: String,
      required: true,
      unique: true, // This creates a unique index - no need for index: true
    },
    event: {
      type: String,
      required: true,
      index: true,
    },
    orderId: {
      type: String,
      index: true,
    },
    paymentId: {
      type: String,
      index: true,
    },
    refundId: {
      type: String,
      index: true,
    },
    status: {
      type: String,
      enum: ["pending", "processing", "completed", "failed"],
      default: "pending",
      // No index here - we'll use compound index below
    },
    leaseExpiresAt: {
      type: Date,
      // No index here - we'll use compound index below
    },
    claimedAt: {
      type: Date,
    },
    processedAt: {
      type: Date,
    },
    failedAt: {
      type: Date,
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
    updatedAt: {
      type: Date,
      default: Date.now,
    },
    error: {
      message: String,
      code: String,
    },
    result: {
      success: Boolean,
      transactionId: mongoose.Schema.Types.ObjectId,
      message: String,
    },
  },
  {
    timestamps: true,
  },
);

// Compound indexes for efficient queries
// These replace individual indexes on status, leaseExpiresAt, and updatedAt
webhookProcessSchema.index({ status: 1, leaseExpiresAt: 1 });
webhookProcessSchema.index({ status: 1, updatedAt: 1 });

// Ensure indexes are created
webhookProcessSchema.set("autoIndex", true);

module.exports = mongoose.model("WebhookProcess", webhookProcessSchema);
