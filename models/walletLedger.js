const mongoose = require("mongoose");
const { Schema } = mongoose;

// Maintenance mode flag
const MAINTENANCE_MODE = process.env.WALLET_MAINTENANCE_MODE === "true";

const walletLedgerSchema = new Schema(
  {
    // Entity reference
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
    vendorId: {
      type: Schema.Types.ObjectId,
      ref: "Vendor",
    },

    // Transaction references
    transactionId: {
      type: Schema.Types.ObjectId,
      ref: "Transaction",
      required: true,
    },
    paymentId: {
      type: String,
    },
    orderId: {
      type: String,
    },
    refundId: {
      type: String,
    },

    // Ledger entries
    credit: { type: Number, default: 0, min: 0 },
    debit: { type: Number, default: 0, min: 0 },
    balanceBefore: { type: Number },
    balanceAfter: { type: Number },

    // Entry type - Business events (WHY money moved, not HOW)
    entryType: {
      type: String,
      enum: [
        "PAYMENT",
        "REFUND",
        "COMMISSION",
        "WITHDRAWAL",
        "PENALTY",
        "ADMIN_CREDIT",
        "ADMIN_DEBIT",
        "REFERRAL_BONUS",
        "SYSTEM_ADJUSTMENT",
        "LEGACY_MIGRATION",
      ],
      required: true,
    },

    // Reference
    referenceType: {
      type: String,
      enum: ["transaction", "order", "payment", "refund", "admin", "system"],
    },
    referenceId: {
      type: String,
    },

    // Running balance
    runningBalance: { type: Number },

    // Idempotency - UPDATED with better validation
    idempotencyKey: {
      type: String,
      required: [true, "idempotencyKey is required"],
      // ✅ Remove unique from schema level - handle in indexes
      // unique: true, // REMOVED
      validate: {
        validator: function (v) {
          return v && v.trim().length > 0;
        },
        message: "idempotencyKey cannot be empty string",
      },
    },

    // Global financial operation ID - UPDATED with better validation
    financialOperationId: {
      type: String,
      required: [true, "financialOperationId is required"],
      // ✅ Remove unique from schema level - handle in indexes
      // unique: true, // REMOVED
      validate: {
        validator: function (v) {
          return v && v.trim().length > 0;
        },
        message: "financialOperationId cannot be empty string",
      },
    },

    // Source and tracking
    source: {
      type: String,
      enum: [
        "payment_verification",
        "webhook",
        "refund",
        "admin",
        "system",
        "commission",
        "referral",
      ],
      required: true,
    },
    requestId: {
      type: String,
    },
    ipAddress: { type: String },

    // Who performed the operation
    createdBy: {
      type: String,
      enum: ["system", "user", "vendor", "admin", "webhook", "cron", "migration"],
      default: "system",
    },

    // Legacy migration flag
    legacyMigration: {
      type: Boolean,
      default: false,
    },

    // Metadata
    metadata: {
      discount: Number,
      finalAmount: Number,
      reason: String,
      originalAmount: Number,
      originalFinalAmount: Number,
      refundId: String,
      commissionRate: Number,
      referralUserId: Schema.Types.ObjectId,
      bookingId: String,
      serviceId: String,
      migratedAt: Date,
      migratedFrom: String,
    },

    // Version for optimistic concurrency
    __v: { type: Number, default: 0 },

    // Timestamps
    createdAt: {
      type: Date,
      default: Date.now,
      immutable: true,
    },
    updatedAt: { type: Date, default: Date.now },
  },
  {
    timestamps: {
      createdAt: "createdAt",
      updatedAt: "updatedAt",
    },
    versionKey: "__v",
  },
);

// ============================================
// ALL INDEXES DEFINED HERE
// ============================================

// ✅ 1. PARTIAL UNIQUE INDEXES - Only enforce uniqueness when value exists
// This prevents duplicate key errors on null/undefined values

walletLedgerSchema.index(
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

walletLedgerSchema.index(
  { financialOperationId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      financialOperationId: { $type: "string" },
    },
    background: true,
    name: "unique_financialOperationId_when_present",
  },
);

// ✅ 2. COMPOUND INDEXES for common queries
walletLedgerSchema.index({ userId: 1, createdAt: -1 });
walletLedgerSchema.index({ vendorId: 1, createdAt: -1 });
walletLedgerSchema.index({ transactionId: 1, source: 1 });
walletLedgerSchema.index({ entryType: 1, createdAt: -1 });
walletLedgerSchema.index({ referenceType: 1, referenceId: 1 });
walletLedgerSchema.index({ legacyMigration: 1, createdAt: -1 });

// ✅ 3. SIMPLE INDEXES for query performance
walletLedgerSchema.index({ userId: 1 });
walletLedgerSchema.index({ vendorId: 1 });
walletLedgerSchema.index({ transactionId: 1 });
walletLedgerSchema.index({ paymentId: 1 });
walletLedgerSchema.index({ orderId: 1 });
walletLedgerSchema.index({ refundId: 1 });
walletLedgerSchema.index({ entryType: 1 });
walletLedgerSchema.index({ referenceId: 1 });
walletLedgerSchema.index({ source: 1 });
walletLedgerSchema.index({ requestId: 1 });
walletLedgerSchema.index({ createdAt: 1 });

