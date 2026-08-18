"use strict";

const crypto = require("crypto");

const RedisService = require("./RedisService");

const { BookingLogger } = require("../logger/index");
/**
 * BookingLockService
 *
 * Distributed locking layer for booking operations.
 *
 * Purpose:
 * Prevent multiple API instances / PM2 workers from concurrently
 * processing conflicting bookings for the same vendor/date.
 *
 * Redis is only the concurrency guard.
 * MongoDB remains the source of truth.
 *
 * Flow:
 *
 * Request
 *   ↓
 * BookingLockService.acquire()
 *   ↓
 * MongoDB transaction
 *   ↓
 * Booking creation
 *   ↓
 * Commit
 *   ↓
 * BookingLockService.release()
 *
 * IMPORTANT:
 * The MongoDB duplicate-booking check must remain inside
 * the transaction even when Redis locking is enabled.
 */
class BookingLockService {
  constructor() {
    /**
     * Booking transactions should normally complete well below this.
     *
     * TTL prevents deadlocks if:
     * - process crashes
     * - PM2 restarts worker
     * - server crashes
     * - Redis connection is interrupted
     */
    this.DEFAULT_TTL_SECONDS = Math.max(10, Number(process.env.BOOKING_LOCK_TTL_SECONDS) || 30);

    /**
     * How often the lock should be renewed.
     *
     * 0.5 = renew when roughly half of TTL has elapsed.
     */
    this.RENEWAL_FACTOR = 0.5;
  }

  /**
   * Generate deterministic Redis lock key.
   *
   * Lock scope:
   *
   * vendor + bookingDate
   *
   * If your system allows multiple independent booking slots
   * for the same vendor on the same date, add bookingTime/slot
   * to this key later.
   */
  buildLockKey({ vendorId, bookingDate }) {
    if (!vendorId) {
      throw new Error("vendorId is required for booking lock");
    }

    if (!bookingDate) {
      throw new Error("bookingDate is required for booking lock");
    }

    const normalizedVendorId = vendorId.toString();

    const normalizedDate =
      bookingDate instanceof Date
        ? bookingDate.toISOString().slice(0, 10)
        : String(bookingDate).trim();

    return `lock:booking:${normalizedVendorId}:${normalizedDate}`;
  }

  /**
   * Generate unique ownership token.
   *
   * The token ensures that one request cannot accidentally
   * release another request's lock.
   */
  generateToken() {
    if (typeof RedisService.generateLockToken === "function") {
      return RedisService.generateLockToken();
    }

    return crypto.randomUUID();
  }

  /**
   * Acquire booking lock.
   *
   * Redis implementation should internally use:
   *
   * SET key token NX EX ttl
   *
   * Returns:
   *
   * {
   *   acquired: true/false,
   *   lockKey,
   *   lockToken,
   *   ttl
   * }
   */
  async acquire({ vendorId, bookingDate, requestId, ttlSeconds = this.DEFAULT_TTL_SECONDS }) {
    const lockKey = this.buildLockKey({
      vendorId,
      bookingDate,
    });

    const lockToken = this.generateToken();

    const ttl = Math.max(5, Number(ttlSeconds) || this.DEFAULT_TTL_SECONDS);

    const start = Date.now();

    try {
      const acquired = await RedisService.acquireLock(lockKey, ttl, lockToken);

      if (!acquired) {
        BookingLogger.warn(
          {
            event: "BOOKING_LOCK_CONTENTION",

            lockKey,
            vendorId: vendorId?.toString(),
            bookingDate,

            requestId,

            durationMs: Date.now() - start,
          },
          "Booking lock already held",
        );

        return {
          acquired: false,
          lockKey,
          lockToken: null,
          ttl,
        };
      }

      BookingLogger.debug(
        {
          event: "BOOKING_LOCK_ACQUIRED",

          lockKey,
          vendorId: vendorId?.toString(),
          bookingDate,

          requestId,

          ttl,
          durationMs: Date.now() - start,
        },
        "Booking lock acquired",
      );

      return {
        acquired: true,
        lockKey,
        lockToken,
        ttl,
      };
    } catch (error) {
      BookingLogger.error(
        {
          err: error,

          event: "BOOKING_LOCK_ACQUIRE_FAILED",

          lockKey,
          vendorId: vendorId?.toString(),
          bookingDate,

          requestId,
        },
        "Failed to acquire booking lock",
      );

      throw error;
    }
  }

