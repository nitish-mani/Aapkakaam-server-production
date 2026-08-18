"use strict";

const RedisService = require("../../services/RedisService");
const RedisKeys = require("../../utils/redisKeys");
const CONFIG = require("../../config/notification.config");

/**
 * LockManager - Pure Redis locking operations
 * No business logic, no logging, no metrics
 * Returns lock status only
 */
class LockManager {
  /**
   * Generate unique lock token
   */
  generateToken() {
    return RedisService.generateLockToken();
  }

  /**
   * Acquire distributed lock with ownership token
   * Returns: { acquired: boolean, lockKey, lockToken, lockTTL }
   */
  async acquireLock(notificationId, job) {
    const timeout = job?.opts?.timeout ?? CONFIG.JOB_TIMEOUT_MS;
    const lockTTL = Math.ceil(timeout / 1000) + CONFIG.LOCK_BUFFER_SECONDS;
    const lockKey = RedisKeys.NOTIFICATION_LOCK(notificationId);
    const lockToken = RedisService.generateLockToken();

    const acquired = await RedisService.acquireLock(lockKey, lockTTL, lockToken);

    if (!acquired) {
      return {
        acquired: false,
        lockKey,
        lockToken: null,
        lockTTL: null,
      };
    }

    return {
      acquired: true,
      lockKey,
      lockToken,
      lockTTL,
    };
  }

  /**
   * Release lock with ownership validation
   * Returns: { released: boolean }
   */
  async releaseLock(lockKey, lockToken) {
    const released = await RedisService.releaseLock(lockKey, lockToken);
    return { released };
  }

  /**
   * Renew lock with ownership validation
   * Returns: { renewed: boolean }
   */
  async renewLock(lockKey, lockTTL, lockToken) {
    const renewed = await RedisService.renewLock(lockKey, lockTTL, lockToken);
    return { renewed };
  }

  /**
   * Start safe lock renewal with cancellation support
   * Returns: { stop: function, isActive: function }
   */
  startRenewal(lockKey, lockTTL, lockToken, abortController) {
    let isRenewing = false;
    let shouldStop = false;
    let timeoutId = null;

    const renew = async () => {
      if (isRenewing || shouldStop || abortController.signal.aborted) return;

      isRenewing = true;

      try {
        const result = await this.renewLock(lockKey, lockTTL, lockToken);

        if (result.renewed) {
          if (!shouldStop && !abortController.signal.aborted) {
            scheduleNextRenewal();
          }
        } else {
          shouldStop = true;
          abortController.abort();
        }
      } catch (err) {
        shouldStop = true;
        abortController.abort();
      } finally {
        isRenewing = false;
      }
    };

    const scheduleNextRenewal = () => {
      if (shouldStop || abortController.signal.aborted) return;

      const renewalInterval = lockTTL * CONFIG.LOCK_RENEWAL_INTERVAL_FACTOR * 1000;

      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }

      timeoutId = setTimeout(() => {
        setImmediate(() => {
          renew().catch(() => {
            // Errors are handled inside renew
          });
        });
      }, renewalInterval);
    };

    scheduleNextRenewal();

    return {
      stop: () => {
        shouldStop = true;
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
      },
      isActive: () => !shouldStop && !abortController.signal.aborted,
    };
  }

  /**
   * Check if lock is still valid with ownership validation
   * Returns: { valid: boolean, ttl: number }
   */
  async checkLock(lockKey, lockToken) {
    const ttl = await RedisService.getLockTTL(lockKey, lockToken);
    return {
      valid: ttl > 0,
      ttl,
    };
  }
}

module.exports = new LockManager();
