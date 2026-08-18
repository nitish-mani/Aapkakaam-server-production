const mongoose = require("mongoose");
const WalletLedger = require("../../models/walletLedger");
const User = require("../../models/user");
const Vendor = require("../../models/vendor");
const { WalletLogger } = require("../logger/index");
const crypto = require("crypto");

class WalletService {
  /**
   * PHASE 6: Credit wallet with ledger entry
   * @param {string} entityType - 'user' or 'vendor'
   * @param {string} entityId - User or Vendor ID
   * @param {number} amount - Amount to credit
   * @param {string} transactionId - Transaction ID
   * @param {Object} metadata - Additional metadata
   * @param {string} metadata.idempotencyKey - Unique key for idempotency (REQUIRED)
   * @param {string} metadata.financialOperationId - Global financial operation ID (REQUIRED)
   * @param {string} metadata.entryType - Entry type (default: 'PAYMENT')
   * @param {string} metadata.source - Source of the credit
   * @param {string} metadata.paymentId - Payment ID
   * @param {string} metadata.orderId - Order ID
   * @param {string} metadata.requestId - Request ID
   * @param {string} metadata.ipAddress - IP Address
   * @param {Object} metadata.metadata - Additional metadata
   * @param {string} metadata.createdBy - Who created this entry
   * @param {string} metadata.referenceType - Reference type
   * @param {string} metadata.referenceId - Reference ID
   * @param {string} metadata.gateway - Payment gateway
   * @param {string} metadata.currency - Currency
   * @returns {Promise<Object>} Result with entity and ledger
   */
  async credit(
    entityType,
    entityId,
    amount,
    transactionId,
    totalDiscount,
    originalAmount,
    metadata = {},
  ) {
    // Validate required parameters
    if (!entityType || !["user", "vendor"].includes(entityType)) {
      const error = new Error('entityType must be "user" or "vendor"');
      error.code = "INVALID_ENTITY_TYPE";
      throw error;
    }
    if (!entityId) {
      const error = new Error("entityId is required");
      error.code = "ENTITY_ID_REQUIRED";
      throw error;
    }

    if (!amount || amount <= 0) {
      const error = new Error("amount must be greater than 0");
      error.code = "INVALID_AMOUNT";
      throw error;
    }

    if (!transactionId) {
      const error = new Error("transactionId is required");
      error.code = "TRANSACTION_ID_REQUIRED";
      throw error;
    }

    // Extract metadata with defaults
    const {
      idempotencyKey,
      financialOperationId,
      entryType = "PAYMENT",
      source = "payment_verification",
      paymentId,
      orderId,
      refundId,
      requestId = crypto.randomUUID(),
      ipAddress,
      createdBy = "system",
      referenceType = "transaction",
      referenceId = transactionId,
      gateway = "razorpay",
      currency = "INR",
      discount = 0,
      finalAmount = amount,
      metadata: additionalMetadata = {},
    } = metadata;

    // CRITICAL: Validate idempotencyKey
    if (!idempotencyKey || idempotencyKey.trim() === "") {
      WalletLogger.error(
        {
          entityType,
          entityId,
          amount,
          transactionId,
          metadataKeys: Object.keys(metadata),
          hasIdempotencyKey: !!idempotencyKey,
        },
        "idempotencyKey is required for wallet credit",
      );

      const error = new Error("idempotencyKey is required and cannot be empty");
      error.code = "IDEMPOTENCY_KEY_REQUIRED";
      throw error;
    }

    // CRITICAL: Validate financialOperationId
    if (!financialOperationId || financialOperationId.trim() === "") {
      WalletLogger.error(
        {
          entityType,
          entityId,
          amount,
          transactionId,
          metadataKeys: Object.keys(metadata),
          hasFinancialOperationId: !!financialOperationId,
        },
        "financialOperationId is required for wallet credit",
      );

      const error = new Error("financialOperationId is required and cannot be empty");
      error.code = "FINANCIAL_OPERATION_ID_REQUIRED";
      throw error;
    }

    // Normalize IDs
    const normalizedIdempotencyKey = idempotencyKey.trim();
    const normalizedFinancialOperationId = financialOperationId.trim();

    WalletLogger.debug(
      {
        entityType,
        entityId,
        amount,
        transactionId,
        idempotencyKey: normalizedIdempotencyKey,
        financialOperationId: normalizedFinancialOperationId,
        entryType,
        source,
      },
      "Starting wallet credit with ledger entry",
    );

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      let entity;
      let previousBalance;
      let updated;

      // Get entity and current balance
      if (entityType === "user") {
        entity = await User.findById(entityId).session(session);
        if (!entity) {
          throw new Error("User not found");
        }
        previousBalance = entity.balance || 0;

        updated = await User.findByIdAndUpdate(
          entityId,
          {
            $inc: {
              balance: amount,
              totalDiscount: totalDiscount,
              transactionCount: 1,
              totalOriginalAmount: originalAmount,
            },
          },
          { new: true, session },
        );
      } else if (entityType === "vendor") {
        entity = await Vendor.findById(entityId).session(session);
        if (!entity) {
          throw new Error("Vendor not found");
        }
        previousBalance = entity.balance || 0;

        updated = await Vendor.findByIdAndUpdate(
          entityId,
          {
            $inc: {
              balance: amount,
              totalDiscount: totalDiscount,
              transactionCount: 1,
              totalOriginalAmount: originalAmount,
            },
          },
          { new: true, session },
        );
      } else {
        throw new Error("Invalid entity type");
      }

      // Create ledger entry with ALL required fields
      const ledgerData = {
        // Entity reference
        userId: entityType === "user" ? entityId : undefined,
        vendorId: entityType === "vendor" ? entityId : undefined,

        // Transaction references
        transactionId: transactionId,
        paymentId: paymentId || undefined,
        orderId: orderId || undefined,
        refundId: refundId || undefined,

        // Ledger entries
        credit: amount,
        debit: 0,
        balanceBefore: previousBalance,
        balanceAfter: updated.balance,

        // Entry type - REQUIRED
        entryType: entryType,

        // Reference - REQUIRED
        referenceType: referenceType,
        referenceId: referenceId,

        // Running balance
        runningBalance: updated.balance,

        // Idempotency - REQUIRED
        idempotencyKey: normalizedIdempotencyKey,

        // Financial operation ID - REQUIRED
        financialOperationId: normalizedFinancialOperationId,

        // Source and tracking
        source: source,
        requestId: requestId,
        ipAddress: ipAddress || undefined,

        // Who performed the operation
        createdBy: createdBy,

        // Metadata
        metadata: {
          discount: discount,
          finalAmount: finalAmount,
          gateway: gateway,
          currency: currency,
          ...additionalMetadata,
        },
      };

      // Log the ledger data for debugging (without sensitive info)
      WalletLogger.debug(
        {
          entityType,
          entityId,
          transactionId,
          amount,
          idempotencyKey: normalizedIdempotencyKey,
          financialOperationId: normalizedFinancialOperationId,
          entryType,
          balanceBefore: previousBalance,
          balanceAfter: updated.balance,
        },
        "Creating WalletLedger entry",
      );

      const ledgerEntry = new WalletLedger(ledgerData);
      await ledgerEntry.save({ session });

      await session.commitTransaction();

      WalletLogger.info(
        {
          entityType,
          entityId,
          transactionId,
          amount,
          balanceAfter: updated.balance,
          ledgerId: ledgerEntry._id,
          idempotencyKey: normalizedIdempotencyKey,
          financialOperationId: normalizedFinancialOperationId,
        },
        "Wallet credited successfully with ledger entry",
      );
      return { entity: updated, ledger: ledgerEntry };
    } catch (error) {
      await session.abortTransaction();

      // Enhanced error logging
      WalletLogger.error(
        {
          error: error.message,
          errorCode: error.code,
          errorName: error.name,
          entityType,
          entityId,
          amount,
          transactionId,
          idempotencyKey: normalizedIdempotencyKey,
          financialOperationId: normalizedFinancialOperationId,
          stack: error.stack,
        },
        "Wallet credit failed",
      );

      // Handle validation errors with better context
      if (error.name === "ValidationError") {
        const validationErrors = Object.keys(error.errors).map((key) => ({
          field: key,
          message: error.errors[key].message,
          value: error.errors[key].value,
        }));

        const enhancedError = new Error(
          `WalletLedger validation failed: ${validationErrors.map((e) => `${e.field}: ${e.message}`).join(", ")}`,
        );
        enhancedError.code = "VALIDATION_ERROR";
        enhancedError.details = validationErrors;
        throw enhancedError;
      }

      throw error;
    } finally {
      await session.endSession();
    }
  }

  /**
   * PHASE 6: Debit wallet with ledger entry
   * @param {string} entityType - 'user' or 'vendor'
   * @param {string} entityId - User or Vendor ID
   * @param {number} amount - Amount to debit
   * @param {string} transactionId - Transaction ID
   * @param {Object} metadata - Additional metadata
   * @param {string} metadata.idempotencyKey - Unique key for idempotency (REQUIRED)
   * @param {string} metadata.financialOperationId - Global financial operation ID (REQUIRED)
   * @param {string} metadata.entryType - Entry type (default: 'PAYMENT')
   * @param {string} metadata.source - Source of the debit
   * @param {string} metadata.paymentId - Payment ID
   * @param {string} metadata.orderId - Order ID
   * @param {string} metadata.requestId - Request ID
   * @param {string} metadata.ipAddress - IP Address
   * @param {Object} metadata.metadata - Additional metadata
   * @param {string} metadata.createdBy - Who created this entry
   * @param {string} metadata.referenceType - Reference type
   * @param {string} metadata.referenceId - Reference ID
   * @param {string} metadata.gateway - Payment gateway
   * @param {string} metadata.currency - Currency
   * @returns {Promise<Object>} Result with entity and ledger
   */
  async debit(entityType, entityId, amount, transactionId, metadata = {}) {
    // Validate required parameters
    if (!entityType || !["user", "vendor"].includes(entityType)) {
      const error = new Error('entityType must be "user" or "vendor"');
      error.code = "INVALID_ENTITY_TYPE";
      throw error;
    }

    if (!entityId) {
      const error = new Error("entityId is required");
      error.code = "ENTITY_ID_REQUIRED";
      throw error;
    }

    if (!amount || amount <= 0) {
      const error = new Error("amount must be greater than 0");
      error.code = "INVALID_AMOUNT";
      throw error;
    }

    if (!transactionId) {
      const error = new Error("transactionId is required");
      error.code = "TRANSACTION_ID_REQUIRED";
      throw error;
    }

    // Extract metadata with defaults
    const {
      idempotencyKey,
      financialOperationId,
      entryType = "PAYMENT",
      source = "payment_verification",
      paymentId,
      orderId,
      refundId,
      requestId = crypto.randomUUID(),
      ipAddress,
      createdBy = "system",
      referenceType = "transaction",
      referenceId = transactionId,
      gateway = "razorpay",
      currency = "INR",
      discount = 0,
      finalAmount = amount,
      metadata: additionalMetadata = {},
      reason = "Debit transaction",
    } = metadata;

    // CRITICAL: Validate idempotencyKey
    if (!idempotencyKey || idempotencyKey.trim() === "") {
      WalletLogger.error(
        {
          entityType,
          entityId,
          amount,
          transactionId,
          metadataKeys: Object.keys(metadata),
          hasIdempotencyKey: !!idempotencyKey,
        },
        "idempotencyKey is required for wallet debit",
      );

      const error = new Error("idempotencyKey is required and cannot be empty");
      error.code = "IDEMPOTENCY_KEY_REQUIRED";
      throw error;
    }

    // CRITICAL: Validate financialOperationId
    if (!financialOperationId || financialOperationId.trim() === "") {
      WalletLogger.error(
        {
          entityType,
          entityId,
          amount,
          transactionId,
          metadataKeys: Object.keys(metadata),
          hasFinancialOperationId: !!financialOperationId,
        },
        "financialOperationId is required for wallet debit",
      );

      const error = new Error("financialOperationId is required and cannot be empty");
      error.code = "FINANCIAL_OPERATION_ID_REQUIRED";
      throw error;
    }

    // Normalize IDs
    const normalizedIdempotencyKey = idempotencyKey.trim();
    const normalizedFinancialOperationId = financialOperationId.trim();

    WalletLogger.debug(
      {
        entityType,
        entityId,
        amount,
        transactionId,
        idempotencyKey: normalizedIdempotencyKey,
        financialOperationId: normalizedFinancialOperationId,
        entryType,
        source,
      },
      "Starting wallet debit with ledger entry",
    );

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      let entity;
      let previousBalance;
      let updated;

      if (entityType === "user") {
        entity = await User.findById(entityId).session(session);
        if (!entity) {
          throw new Error("User not found");
        }
        if ((entity.balance || 0) < amount) {
          throw new Error("Insufficient balance");
        }
        previousBalance = entity.balance || 0;

        updated = await User.findByIdAndUpdate(
          entityId,
          { $inc: { balance: -amount } },
          { new: true, session },
        );
      } else if (entityType === "vendor") {
        entity = await Vendor.findById(entityId).session(session);
        if (!entity) {
          throw new Error("Vendor not found");
        }
        if ((entity.balance || 0) < amount) {
          throw new Error("Insufficient balance");
        }
        previousBalance = entity.balance || 0;

        updated = await Vendor.findByIdAndUpdate(
          entityId,
          { $inc: { balance: -amount } },
          { new: true, session },
        );
      } else {
        throw new Error("Invalid entity type");
      }

      // Create ledger entry with ALL required fields
      const ledgerData = {
        // Entity reference
        userId: entityType === "user" ? entityId : undefined,
        vendorId: entityType === "vendor" ? entityId : undefined,

        // Transaction references
        transactionId: transactionId,
        paymentId: paymentId || undefined,
        orderId: orderId || undefined,
        refundId: refundId || undefined,

        // Ledger entries
        credit: 0,
        debit: amount,
        balanceBefore: previousBalance,
        balanceAfter: updated.balance,

        // Entry type - REQUIRED
        entryType: entryType,

        // Reference - REQUIRED
        referenceType: referenceType,
        referenceId: referenceId,

        // Running balance
        runningBalance: updated.balance,

        // Idempotency - REQUIRED
        idempotencyKey: normalizedIdempotencyKey,

        // Financial operation ID - REQUIRED
        financialOperationId: normalizedFinancialOperationId,

        // Source and tracking
        source: source,
        requestId: requestId,
        ipAddress: ipAddress || undefined,

        // Who performed the operation
        createdBy: createdBy,

        // Metadata
        metadata: {
          discount: discount,
          finalAmount: finalAmount,
          gateway: gateway,
          currency: currency,
          reason: reason,
          ...additionalMetadata,
        },
      };

      WalletLogger.debug(
        {
          entityType,
          entityId,
          transactionId,
          amount,
          idempotencyKey: normalizedIdempotencyKey,
          financialOperationId: normalizedFinancialOperationId,
          entryType,
          balanceBefore: previousBalance,
          balanceAfter: updated.balance,
        },
        "Creating WalletLedger debit entry",
      );

      const ledgerEntry = new WalletLedger(ledgerData);
      await ledgerEntry.save({ session });

      await session.commitTransaction();

      WalletLogger.info(
        {
          entityType,
          entityId,
          transactionId,
          amount,
          balanceAfter: updated.balance,
          ledgerId: ledgerEntry._id,
          idempotencyKey: normalizedIdempotencyKey,
          financialOperationId: normalizedFinancialOperationId,
        },
        "Wallet debited successfully with ledger entry",
      );

      return { entity: updated, ledger: ledgerEntry };
    } catch (error) {
      await session.abortTransaction();

      WalletLogger.error(
        {
          error: error.message,
          errorCode: error.code,
          errorName: error.name,
          entityType,
          entityId,
          amount,
          transactionId,
          idempotencyKey: normalizedIdempotencyKey,
          financialOperationId: normalizedFinancialOperationId,
          stack: error.stack,
        },
        "Wallet debit failed",
      );

      // Handle validation errors with better context
      if (error.name === "ValidationError") {
        const validationErrors = Object.keys(error.errors).map((key) => ({
          field: key,
          message: error.errors[key].message,
          value: error.errors[key].value,
        }));

        const enhancedError = new Error(
          `WalletLedger validation failed: ${validationErrors.map((e) => `${e.field}: ${e.message}`).join(", ")}`,
        );
        enhancedError.code = "VALIDATION_ERROR";
        enhancedError.details = validationErrors;
        throw enhancedError;
      }

      throw error;
    } finally {
      await session.endSession();
    }
  }

  /**
   * Get balance with ledger verification
   */
  async getBalanceWithLedger(entityType, entityId) {
    const lastLedger = await WalletLedger.findOne({
      $or: [
        { userId: entityType === "user" ? entityId : undefined },
        { vendorId: entityType === "vendor" ? entityId : undefined },
      ],
    })
      .sort({ createdAt: -1 })
      .lean();

    let entity;
    if (entityType === "user") {
      entity = await User.findById(entityId).select("balance").lean();
    } else {
      entity = await Vendor.findById(entityId).select("balance").lean();
    }

    return {
      balance: entity?.balance || 0,
      lastLedgerBalance: lastLedger?.balanceAfter || 0,
      consistent: entity?.balance === lastLedger?.balanceAfter,
    };
  }

  /**
   * Get ledger entries for an entity
   */
  async getLedgerEntries(entityType, entityId, limit = 100, skip = 0) {
    const filter = entityType === "user" ? { userId: entityId } : { vendorId: entityId };

    const entries = await WalletLedger.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    const total = await WalletLedger.countDocuments(filter);

    return {
      entries,
      total,
      limit,
      skip,
    };
  }
}

module.exports = new WalletService();
