const mongoose = require("mongoose");
const { Schema } = mongoose;

const transactionSchema = new Schema(
  {
    // User/Vendor references
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      // ✅ REMOVED: index: true
    },
    vendorId: {
      type: Schema.Types.ObjectId,
      ref: "Vendor",
      // ✅ REMOVED: index: true
    },

    // Payment details
    amount: { type: Number, required: true },
    currency: { type: String, default: "INR", required: true },
    discount: { type: Number, default: 0 },
    discountPercent: { type: Number, default: 0 },
    finalAmount: { type: Number },

    // Gateway details (Multi-gateway support)
    paymentGateway: {
      type: String,
      enum: ["razorpay", "cashfree", "stripe", "phonepe"],
      default: "razorpay",
    },
    gatewayOrderId: { type: String },
    gatewayPaymentId: { type: String },
    gatewaySignature: { type: String },

    // Razorpay specific (backward compatibility)
    razorpayOrderId: { type: String },
    razorpayPaymentId: { type: String },
    razorpaySignature: { type: String },

    // Transaction status
    status: {
      type: String,
      enum: ["initiated", "processing", "pending", "completed", "failed", "abandoned", "refunded"],
      default: "initiated",
      required: true,
      // ✅ REMOVED: index: true
    },
    paymentStatus: {
      type: String,
      enum: ["pending", "success", "failed", "refunded"],
      default: "pending",
      // ✅ REMOVED: index: true
    },

    // Processing timestamps
    processingStartedAt: { type: Date },
    initiatedAt: { type: Date, default: Date.now },
    completedAt: { type: Date },
    failedAt: { type: Date },
    abandonedAt: { type: Date },
    refundedAt: { type: Date },

    // Payment failure details
    errorCode: { type: String },
    errorMessage: { type: String },
    errorDescription: { type: String },

    // Refund fields
    refundAmount: { type: Number, default: 0 },
    refundId: { type: String },
    refundStatus: {
      type: String,
      enum: ["pending", "processed", "failed"],
    },
    refundError: { type: String },
    refundRequestedAt: { type: Date },

    // Idempotency
    idempotencyKey: { type: String },

    // Request tracking
    requestId: { type: String },
    ipAddress: { type: String },
    userAgent: { type: String },

    // Webhook tracking
    webhookProcessed: {
      type: Boolean,
      default: false,
    },
    webhookProcessedAt: {
      type: Date,
    },
    webhookEvents: [
      {
        webhookId: { type: String },
        event: { type: String, required: true },
        processed: { type: Boolean, default: false },
        processedAt: { type: Date },
        payloadHash: { type: String },
        attemptNumber: { type: Number, default: 1 },
        error: { type: String },
      },
    ],

    // Metadata (whitelisted only)
    metadata: {
      orderId: String,
      requestedAmount: Number,
      currency: String,
      gateway: String,
      clientTimestamp: Date,

      signupToken: String,
      signupPayment: Boolean,
    },

    // Category
    category: {
      type: String,
      enum: ["user", "vendor", "vendor_signup"],
    },
    paymentMethod: { type: String },

    // Audit trail
    auditLog: [
      {
        action: { type: String },
        timestamp: { type: Date, default: Date.now },
        userId: Schema.Types.ObjectId,
        vendorId: Schema.Types.ObjectId,
        amount: Number,
        previousStatus: String,
        newStatus: String,
        metadata: Schema.Types.Mixed,
      },
    ],

    // Soft delete
    deletedAt: { type: Date },
    deleted: { type: Boolean, default: false },
  },
  {
    timestamps: true,
  },
);

// ============================================
// ALL INDEXES DEFINED HERE (NO DUPLICATES)
// ============================================

// ✅ 1. PARTIAL UNIQUE INDEXES - Only enforce uniqueness when field exists
// This prevents duplicate null errors

// Razorpay indexes
transactionSchema.index(
  { razorpayOrderId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      razorpayOrderId: { $type: "string" },
    },
    background: true,
    name: "unique_razorpayOrderId_when_present",
  },
);

transactionSchema.index(
  { razorpayPaymentId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      razorpayPaymentId: { $type: "string" },
    },
    background: true,
    name: "unique_razorpayPaymentId_when_present",
  },
);

// Gateway indexes
transactionSchema.index(
  { gatewayOrderId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      gatewayOrderId: { $type: "string" },
    },
    background: true,
    name: "unique_gatewayOrderId_when_present",
  },
);

