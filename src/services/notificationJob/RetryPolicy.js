"use strict";

const CONFIG = require("../../config/notification.config");

/**
 * RetryPolicy - All retry configuration and calculations
 * Single source of truth for retry logic
 */
class RetryPolicy {
  /**
   * Get maximum attempts
   */
  getMaxAttempts() {
    return CONFIG.MAX_ATTEMPTS;
  }

  /**
   * Calculate retry delay with exponential backoff and jitter
   */
  calculateDelay(attempt) {
    const baseDelay = CONFIG.RETRY_BASE_DELAY_MS;
    const exponentialDelay = baseDelay * Math.pow(2, attempt - 1);

    // Add jitter (±20%) to prevent thundering herd
    const jitter = Math.random() * 0.4 + 0.8;
    const delayWithJitter = exponentialDelay * jitter;

    // Cap at maximum delay
    return Math.min(delayWithJitter, CONFIG.MAX_RETRY_DELAY_MS);
  }

  /**
   * Get next retry time
   */
  getNextRetryTime(attempt) {
    const delay = this.calculateDelay(attempt);
    return new Date(Date.now() + delay);
  }

  /**
   * Check if retry should be attempted
   */
  shouldRetry(attemptsMade, maxAttempts) {
    return attemptsMade < maxAttempts;
  }

  /**
   * Check if retries are exhausted
   */
  isExhausted(attemptsMade, maxAttempts) {
    return attemptsMade >= maxAttempts;
  }

  /**
   * Get base delay
   */
  getBaseDelay() {
    return CONFIG.RETRY_BASE_DELAY_MS;
  }

  /**
   * Get max delay
   */
  getMaxDelay() {
    return CONFIG.MAX_RETRY_DELAY_MS;
  }

  /**
   * Get jitter range
   */
  getJitterRange() {
    return { min: 0.8, max: 1.2 };
  }
}

module.exports = new RetryPolicy();