// ✅ 4. COMPOUND INDEX for balance queries
walletLedgerSchema.index(
  { userId: 1, balanceAfter: -1 },
  {
    partialFilterExpression: { userId: { $exists: true } },
    background: true,
  },
);

walletLedgerSchema.index(
  { vendorId: 1, balanceAfter: -1 },
  {
    partialFilterExpression: { vendorId: { $exists: true } },
    background: true,
  },
);

// ============================================
// IMMUTABILITY - Safe with Maintenance Mode
// ============================================

walletLedgerSchema.pre("save", function (next) {
  if (this.isNew) return next();

  if (MAINTENANCE_MODE) return next();

  if (this.isModified()) {
    return next(
      new Error(
        "WalletLedger entries are immutable. " +
          "To perform maintenance, set WALLET_MAINTENANCE_MODE=true",
      ),
    );
  }
  next();
});

walletLedgerSchema.pre("findOneAndUpdate", function (next) {
  if (MAINTENANCE_MODE) return next();
  next(
    new Error(
      "Direct updates are not allowed on WalletLedger. " +
        "To perform maintenance, set WALLET_MAINTENANCE_MODE=true",
    ),
  );
});

walletLedgerSchema.pre("updateOne", function (next) {
  if (MAINTENANCE_MODE) return next();
  next(
    new Error(
      "Direct updates are not allowed on WalletLedger. " +
        "To perform maintenance, set WALLET_MAINTENANCE_MODE=true",
    ),
  );
});

walletLedgerSchema.pre("updateMany", function (next) {
  if (MAINTENANCE_MODE) return next();
  next(
    new Error(
      "Direct updates are not allowed on WalletLedger. " +
        "To perform maintenance, set WALLET_MAINTENANCE_MODE=true",
    ),
  );
});

walletLedgerSchema.pre("remove", function (next) {
  if (MAINTENANCE_MODE) return next();
  next(
    new Error(
      "Deleting WalletLedger entries is not allowed. " +
        "To perform maintenance, set WALLET_MAINTENANCE_MODE=true",
    ),
  );
});

walletLedgerSchema.pre("deleteOne", function (next) {
  if (MAINTENANCE_MODE) return next();
  next(
    new Error(
      "Deleting WalletLedger entries is not allowed. " +
        "To perform maintenance, set WALLET_MAINTENANCE_MODE=true",
    ),
  );
});

walletLedgerSchema.pre("deleteMany", function (next) {
  if (MAINTENANCE_MODE) return next();
  next(
    new Error(
      "Deleting WalletLedger entries is not allowed. " +
        "To perform maintenance, set WALLET_MAINTENANCE_MODE=true",
    ),
  );
});

// ============================================
// LEDGER INVARIANT VALIDATION
// ============================================

walletLedgerSchema.pre("validate", function (next) {
  // Entity validation
  if (!this.userId && !this.vendorId) {
    return next(new Error("Either userId or vendorId is required"));
  }

  if (this.userId && this.vendorId) {
    return next(new Error("Cannot have both userId and vendorId"));
  }

  // Credit/Debit validation
  if (this.credit < 0 || this.debit < 0) {
    return next(new Error("Credit and debit must be non-negative"));
  }

  if (this.credit === 0 && this.debit === 0) {
    return next(new Error("Either credit or debit must be non-zero"));
  }

  if (this.credit > 0 && this.debit > 0) {
    return next(new Error("Cannot have both credit and debit positive"));
  }

  // Balance invariant validation (skip for legacy migrations)
  if (!this.legacyMigration) {
    if (this.balanceBefore === undefined || this.balanceBefore === null) {
      return next(new Error("balanceBefore is required for non-legacy entries"));
    }

    if (this.balanceAfter === undefined || this.balanceAfter === null) {
      return next(new Error("balanceAfter is required for non-legacy entries"));
    }

    const expectedBalance = this.balanceBefore + this.credit - this.debit;
    if (Math.abs(expectedBalance - this.balanceAfter) > 0.001) {
      return next(
        new Error(
          `Ledger invariant violation: ${this.balanceBefore} + ${this.credit} - ${this.debit} = ${expectedBalance}, but balanceAfter is ${this.balanceAfter}`,
        ),
      );
    }
  }

  // Note: idempotencyKey and financialOperationId validation is now handled by the schema
  // with proper error messages and empty string prevention

  next();
});

// ============================================
// VIRTUAL PROPERTIES
// ============================================

walletLedgerSchema.virtual("isCredit").get(function () {
  return this.credit > 0;
});

walletLedgerSchema.virtual("isDebit").get(function () {
  return this.debit > 0;
});

walletLedgerSchema.virtual("isLegacy").get(function () {
  return this.legacyMigration === true;
});

// ============================================
// JSON TRANSFORM
// ============================================

walletLedgerSchema.set("toJSON", {
  virtuals: true,
  transform: function (doc, ret) {
    delete ret.__v;
    return ret;
  },
});

walletLedgerSchema.set("toObject", {
  virtuals: true,
});

module.exports = mongoose.model("WalletLedger", walletLedgerSchema);