transactionSchema.index(
  { gatewayPaymentId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      gatewayPaymentId: { $type: "string" },
    },
    background: true,
    name: "unique_gatewayPaymentId_when_present",
  },
);

// Idempotency
transactionSchema.index(
  { idempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: {
      idempotencyKey: { $type: "string" },
    },
    background: true,
    name: "unique_idempotencyKey_when_present",
  },
);

// Webhook events
transactionSchema.index(
  { "webhookEvents.webhookId": 1 },
  {
    unique: true,
    partialFilterExpression: {
      "webhookEvents.webhookId": { $type: "string" },
    },
    background: true,
    name: "unique_webhookId_when_present",
  },
);

// ✅ 2. COMPOUND INDEXES for common queries
transactionSchema.index(
  { userId: 1, status: 1, createdAt: -1 },
  {
    background: true,
    name: "idx_userId_status_createdAt",
  },
);

transactionSchema.index(
  { vendorId: 1, status: 1, createdAt: -1 },
  {
    background: true,
    name: "idx_vendorId_status_createdAt",
  },
);

transactionSchema.index(
  { status: 1, createdAt: -1 },
  {
    background: true,
    name: "idx_status_createdAt",
  },
);

// ✅ 3. USER/VENDOR TRANSACTION HISTORY
transactionSchema.index(
  { userId: 1, createdAt: -1 },
  {
    background: true,
    name: "idx_userId_createdAt",
  },
);

transactionSchema.index(
  { vendorId: 1, createdAt: -1 },
  {
    background: true,
    name: "idx_vendorId_createdAt",
  },
);

// ✅ 4. PROCESSING INDEX - For finding pending transactions
transactionSchema.index(
  { status: 1, processingStartedAt: 1 },
  {
    partialFilterExpression: { status: "processing" },
    background: true,
    name: "idx_processing_status_processingStartedAt",
  },
);

// ✅ 5. REQUEST TRACKING
transactionSchema.index(
  { requestId: 1 },
  {
    background: true,
    name: "idx_requestId",
  },
);

// ✅ 6. STATUS WITH TIMESTAMPS
transactionSchema.index(
  { status: 1, abandonedAt: -1 },
  {
    background: true,
    name: "idx_status_abandonedAt",
  },
);

transactionSchema.index(
  { status: 1, failedAt: -1 },
  {
    background: true,
    name: "idx_status_failedAt",
  },
);

transactionSchema.index(
  { status: 1, completedAt: -1 },
  {
    background: true,
    name: "idx_status_completedAt",
  },
);

// ✅ 7. PAYMENT STATUS
transactionSchema.index(
  { paymentStatus: 1, createdAt: -1 },
  {
    background: true,
    name: "idx_paymentStatus_createdAt",
  },
);

// ✅ 8. SOFT DELETE
transactionSchema.index(
  { deleted: 1, createdAt: -1 },
  {
    background: true,
    name: "idx_deleted_createdAt",
  },
);

// ✅ 9. DATE RANGE QUERIES
transactionSchema.index(
  { createdAt: -1 },
  {
    background: true,
    name: "idx_createdAt_desc",
  },
);

// ✅ 10. GATEWAY SPECIFIC QUERIES
transactionSchema.index(
  { paymentGateway: 1, status: 1 },
  {
    background: true,
    name: "idx_paymentGateway_status",
  },
);

// ✅ 11. COMPOUND INDEX for abandoned payments
transactionSchema.index(
  { status: 1, abandonedAt: -1, userId: 1 },
  {
    partialFilterExpression: { status: "abandoned" },
    background: true,
    name: "idx_abandoned_userId",
  },
);

// ✅ 12. COMPOUND INDEX for failed payments
transactionSchema.index(
  { status: 1, failedAt: -1, userId: 1 },
  {
    partialFilterExpression: { status: "failed" },
    background: true,
    name: "idx_failed_userId",
  },
);

// ✅ 13. COMPOUND INDEX for completed payments
transactionSchema.index(
  { status: 1, completedAt: -1, userId: 1 },
  {
    partialFilterExpression: { status: "completed" },
    background: true,
    name: "idx_completed_userId",
  },
);

// ✅ 14. COMPOUND INDEX for refunded payments
transactionSchema.index(
  { status: 1, refundedAt: -1, userId: 1 },
  {
    partialFilterExpression: { status: "refunded" },
    background: true,
    name: "idx_refunded_userId",
  },
);
// Transaction.js
module.exports = mongoose.models.Transaction || mongoose.model("Transaction", transactionSchema);
