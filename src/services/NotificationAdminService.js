"use strict";

const logger = require("../logger/logger");
const NotificationRepository = require("./NotificationJob/NotificationRepository");
const NotificationStateMachine = require("./NotificationJob/NotificationStateMachine");
const MetricsService = require("./NotificationJob/MetricsService");

/**
 * NotificationAdminService - Administrative operations
 * Separated from NotificationJob for better maintainability
 */
class NotificationAdminService {
  /**
   * Get notification status with full context
   */
  async getStatus(notificationId) {
    try {
      const notification = await NotificationRepository.findById(
        notificationId,
        "notificationId status attempts lastAttempt nextRetry error createdAt updatedAt",
      );

      if (!notification) {
        return {
          success: false,
          error: "Notification not found",
        };
      }

      return {
        success: true,
        notification: {
          id: notification.notificationId,
          status: notification.status,
          attempts: notification.attempts,
          lastAttempt: notification.lastAttempt,
          nextRetry: notification.nextRetry,
          error: notification.error,
          createdAt: notification.createdAt,
          updatedAt: notification.updatedAt,
          isTerminal: NotificationStateMachine.isTerminal(notification.status),
          isPending: NotificationStateMachine.isPending(notification.status),
        },
      };
    } catch (error) {
      logger.error(
        {
          err: error,
          notificationId,
          event: "STATUS_CHECK_FAILED",
        },
        "Failed to get notification status",
      );

      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Manually retry a failed notification
   */
  async manualRetry(notificationId) {
    try {
      const notification = await NotificationRepository.updateStatus(notificationId, "queued", {
        attempts: 0,
        nextRetry: new Date(),
        error: null,
      });

      if (!notification) {
        return {
          success: false,
          error: "Notification not found or not in failed state",
        };
      }

      MetricsService.recordMetric("MANUAL_RETRY", {
        notificationId,
      });

      logger.info(
        {
          notificationId,
          event: "MANUAL_RETRY_INITIATED",
        },
        "Manual retry initiated for failed notification",
      );

      return {
        success: true,
        notificationId,
        status: notification.status,
      };
    } catch (error) {
      logger.error(
        {
          err: error,
          notificationId,
          event: "MANUAL_RETRY_FAILED",
        },
        "Manual retry failed",
      );

      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Bulk retry failed notifications
   */
  async bulkRetry(filter = {}, limit = 100) {
    try {
      const maxLimit = Math.min(limit, 1000);

      const result = await NotificationRepository.find(
        {
          status: "failed",
          ...filter,
        },
        {
          limit: maxLimit,
          projection: "_id",
        },
      );

      if (result.notifications.length === 0) {
        return {
          success: true,
          count: 0,
          message: "No failed notifications to retry",
        };
      }

      const notificationIds = result.notifications.map((n) => n._id);
      let updated = 0;

      for (const id of notificationIds) {
        const retryResult = await this.manualRetry(id);
        if (retryResult.success) updated++;
      }

      MetricsService.recordMetric("BULK_RETRY", {
        count: updated,
      });

      logger.info(
        {
          count: updated,
          filter,
          event: "BULK_RETRY_INITIATED",
        },
        "Bulk retry initiated for failed notifications",
      );

      return {
        success: true,
        count: updated,
        notificationIds,
      };
    } catch (error) {
      logger.error(
        {
          err: error,
          filter,
          event: "BULK_RETRY_FAILED",
        },
        "Bulk retry failed",
      );

      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Get notification statistics
   */
  async getStats(filter = {}) {
    try {
      return await NotificationRepository.getStats(filter);
    } catch (error) {
      logger.error(
        {
          err: error,
          filter,
          event: "STATS_FETCH_FAILED",
        },
        "Failed to get notification statistics",
      );

      return {
        success: false,
        error: error.message,
      };
    }
  }
}

module.exports = new NotificationAdminService();
