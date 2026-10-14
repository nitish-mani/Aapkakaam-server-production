const mongoose = require("mongoose");

const signupAttemptSchema = new mongoose.Schema(
  {
    attemptId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },

    // Account type: customer or service provider
    accountType: {
      type: String,
      enum: ["user", "vendor"],
      required: true,
      index: true,
    },

    // AES-256-GCM encrypted mobile number
    phoneEncrypted: {
      type: String,
      required: true,
      select: false,
    },

    // HMAC-SHA256 for matching the same phone number
    phoneHash: {
      type: String,
      required: true,
      select: false,
    },

    // Last four digits for masked admin listing
    phoneLast4: {
      type: String,
      required: true,
      match: /^\d{4}$/,
    },

    stage: {
      type: String,
      enum: ["PHONE", "OTP", "ACCOUNT_CREATION", "COMPLETED"],
      required: true,
      default: "PHONE",
      index: true,
    },

    status: {
      type: String,
      enum: [
        "STARTED",
        "OTP_SENT",
        "OTP_FAILED",
        "OTP_VERIFIED",
        "PAYMENT_PENDING",
        "FAILED",
        "COMPLETED",
      ],
      default: "STARTED",
      required: true,
      index: true,
    },

    failureCode: {
      type: String,
      enum: [
        "INVALID_PHONE",
        "OTP_SEND_FAILED",
        "OTP_EXPIRED",
        "OTP_INVALID",
        "VALIDATION_ERROR",
        "DUPLICATE_ACCOUNT",
        "PAYMENT_PENDING",
        "INTERNAL_ERROR",
        null,
      ],
      default: null,
    },

    attemptCount: {
      type: Number,
      default: 1,
      min: 1,
    },

    consentForOnboardingContact: {
      type: Boolean,
      default: false,
    },

    consentAt: {
      type: Date,
      default: null,
    },

    completedAt: {
      type: Date,
      default: null,
    },

    lastAttemptAt: {
      type: Date,
      default: Date.now,
    },

    // Optional retention date; no automatic deletion
    // unless a TTL index is explicitly configured.
    expireAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
    versionKey: false,
    collection: "signup_attempts",
  },
);

// Admin listing: newest attempts first
signupAttemptSchema.index({
  accountType: 1,
  status: 1,
  updatedAt: -1,
});

signupAttemptSchema.index({
  stage: 1,
  updatedAt: -1,
});

module.exports = mongoose.model("SignupAttempt", signupAttemptSchema);