  /**
   * Release booking lock.
   *
   * IMPORTANT:
   *
   * RedisService.releaseLock() must validate ownership.
   *
   * Never use:
   *
   * DEL lockKey
   *
   * directly.
   *
   * Otherwise Request A could accidentally delete
   * Request B's lock after A's original lock expired.
   */
  async release({ lockKey, lockToken, requestId }) {
    if (!lockKey || !lockToken) {
      return false;
    }

    try {
      const released = await RedisService.releaseLock(lockKey, lockToken);

      if (!released) {
        BookingLogger.warn(
          {
            event: "BOOKING_LOCK_RELEASE_REJECTED",

            lockKey,
            requestId,
          },
          "Booking lock was not released because ownership was lost",
        );

        return false;
      }

      BookingLogger.debug(
        {
          event: "BOOKING_LOCK_RELEASED",

          lockKey,
          requestId,
        },
        "Booking lock released",
      );

      return true;
    } catch (error) {
      BookingLogger.error(
        {
          err: error,

          event: "BOOKING_LOCK_RELEASE_FAILED",

          lockKey,
          requestId,
        },
        "Failed to release booking lock",
      );

      return false;
    }
  }

  /**
   * Renew lock TTL.
   *
   * RedisService must renew only if lockToken still owns
   * the lock.
   */
  async renew({ lockKey, lockToken, ttl, requestId }) {
    if (!lockKey || !lockToken) {
      return false;
    }

    try {
      const renewed = await RedisService.renewLock(lockKey, ttl, lockToken);

      if (!renewed) {
        BookingLogger.warn(
          {
            event: "BOOKING_LOCK_RENEWAL_REJECTED",

            lockKey,
            requestId,
          },
          "Booking lock ownership lost",
        );

        return false;
      }

      return true;
    } catch (error) {
      BookingLogger.error(
        {
          err: error,

          event: "BOOKING_LOCK_RENEWAL_FAILED",

          lockKey,
          requestId,
        },
        "Booking lock renewal failed",
      );

      return false;
    }
  }

  /**
   * Start automatic lock renewal.
   *
   * Useful if MongoDB transaction unexpectedly takes longer
   * than the original lock TTL.
   */
  startRenewal({ lockKey, lockToken, ttl, requestId }) {
    let stopped = false;
    let timer = null;
    let renewing = false;

    const intervalMs = Math.max(1000, Math.floor(ttl * this.RENEWAL_FACTOR * 1000));

    const schedule = () => {
      if (stopped) {
        return;
      }

      timer = setTimeout(async () => {
        if (stopped || renewing) {
          return;
        }

        renewing = true;

        try {
          const renewed = await this.renew({
            lockKey,
            lockToken,
            ttl,
            requestId,
          });

          if (!renewed) {
            stopped = true;

            BookingLogger.error(
              {
                event: "BOOKING_LOCK_OWNERSHIP_LOST",

                lockKey,
                requestId,
              },
              "Booking lock ownership lost during processing",
            );

            return;
          }
        } finally {
          renewing = false;
        }

        schedule();
      }, intervalMs);

      timer.unref?.();
    };

    schedule();

    return {
      stop() {
        stopped = true;

        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      },

      isActive() {
        return !stopped;
      },
    };
  }

  /**
   * Convenience wrapper.
   *
   * This makes correct lock handling much harder to forget.
   *
   * Example:
   *
   * await BookingLockService.withLock(
   *   { vendorId, bookingDate, requestId },
   *   async () => {
   *      // MongoDB transaction
   *   }
   * );
   */
  async withLock({ vendorId, bookingDate, requestId, ttlSeconds }, callback) {
    if (typeof callback !== "function") {
      throw new Error("Booking lock callback must be a function");
    }

    const lock = await this.acquire({
      vendorId,
      bookingDate,
      requestId,
      ttlSeconds,
    });

    if (!lock.acquired) {
      const error = new Error(
        "This vendor booking is currently being processed. Please try again.",
      );

      error.code = "BOOKING_LOCKED";
      error.statusCode = 409;

      throw error;
    }

    const renewal = this.startRenewal({
      lockKey: lock.lockKey,
      lockToken: lock.lockToken,
      ttl: lock.ttl,
      requestId,
    });

    try {
      return await callback();
    } finally {
      /*
       * Stop renewal BEFORE releasing.
       *
       * Otherwise renewal could race with release.
       */
      renewal.stop();

      await this.release({
        lockKey: lock.lockKey,
        lockToken: lock.lockToken,
        requestId,
      });
    }
  }
}

module.exports = new BookingLockService();
