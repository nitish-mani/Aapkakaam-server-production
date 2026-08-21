"use strict";

const Notification = require("../../../models/notification");
const NotificationStateMachine = require("./NotificationStateMachine");
const { RetryableError, PermanentError } = require("../../utils/retryableErrors");
const CONFIG = require("../../config/notification.config");
const logger = require("../../config/logger");

const mongoose = require("mongoose");
/**
 * NotificationRepository - All MongoDB operations
 * Single Responsibility: Database operations only
 * No business logic, no logging, no metrics
 */
class NotificationRepository {
  /**
   * Acquire notification for processing with optimistic concurrency
   */
  /**
   * Acquire notification for processing with optimistic concurrency
   *
   * IMPORTANT:
   *
   * BullMQ already guarantees that one job is actively assigned
   * to one worker at a time.
   *
   * MongoDB additionally protects the notification document from
   * concurrent processing.
   */
  async acquireForProcessing(notificationId, attemptsMade) {
    if (!notificationId) {
      throw new Error("notificationId is required");
    }

    const now = new Date();

    // ============================================================
    // ATOMIC CLAIM
    // ============================================================

    const notification = await Notification.findOneAndUpdate(
      {
        _id: notificationId,

        status: {
          $in: ["queued", "pending", "retrying"],
        },

        $or: [
          {
            nextRetry: {
              $exists: false,
            },
          },

          {
            nextRetry: null,
          },

          {
            nextRetry: {
              $lte: now,
            },
          },
        ],
      },

      {
        $set: {
          status: "processing",

          lastAttempt: now,

          attempts: attemptsMade,

          processedAt: now,

          updatedAt: now,
        },
      },

      {
        new: true,

        runValidators: true,

        writeConcern: {
          w: "majority",
          j: true,
        },
      },
    );

    // ============================================================
    // CLAIM SUCCESSFUL
    // ============================================================

    if (notification) {
      return notification;
    }

    // ============================================================
    // CLAIM FAILED
    // ============================================================

    const existing = await Notification.findById(notificationId)
      .select("_id status __v attempts channel channelIndex channelPolicy nextRetry")
      .lean();

    // ------------------------------------------------------------
    // NOT FOUND
    // ------------------------------------------------------------

    if (!existing) {
      throw new PermanentError(`Notification not found: ${notificationId}`);
    }

    // ------------------------------------------------------------
    // ALREADY PROCESSING
    // ------------------------------------------------------------

    if (existing.status === "processing") {
      return null;
    }

    // ------------------------------------------------------------
    // ALREADY SENT
    // ------------------------------------------------------------

    if (existing.status === "sent") {
      return null;
    }

    // ------------------------------------------------------------
    // ALREADY FAILED
    // ------------------------------------------------------------

    if (existing.status === "failed") {
      return null;
    }

    // ------------------------------------------------------------
    // CANCELLED
    // ------------------------------------------------------------

    if (existing.status === "cancelled") {
      return null;
    }

    // ------------------------------------------------------------
    // RETRY NOT YET DUE
    // ------------------------------------------------------------

    if (existing.nextRetry && existing.nextRetry > now) {
      return null;
    }

    // ------------------------------------------------------------
    // UNKNOWN STATE
    // ------------------------------------------------------------

    throw new RetryableError(
      `Unable to claim notification ${notificationId}. Current status: ${existing.status}`,
    );
  }

  /**
   * Find notification by ID with optional projection
   * ✅ Always includes __v for safety
   */
  async findById(notificationId, projection = null) {
    if (projection) {
      // ✅ Ensure __v is always included in projections
      const projectionStr = projection.includes("__v") ? projection : `${projection} __v`;
      return Notification.findById(notificationId).select(projectionStr).lean();
    }
    return Notification.findById(notificationId);
  }

