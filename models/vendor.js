const mongoose = require("mongoose");
const { Schema } = mongoose;

// ============================================================
// CONSTANTS
// ============================================================

const MAX_JOBS = 5;

// ============================================================
// VENDOR SCHEMA
// ============================================================

const vendorSchema = new Schema(
  {
    // ==========================================================
    // BASIC INFORMATION
    // ==========================================================

    name: {
      type: String,
      required: true,
      trim: true,
    },

    phoneNo: {
      type: Number,
      required: true,
    },

    verifyPhoneNo: {
      type: Boolean,
      default: false,
    },

    email: {
      type: String,
      default: "",
      lowercase: true,
      trim: true,
    },

    verifyEmail: {
      type: Boolean,
      default: false,
    },

    password: {
      type: String,
      required: true,
    },

    // ==========================================================
    // JOBS
    //
    // Maximum 5 jobs
    //
    // type[0] = labour
    // type[1] = mason
    //
    // ==========================================================

    type: {
      type: [String],
      required: true,
      default: [],
      validate: [
        {
          validator: function (value) {
            return Array.isArray(value) && value.length <= MAX_JOBS;
          },
          message: `A vendor can have a maximum of ${MAX_JOBS} jobs.`,
        },

        {
          validator: function (value) {
            const cleaned = value.map((job) => String(job).trim().toLowerCase());

            return new Set(cleaned).size === cleaned.length;
          },
          message: "Duplicate jobs are not allowed.",
        },
      ],
    },

    // ==========================================================
    // WAGE RATE
    //
    // type[0]         -> wageRate[0]
    // labour          -> 400
    //
    // type[1]         -> wageRate[1]
    // mason           -> 600
    //
    // ==========================================================

    wageRate: {
      type: [Number],
      default: [],

      validate: [
        {
          validator: function (value) {
            return Array.isArray(value) && value.length <= MAX_JOBS;
          },
          message: `A vendor can have a maximum of ${MAX_JOBS} wage rates.`,
        },

        {
          validator: function (value) {
            return value.every((rate) => Number.isFinite(rate) && rate >= 0);
          },
          message: "Wage rate must contain valid positive numbers.",
        },
      ],
    },

    // ==========================================================
    // WAGE RATE TYPE
    //
    // type[0]         -> wageRateType[0]
    // labour          -> Day
    //
    // type[1]         -> wageRateType[1]
    // mason           -> Day
    //
    // ==========================================================

    wageRateType: {
      type: [String],
      default: [],

      validate: [
        {
          validator: function (value) {
            return Array.isArray(value) && value.length <= MAX_JOBS;
          },
          message: `A vendor can have a maximum of ${MAX_JOBS} wage rate types.`,
        },

        {
          validator: function (value) {
            return value.every((item) => typeof item === "string");
          },
          message: "Wage rate type must contain strings.",
        },
      ],
    },

    // ==========================================================
    // VERIFICATION
    // ==========================================================

    validPhoneNoId: {
      type: String,
    },

    validEmailId: {
      type: String,
    },

    imgURL: {
      type: String,
    },

    experience: {
      type: Number,
      default: 0,
      min: 0,
    },

    isVerified: {
      type: Boolean,
      default: false,
    },

    isSelfBooked: {
      type: Boolean,
      default: false,
    },

    // ==========================================================
    // ADDRESS
    // ==========================================================

    address: {
      type: [Schema.Types.Mixed],
      default: [],
    },

    shareBy: {
      type: String,
    },

    // ==========================================================
    // USER BOOKING STATS
    // ==========================================================

    pending: {
      type: Number,
      default: 0,
      min: 0,
    },

    completed: {
      type: Number,
      default: 0,
      min: 0,
    },

    canceled: {
      type: Number,
      default: 0,
      min: 0,
    },

    // ==========================================================
    // EARNINGS
    // ==========================================================

    earning: {
      type: Number,
      default: 0,
      min: 0,
    },

    commission: {
      type: Number,
      default: 50,
      min: 0,
    },

    // ==========================================================
    // VENDOR BOOKING STATS
    // ==========================================================

    pendingVendor: {
      type: Number,
      default: 0,
      min: 0,
    },

    completedVendor: {
      type: Number,
      default: 0,
      min: 0,
    },

    canceledVendor: {
      type: Number,
      default: 0,
      min: 0,
    },

    // ==========================================================
    // SHARE STATS
    // ==========================================================

    pendingShareBy: {
      type: Number,
      default: 0,
      min: 0,
    },

    completedShareBy: {
      type: Number,
      default: 0,
      min: 0,
    },

    canceledShareBy: {
      type: Number,
      default: 0,
      min: 0,
    },

    // ==========================================================
    // RATING
    // ==========================================================

    rating: {
      type: Number,
      default: 0,
      min: 0,
      max: 5,
    },

    ratingCount: {
      type: Number,
      default: 0,
      min: 0,
    },

    gender: {
      type: String,
      default: "",
      trim: true,
    },

    // ==========================================================
    // LOCATION
    // ==========================================================

    pincode: {
      type: String,
      default: "",
      trim: true,
    },

    // ==========================================================
    // ACCOUNT
    // ==========================================================

    accountCreatedOn: {
      type: Date,
      default: Date.now,
    },

    cd: {
      type: String,
    },

    leaveTaken: {
      type: [Schema.Types.Mixed],
      default: [],
    },

    balance: {
      type: Number,
      default: 0,
      min: 0,
    },

    // ==========================================================
    // NOTIFICATIONS
    // ==========================================================

    fcmToken: {
      type: String,
    },

    agreedToTnCnP: {
      type: Boolean,
      default: false,
    },

    lastShownContext: {
      type: String,
      default: null,
    },

    // ==========================================================
    // EXTERNAL COLLECTION STATS
    // ==========================================================

    bookingCount: {
      type: Number,
      default: 0,
      min: 0,
    },

    bookingCountVendor: {
      type: Number,
      default: 0,
      min: 0,
    },

    shareCount: {
      type: Number,
      default: 0,
      min: 0,
    },

    totalDiscount: {
      type: Number,
      default: 0,
      min: 0,
    },

    totalOriginalAmount: {
      type: Number,
      default: 0,
      min: 0,
    },

    transactionCount: {
      type: Number,
      default: 0,
      min: 0,
    },

    presentDate: {
      type: Date,
    },

    // ==========================================================
    // USER SHOWN CONTEXT
    // ==========================================================

    userShownContext: {
      type: Map,
      of: String,
      default: {},
    },

    // ==========================================================
    // STATUS
    // ==========================================================

    status: {
      type: String,
      enum: ["active", "blocked"],
      default: "active",
    },
  },

  {
    timestamps: true,

    // Prevent Mongoose from adding unnecessary fields.
    minimize: true,
  },
);

