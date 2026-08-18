const mongoose = require("mongoose");
const { normalizeDateIST, validateDateRange, getTodayIST } = require("../src/utils/dateUtils");

const vendorLeaveSchema = new mongoose.Schema(
  {
    vendorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Vendor",
      required: [true, "Vendor ID is required"],
      index: true,
    },
    from: {
      type: Date,
      required: [true, "'from' date is required"],
      validate: {
        validator: function (value) {
          const normalized = normalizeDateIST(value);
          return normalized !== null;
        },
        message: "Invalid 'from' date format",
      },
    },
    to: {
      type: Date,
      required: [true, "'to' date is required"],
      validate: {
        validator: function (value) {
          const normalized = normalizeDateIST(value);
          return normalized !== null;
        },
        message: "Invalid 'to' date format",
      },
    },
    reason: {
      type: String,
      trim: true,
      maxlength: [200, "Reason cannot exceed 200 characters"],
      default: "",
    },
    status: {
      type: String,
      enum: {
        values: ["active", "cancelled"],
        message: "Status must be either 'active' or 'cancelled'",
      },
      default: "active",
      index: true,
    },
  },
  {
    timestamps: true,
  },
);

// ============ INDEXES ============
// Compound index for availability queries
vendorLeaveSchema.index({
  vendorId: 1,
  status: 1,
  from: 1,
  to: 1,
});

// Index for sorting and filtering
vendorLeaveSchema.index({
  vendorId: 1,
  status: 1,
  createdAt: -1,
});

// ============ PRE-VALIDATE HOOK ============
vendorLeaveSchema.pre("validate", function (next) {
  // Normalize dates
  if (this.from) {
    this.from = normalizeDateIST(this.from);
  }
  if (this.to) {
    this.to = normalizeDateIST(this.to);
  }

  // Validate date range
  if (this.from && this.to) {
    const validation = validateDateRange(this.from, this.to);
    if (!validation.valid) {
      next(new Error(validation.message));
      return;
    }
  }

  next();
});

// ============ INSTANCE METHODS ============

/**
 * Check if this leave is currently active
 * @param {Date} date - Optional date to check against
 * @returns {boolean}
 */
vendorLeaveSchema.methods.isActiveOnDate = function (date) {
  if (this.status !== "active") return false;

  const checkDate = normalizeDateIST(date) || getTodayUTC();
  const from = normalizeDateIST(this.from);
  const to = normalizeDateIST(this.to);

  if (!from || !to) return false;

  return checkDate.getTime() >= from.getTime() && checkDate.getTime() <= to.getTime();
};

/**
 * Check if this leave is in the past
 * @returns {boolean}
 */
vendorLeaveSchema.methods.isPast = function () {
  const today = getTodayIST();
  const to = normalizeDateIST(this.to);
  if (!to) return true;
  return to.getTime() < today.getTime();
};

/**
 * Check if this leave is currently active
 * @returns {boolean}
 */
vendorLeaveSchema.methods.isCurrent = function () {
  if (this.status !== "active") return false;
  const today = getTodayUTC();
  const from = normalizeDateIST(this.from);
  const to = normalizeDateIST(this.to);
  if (!from || !to) return false;
  return from.getTime() <= today.getTime() && to.getTime() >= today.getTime();
};

/**
 * Check if this leave is in the future
 * @returns {boolean}
 */
vendorLeaveSchema.methods.isFuture = function () {
  if (this.status !== "active") return false;
  const today = getTodayUTC();
  const from = normalizeDateIST(this.from);
  if (!from) return false;
  return from.getTime() > today.getTime();
};

// ============ STATIC METHODS ============

/**
 * Check if vendor has active leave on a specific date
 * @param {string|ObjectId} vendorId
 * @param {Date|string} date
 * @param {Object} session - MongoDB session for transactions
 * @returns {Promise<boolean>}
 */
vendorLeaveSchema.statics.hasLeaveOnDate = async function (vendorId, date, session = null) {
  const targetDate = normalizeDateIST(date);
  if (!targetDate) {
    throw new Error("Invalid date format");
  }

  const query = {
    vendorId: vendorId,
    status: "active",
    from: { $lte: targetDate },
    to: { $gte: targetDate },
  };

  const options = session ? { session } : {};
  const count = await this.countDocuments(query, options);
  return count > 0;
};

/**
 * Get all unavailable vendor IDs for a specific date
 * @param {Date|string} date
 * @param {Object} session - MongoDB session for transactions
 * @returns {Promise<Array>}
 */
vendorLeaveSchema.statics.getUnavailableVendorIds = async function (date, session = null) {
  const targetDate = normalizeDateIST(date);
  if (!targetDate) {
    throw new Error("Invalid date format");
  }

  const query = {
    status: "active",
    from: { $lte: targetDate },
    to: { $gte: targetDate },
  };

  const options = session ? { session } : {};
  const results = await this.distinct("vendorId", query, options);
  return results;
};

/**
 * Check for overlapping active leave
 * @param {string|ObjectId} vendorId
 * @param {Date|string} from
 * @param {Date|string} to
 * @param {Object} session - MongoDB session for transactions
 * @returns {Promise<boolean>}
 */
vendorLeaveSchema.statics.hasOverlappingLeave = async function (
  vendorId,
  from,
  to,
  session = null,
) {
  const validation = validateDateRange(from, to);
  if (!validation.valid) {
    throw new Error(validation.message);
  }

  const query = {
    vendorId: vendorId,
    status: "active",
    from: { $lte: validation.to },
    to: { $gte: validation.from },
  };

  const options = session ? { session } : {};
  const count = await this.countDocuments(query, options);
  return count > 0;
};

// Enable virtuals
vendorLeaveSchema.set("toJSON", { virtuals: true });
vendorLeaveSchema.set("toObject", { virtuals: true });

module.exports = mongoose.models.VendorLeave || mongoose.model("VendorLeave", vendorLeaveSchema);