  /**
   * Find notifications with filter and options
   * ✅ Always includes __v for safety
   */
  async find(filter = {}, options = {}) {
    const { limit = 50, skip = 0, sort = { createdAt: -1 }, projection = null } = options;

    let query = Notification.find(filter);

    if (projection) {
      // ✅ Ensure __v is always included in projections
      const projectionStr = projection.includes("__v") ? projection : `${projection} __v`;
      query = query.select(projectionStr);
    }

    const [notifications, total] = await Promise.all([
      query.sort(sort).limit(limit).skip(skip).lean(),
      Notification.countDocuments(filter),
    ]);

    return {
      notifications,
      total,
      limit,
      skip,
      hasMore: skip + notifications.length < total,
    };
  }

  /**
   * Get notification status only
   * ✅ Always includes __v
   */
  async getStatus(notificationId) {
    return Notification.findById(notificationId).select("status __v").lean();
  }

  /**
   * Get notification with version for optimistic updates
   * ✅ Always includes __v (explicitly)
   */
  async getWithVersion(notificationId) {
    return Notification.findById(notificationId)
      .select(
        "status __v type channel channelIndex channelPolicy attempts template source recipient requestId nextRetry",
      )
      .lean();
  }

  /**
   * Update with optimistic concurrency control
   * ✅ Production-grade with proper error context
   */
  async updateWithConcurrency(notificationId, update, version) {
    // ✅ Strict validation
    if (version === null || version === undefined) {
      throw new Error("Version is required for optimistic concurrency");
    }

    // ✅ Ensure version is a number
    const versionNum = typeof version === "number" ? version : parseInt(version, 10);

    if (isNaN(versionNum)) {
      throw new Error(`Invalid version value: ${version}`);
    }

    const result = await Notification.findOneAndUpdate(
      {
        _id: notificationId,
        __v: versionNum,
      },
      update,
      {
        new: true,
        runValidators: true,
        writeConcern: { w: "majority", j: true },
      },
    );

    if (!result) {
      // Check what happened to provide better error context
      const existing = await Notification.findById(notificationId).select("status __v").lean();

      if (!existing) {
        throw new PermanentError("Notification not found");
      }

      if (existing.__v !== versionNum) {
        throw new RetryableError(`Version conflict: expected ${versionNum}, got ${existing.__v}`);
      }

      if (existing.status !== "processing" && existing.status !== "queued") {
        throw new PermanentError(`Invalid state for update: ${existing.status}`);
      }

      throw new RetryableError("Unknown conflict - retry operation");
    }

    return result;
  }

  /**
   * Mark notification as sent with response
   */
  async markSent(notificationId, response, duration, attempts, version) {
    const update = {
      $set: {
        status: "sent",
        success: true,
        response: response || null,
        error: null,
        sentAt: new Date(),
        processedAt: new Date(),
        nextRetry: null,
        delivery: {
          sentAt: new Date(),
          attempts: attempts,
          providerLatency: duration,
          deliveredVia: response?.provider || "unknown",
        },
        performance: {
          processingEndedAt: new Date(),
          totalProcessingTime: duration,
        },
        updatedAt: new Date(),
      },
    };

    return this.updateWithConcurrency(notificationId, update, version);
  }

  /**
   * Mark notification as failed with error
   */
  async markFailed(notificationId, error, attemptsMade, reason, version) {
    const update = {
      $set: {
        status: "failed",
        success: false,
        error: error || null,
        processedAt: new Date(),
        updatedAt: new Date(),
        failureReason: reason || "permanent_error",
      },

      $push: {
        failureHistory: {
          $each: [
            {
              attempt: attemptsMade,
              error: error || null,
              timestamp: new Date(),
            },
          ],
          $slice: -CONFIG.MAX_FAILURE_HISTORY,
        },
      },
    };

    return this.updateWithConcurrency(notificationId, update, version);
  }

  /**
   * Mark notification as retrying
   */
  async markRetrying(notificationId, error, attemptsMade, nextRetryAt, version) {
    const update = {
      $set: {
        status: "retrying",
        success: false,
        error: error || null,
        nextRetry: nextRetryAt,
        processedAt: new Date(),
        updatedAt: new Date(),
        failureReason: "retry_scheduled",
      },

      $push: {
        failureHistory: {
          $each: [
            {
              attempt: attemptsMade,
              error: error || null,
              timestamp: new Date(),
            },
          ],
          $slice: -CONFIG.MAX_FAILURE_HISTORY,
        },
      },
    };

    return this.updateWithConcurrency(notificationId, update, version);
  }

