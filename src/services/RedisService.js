"use strict";

const crypto = require("crypto");

const redis = require("../config/redis");

const { RedisLogger } = require("../logger/index");

/**
 * RedisService
 *
 * Shared Redis utility layer.
 *
 * Responsibilities:
 * - Provide bounded access to the Redis client
 * - Generate lock ownership tokens
 * - Acquire distributed locks atomically
 * - Renew locks only when ownership matches
 * - Release locks only when ownership matches
 * - Inspect lock TTL / ownership
 * - Explicit administrative force-release
 * - Redis health checks
 * - Graceful shutdown
 *
 * IMPORTANT:
 *
 * Redis locks are concurrency guards only.
 * MongoDB remains the source of truth.
 *
 * Distributed lock lifecycle:
 *
 * acquire:
 *   SET key token NX EX ttl
 *
 * renew:
 *   if GET key == token
 *      EXPIRE key ttl
 *
 * release:
 *   if GET key == token
 *      DEL key
 *
 * Token validation prevents one request from accidentally
 * renewing or releasing another request's lock.
 */
class RedisService {
  constructor() {
    /**
     * Maximum time an application request should wait for
     * Redis to become ready.
     *
     * This prevents booking/API requests from hanging
     * indefinitely during Redis outages.
     */
    this.CLIENT_READY_TIMEOUT_MS = Math.max(
      1000,
      Number(process.env.REDIS_READY_TIMEOUT_MS) || 5000,
    );
  }

  /**
   * ==========================================================
   * CLIENT ACCESS
   * ==========================================================
   */

  /**
   * Return the Redis client once it is ready.
   *
   * If Redis is reconnecting, wait for it for a bounded amount
   * of time.
   *
   * Listener cleanup is important here because getClient()
   * can be called many times while Redis is unavailable.
   */
  async getClient() {
    if (redis.status === "ready") {
      return redis;
    }

    /**
     * If the client has been permanently closed through quit(),
     * waiting for "ready" would never succeed.
     */
    if (redis.status === "end") {
      throw new Error("Redis connection has ended");
    }

    await new Promise((resolve, reject) => {
      let settled = false;

      let timeout = null;

      const cleanup = () => {
        if (timeout) {
          clearTimeout(timeout);
          timeout = null;
        }

        redis.removeListener("ready", onReady);
        redis.removeListener("error", onError);
        redis.removeListener("end", onEnd);
      };

      const resolveOnce = () => {
        if (settled) {
          return;
        }

        settled = true;

        cleanup();

        resolve();
      };

      const rejectOnce = (error) => {
        if (settled) {
          return;
        }

        settled = true;

        cleanup();

        reject(error);
      };

      const onReady = () => {
        resolveOnce();
      };

      const onError = (error) => {
        rejectOnce(error);
      };

      const onEnd = () => {
        rejectOnce(new Error("Redis connection ended before becoming ready"));
      };

      timeout = setTimeout(() => {
        rejectOnce(new Error(`Redis connection timeout after ${this.CLIENT_READY_TIMEOUT_MS}ms`));
      }, this.CLIENT_READY_TIMEOUT_MS);

      redis.once("ready", onReady);
      redis.once("error", onError);
      redis.once("end", onEnd);

      /**
       * Avoid a race where Redis becomes ready between the
       * initial status check and listener registration.
       */
      if (redis.status === "ready") {
        resolveOnce();
      }

      if (redis.status === "end") {
        rejectOnce(new Error("Redis connection has ended"));
      }
    });

    return redis;
  }

  /**
   * ==========================================================
   * VALIDATION
   * ==========================================================
   */

  validateLockKey(key) {
    if (typeof key !== "string" || key.trim().length === 0) {
      throw new Error("Redis lock key is required");
    }

    return key.trim();
  }

  validateLockToken(token) {
    if (typeof token !== "string" || token.length === 0) {
      throw new Error("Redis lock token is required");
    }

    return token;
  }

  validateTTL(ttl) {
    const normalizedTTL = Number(ttl);

    if (!Number.isInteger(normalizedTTL) || normalizedTTL <= 0) {
      throw new Error("Redis lock TTL must be a positive integer");
    }

    return normalizedTTL;
  }

  /**
   * ==========================================================
   * TOKEN GENERATION
   * ==========================================================
   */

  /**
   * Generate a globally unique ownership token.
   *
   * process.pid is useful for debugging.
   * Date.now() provides temporal context.
   * randomUUID() provides uniqueness.
   */
  generateLockToken() {
    return [process.pid, Date.now(), crypto.randomUUID()].join("-");
  }

  /**
   * ==========================================================
   * ACQUIRE LOCK
   * ==========================================================
   */

  /**
   * Atomically acquire a distributed lock.
   *
   * Redis command:
   *
   * SET key token NX EX ttl
   *
   * NX:
   * Only set if the key does not already exist.
   *
   * EX:
   * Automatically expire the lock after TTL seconds.
   *
   * Returns:
   *
   * lockToken  -> lock acquired
   * null       -> lock already held
   */
  async acquireLock(key, ttl, token = null) {
    const lockKey = this.validateLockKey(key);

    const normalizedTTL = this.validateTTL(ttl);

    const lockToken = token ? this.validateLockToken(token) : this.generateLockToken();

    const client = await this.getClient();

    const result = await client.set(lockKey, lockToken, "EX", normalizedTTL, "NX");

    if (result === "OK") {
      return lockToken;
    }

    return null;
  }

