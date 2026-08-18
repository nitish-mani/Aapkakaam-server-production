"use strict";

const logger = require("../../logger/logger");

/**
 * MetricsService - All metrics recording
 * Single Responsibility: Record metrics through logger (extensible for Prometheus)
 */
class MetricsService {
  /**
   * Record metric with structured logging
   */
  recordMetric(metricName, data = {}) {
    const metric = {
      event: metricName,
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV || "development",
      ...data,
    };

    // Log at appropriate level based on metric type
    if (metricName.startsWith("ERROR_") || metricName.startsWith("FAILURE_")) {
      logger.error(metric, `Metric: ${metricName}`);
    } else if (metricName.startsWith("WARNING_")) {
      logger.warn(metric, `Metric: ${metricName}`);
    } else {
      logger.info(metric, `Metric: ${metricName}`);
    }
  }

  /**
   * Record provider latency
   */
  recordProviderLatency(notificationId, provider, latency, requestId) {
    this.recordMetric("PROVIDER_LATENCY", {
      notificationId,
      provider,
      latency,
      requestId,
    });
  }

  /**
   * Record duplicate prevented
   */
  recordDuplicatePrevented(notificationId, lockKey, requestId) {
    this.recordMetric("DUPLICATE_PREVENTED", {
      notificationId,
      lockKey,
      requestId,
      workerId: process.pid,
    });
  }

  /**
   * Record lock ownership lost
   */
  recordLockOwnershipLost(notificationId, lockKey, requestId) {
    this.recordMetric("LOCK_OWNERSHIP_LOST", {
      notificationId,
      lockKey,
      requestId,
      workerId: process.pid,
    });
  }

  /**
   * Record lock release failed
   */
  recordLockReleaseFailed(notificationId, lockKey, requestId, error) {
    this.recordMetric("LOCK_RELEASE_FAILED", {
      notificationId,
      lockKey,
      requestId,
      error,
    });
  }

  /**
   * Record Redis renewal failure
   */
  recordRedisRenewalFailure(notificationId, lockKey, requestId, error) {
    this.recordMetric("REDIS_RENEWAL_FAILURE", {
      notificationId,
      lockKey,
      requestId,
      error,
    });
  }

  /**
   * Record version conflict
   */
  recordVersionConflict(notificationId, expectedVersion, actualVersion) {
    this.recordMetric("VERSION_CONFLICT", {
      notificationId,
      expectedVersion,
      actualVersion,
    });
  }

  /**
   * Record invalid state transition
   */
  recordInvalidStateTransition(notificationId, expectedStatus, actualStatus) {
    this.recordMetric("INVALID_STATE_TRANSITION", {
      notificationId,
      expectedStatus,
      actualStatus,
    });
  }

  /**
   * Record MongoDB update failure
   */
  recordMongoDBUpdateFailure(notificationId, version, error) {
    this.recordMetric("MONGODB_UPDATE_FAILURE", {
      notificationId,
      version,
      error,
    });
  }

  /**
   * Record notification deleted
   */
  recordNotificationDeleted(notificationId, expectedVersion) {
    this.recordMetric("NOTIFICATION_DELETED", {
      notificationId,
      expectedVersion,
    });
  }

  /**
   * Record successful notification delivery
   */
  recordDeliverySuccess(notificationId, provider, duration, requestId) {
    this.recordMetric("NOTIFICATION_DELIVERED", {
      notificationId,
      provider,
      duration,
      requestId,
    });
  }

  /**
   * Record notification processing started
   */
  recordProcessingStarted(notificationId, provider, template, requestId) {
    this.recordMetric("NOTIFICATION_PROCESSING_STARTED", {
      notificationId,
      provider,
      template,
      requestId,
    });
  }
}

module.exports = new MetricsService();