  /**
   * Cancel notification
   */
  async cancel(notificationId, version) {
    const update = {
      $set: {
        status: "cancelled",
        cancelledAt: new Date(),
        updatedAt: new Date(),
        failureReason: "cancelled",
      },
    };

    return this.updateWithConcurrency(notificationId, update, version);
  }

  /**
   * Update status only (for admin operations)
   * ✅ Handles version retrieval internally
   */
  async updateStatus(notificationId, status, additionalData = {}) {
    // ✅ Get current version first
    const current = await this.getWithVersion(notificationId);
    if (!current) {
      throw new PermanentError(`Notification not found: ${notificationId}`);
    }

    const update = {
      $set: {
        status,
        updatedAt: new Date(),
        ...additionalData,
      },
    };

    return this.updateWithConcurrency(notificationId, update, current.__v);
  }

  /**
   * Get notification statistics
   */
  async getStats(filter = {}) {
    const match = { ...filter };

    if (filter.startDate || filter.endDate) {
      match.createdAt = {};
      if (filter.startDate) match.createdAt.$gte = new Date(filter.startDate);
      if (filter.endDate) match.createdAt.$lte = new Date(filter.endDate);
      delete filter.startDate;
      delete filter.endDate;
    }

    const stats = await Notification.aggregate([
      { $match: match },
      {
        $facet: {
          statusCounts: [
            {
              $group: {
                _id: "$status",
                count: { $sum: 1 },
              },
            },
          ],
          typeCounts: [
            {
              $group: {
                _id: "$type",
                count: { $sum: 1 },
              },
            },
          ],
          sourceCounts: [
            {
              $group: {
                _id: "$source",
                count: { $sum: 1 },
              },
            },
          ],
          total: [
            {
              $group: {
                _id: null,
                total: { $sum: 1 },
              },
            },
          ],
          successRate: [
            {
              $group: {
                _id: null,
                successful: {
                  $sum: { $cond: [{ $eq: ["$status", "sent"] }, 1, 0] },
                },
                failed: {
                  $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] },
                },
                retrying: {
                  $sum: { $cond: [{ $eq: ["$status", "retrying"] }, 1, 0] },
                },
              },
            },
          ],
        },
      },
    ]);

    const result = stats[0] || {};
    const total = result.total?.[0]?.total || 0;
    const successRate = result.successRate?.[0] || { successful: 0, failed: 0, retrying: 0 };

    return {
      statusCounts: result.statusCounts || [],
      typeCounts: result.typeCounts || [],
      sourceCounts: result.sourceCounts || [],
      total,
      successRate: {
        successful: successRate.successful || 0,
        failed: successRate.failed || 0,
        retrying: successRate.retrying || 0,
        rate: total > 0 ? ((successRate.successful / total) * 100).toFixed(2) : 0,
      },
    };
  }

  /**
   * Bulk update notifications
   * ✅ Handles version retrieval for each document
   */
  async bulkUpdate(filter, update) {
    // Get all matching IDs with versions
    const docs = await Notification.find(filter).select("_id __v").lean();

    if (docs.length === 0) {
      return { matchedCount: 0, modifiedCount: 0 };
    }

    let modifiedCount = 0;
    let matchedCount = docs.length;

    // Process each document with version checking
    for (const doc of docs) {
      try {
        await this.updateWithConcurrency(
          doc._id,
          {
            $set: {
              ...update.$set,
              updatedAt: new Date(),
            },
          },
          doc.__v,
        );
        modifiedCount++;
      } catch (error) {
        // Log but continue with other documents
        logger.warn(
          {
            error: error.message,
            notificationId: doc._id,
            event: "BULK_UPDATE_SKIPPED",
          },
          "Failed to update notification in bulk operation",
        );
      }
    }

    return { matchedCount, modifiedCount };
  }

  /**
   * Delete notifications
   */
  async deleteMany(filter) {
    return Notification.deleteMany(filter);
  }

  /**
   * Count notifications
   */
  async count(filter = {}) {
    return Notification.countDocuments(filter);
  }
}

module.exports = new NotificationRepository();