  /**
   * ==========================================================
   * RENEW LOCK
   * ==========================================================
   */

  /**
   * Extend a lock's TTL only when the supplied token still
   * owns the lock.
   *
   * This must remain atomic.
   *
   * Never perform:
   *
   * GET key
   * EXPIRE key ttl
   *
   * as separate commands because ownership could change
   * between those commands.
   */
  async renewLock(key, ttl, token) {
    const lockKey = this.validateLockKey(key);

    const lockToken = this.validateLockToken(token);

    const normalizedTTL = this.validateTTL(ttl);

    const client = await this.getClient();

    const lua = `
if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("expire", KEYS[1], ARGV[2])
end

return 0
`;

    const result = await client.eval(lua, 1, lockKey, lockToken, String(normalizedTTL));

    return Number(result) === 1;
  }

  /**
   * ==========================================================
   * RELEASE LOCK
   * ==========================================================
   */

  /**
   * Release a lock ONLY if the supplied token still owns it.
   *
   * Tokenless deletion is intentionally forbidden.
   *
   * Why:
   *
   * Request A acquires lock
   *      ↓
   * lock expires
   *      ↓
   * Request B acquires same lock
   *      ↓
   * Request A finishes late
   *      ↓
   * Request A tries to release
   *
   * Without ownership checking, Request A could delete
   * Request B's lock.
   *
   * Lua keeps GET + DEL atomic.
   */
  async releaseLock(key, token) {
    const lockKey = this.validateLockKey(key);

    const lockToken = this.validateLockToken(token);

    const client = await this.getClient();

    const lua = `
if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
end

return 0
`;

    const result = await client.eval(lua, 1, lockKey, lockToken);

    return Number(result) === 1;
  }

  /**
   * ==========================================================
   * LOCK TTL
   * ==========================================================
   */

  /**
   * Return TTL only if the supplied token owns the lock.
   *
   * Possible results:
   *
   * >= 0
   *   remaining TTL in seconds
   *
   * -1
   *   lock exists but has no expiration
   *
   * -2
   *   key does not exist OR caller does not own the lock
   */
  async getLockTTL(key, token) {
    const lockKey = this.validateLockKey(key);

    const lockToken = this.validateLockToken(token);

    const client = await this.getClient();

    const lua = `
if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("ttl", KEYS[1])
end

return -2
`;

    const result = await client.eval(lua, 1, lockKey, lockToken);

    return Number(result);
  }

  /**
   * ==========================================================
   * LOCK OWNER
   * ==========================================================
   */

  /**
   * Return the current ownership token.
   *
   * Intended primarily for diagnostics.
   *
   * Avoid exposing this through public APIs.
   */
  async getLockOwner(key) {
    const lockKey = this.validateLockKey(key);

    const client = await this.getClient();

    return client.get(lockKey);
  }

  /**
   * ==========================================================
   * FORCE RELEASE
   * ==========================================================
   */

  /**
   * Administrative/recovery operation.
   *
   * WARNING:
   *
   * This deliberately bypasses ownership validation.
   *
   * Do NOT use this in normal request processing.
   *
   * Normal application code must use:
   *
   * releaseLock(key, token)
   */
  async forceReleaseLock(key) {
    const lockKey = this.validateLockKey(key);

    const client = await this.getClient();

    const deleted = await client.del(lockKey);

    if (Number(deleted) === 1) {
      RedisLogger.warn(
        {
          event: "REDIS_LOCK_FORCE_RELEASED",
          lockKey,
        },
        "Redis lock force released",
      );

      return true;
    }

    return false;
  }

  /**
   * ==========================================================
   * HEALTH CHECK
   * ==========================================================
   */

  async ping() {
    try {
      const client = await this.getClient();

      const result = await client.ping();

      return result === "PONG";
    } catch (error) {
      RedisLogger.error(
        {
          err: error,
          event: "REDIS_PING_FAILED",
        },
        "Redis health check failed",
      );

      return false;
    }
  }

  /**
   * ==========================================================
   * GRACEFUL SHUTDOWN
   * ==========================================================
   */

  async close() {
    try {
      /**
       * Already closed.
       */
      if (redis.status === "end") {
        return true;
      }

      /**
       * quit() allows pending commands to complete before
       * closing the connection.
       */
      await redis.quit();

      RedisLogger.info(
        {
          event: "REDIS_CLOSED",
        },
        "Redis connection closed gracefully",
      );

      return true;
    } catch (error) {
      RedisLogger.error(
        {
          err: error,
          event: "REDIS_CLOSE_ERROR",
        },
        "Redis graceful shutdown failed",
      );

      /**
       * disconnect() is the fallback when graceful quit fails.
       */
      try {
        redis.disconnect();

        RedisLogger.warn(
          {
            event: "REDIS_FORCE_DISCONNECTED",
          },
          "Redis connection force disconnected",
        );
      } catch (disconnectError) {
        RedisLogger.error(
          {
            err: disconnectError,
            event: "REDIS_FORCE_DISCONNECT_FAILED",
          },
          "Redis force disconnect failed",
        );
      }

      return false;
    }
  }
}

module.exports = new RedisService();