// ============================================================
// CROSS-FIELD VALIDATION
// ============================================================
//
// Example:
//
// type:
// [
//   "labour",
//   "mason",
//   "electrician"
// ]
//
// wageRate:
// [
//   400,
//   600,
//   800
// ]
//
// wageRateType:
// [
//   "Day",
//   "Day",
//   "Service"
// ]
//
// ============================================================

vendorSchema.pre("validate", function (next) {
  const jobs = Array.isArray(this.type) ? this.type : [];

  const rates = Array.isArray(this.wageRate) ? this.wageRate : [];

  const rateTypes = Array.isArray(this.wageRateType) ? this.wageRateType : [];

  // ----------------------------------------------------------
  // Maximum jobs
  // ----------------------------------------------------------

  if (jobs.length > MAX_JOBS) {
    return next(new Error(`A vendor can have a maximum of ${MAX_JOBS} jobs.`));
  }

  // ----------------------------------------------------------
  // Wage arrays cannot be larger than jobs
  // ----------------------------------------------------------

  if (rates.length > jobs.length) {
    return next(new Error("Wage rates cannot contain more entries than vendor jobs."));
  }

  if (rateTypes.length > jobs.length) {
    return next(new Error("Wage rate types cannot contain more entries than vendor jobs."));
  }

  // ----------------------------------------------------------
  // Jobs should be unique
  // ----------------------------------------------------------

  const normalizedJobs = jobs.map((job) => String(job).trim().toLowerCase());

  if (new Set(normalizedJobs).size !== normalizedJobs.length) {
    return next(new Error("Duplicate jobs are not allowed."));
  }

  // ----------------------------------------------------------
  // Wage values
  // ----------------------------------------------------------

  for (const rate of rates) {
    if (!Number.isFinite(rate) || rate < 0) {
      return next(new Error("Wage rate must be a valid number greater than or equal to 0."));
    }
  }

  next();
});

// ============================================================
// SEARCH INDEXES
// ============================================================
//
// Main vendor search:
//
// pincode + status + type
//
// This is the most important index for your current search
// architecture.
//
// ============================================================

vendorSchema.index({
  pincode: 1,
  status: 1,
  type: 1,
});

// ============================================================
// SEARCH + RATING
// ============================================================

vendorSchema.index({
  pincode: 1,
  status: 1,
  type: 1,
  rating: -1,
});

// ============================================================
// SEARCH + VERIFICATION + RATING
//
// Helps the common ordering:
//
// isVerified DESC
// rating DESC
// completedVendor DESC
//
// ============================================================

vendorSchema.index({
  pincode: 1,
  status: 1,
  type: 1,
  isVerified: -1,
  rating: -1,
  completedVendor: -1,
});

// ============================================================
// PHONE LOOKUP
// ============================================================

vendorSchema.index({
  phoneNo: 1,
});

// ============================================================
// EMAIL LOOKUP
// ============================================================

// vendorSchema.index({
//   email: 1,
// });

// ============================================================
// IMPORTANT
//
// Do NOT create a giant index containing:
//
// type + wageRate + wageRateType + rating +
// completedVendor + balance + phoneNo + ...
//
// Large compound indexes increase:
// - RAM usage
// - write cost
// - index maintenance
//
// Keep indexes focused on actual query patterns.
// ============================================================

module.exports = mongoose.models.Vendor || mongoose.model("Vendor", vendorSchema);
