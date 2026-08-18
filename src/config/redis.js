"use strict";

const Redis = require("ioredis");
const logger = require("../logger/logger");

const REDIS_HOST = process.env.REDIS_HOST || "127.0.0.1";

const REDIS_PORT = Number(process.env.REDIS_PORT) || 6379;

const REDIS_PASSWORD = process.env.REDIS_PASSWORD || undefined;

const REDIS_DB = Number(process.env.REDIS_DB) || 0;

const CONNECT_TIMEOUT_MS = Math.max(1000, Number(process.env.REDIS_CONNECT_TIMEOUT_MS) || 5000);

logger.info(
  {
    host: REDIS_HOST,
    port: REDIS_PORT,
    db: REDIS_DB,
    event: "REDIS_INITIALIZING",
  },
  "Initializing application Redis connection",
);

const redis = new Redis({
  host: REDIS_HOST,
  port: REDIS_PORT,
  password: REDIS_PASSWORD,
  db: REDIS_DB,

  /**
   * RedisService explicitly waits for readiness.
   */
  lazyConnect: true,

  enableReadyCheck: false,

  /**
   * Request-path commands must not silently accumulate while
   * Redis is unavailable.
   */
  enableOfflineQueue: false,

  /**
   * IMPORTANT:
   *
   * Unlike BullMQ, application/booking lock commands should
   * fail in bounded time.
   */
  maxRetriesPerRequest: 1,

  connectTimeout: CONNECT_TIMEOUT_MS,

  keepAlive: 30000,

  /**
   * Reconnect the underlying connection in the background.
   *
   * Individual API commands are still bounded by
   * maxRetriesPerRequest.
   */
  retryStrategy(times) {
    const delay = Math.min(100 * 2 ** Math.min(times - 1, 5), 3000);

    if (times === 1 || times % 10 === 0) {
      logger.warn(
        {
          retries: times,
          delay,
          event: "REDIS_RECONNECTING",
        },
        "Application Redis reconnecting",
      );
    }

    return delay;
  },
});

/**
 * ============================================================
 * EVENTS
 * ============================================================
 */

redis.on("connect", () => {
  logger.info(
    {
      event: "REDIS_CONNECTED",
    },
    "Application Redis connected",
  );
});

redis.on("ready", () => {
  logger.info(
    {
      event: "REDIS_READY",
    },
    "Application Redis ready",
  );
});

redis.on("reconnecting", (delay) => {
  logger.warn(
    {
      delay,
      event: "REDIS_RECONNECTING",
    },
    "Application Redis reconnecting",
  );
});

redis.on("close", () => {
  logger.warn(
    {
      event: "REDIS_CLOSED",
    },
    "Application Redis connection closed",
  );
});

redis.on("end", () => {
  logger.warn(
    {
      event: "REDIS_ENDED",
    },
    "Application Redis connection ended",
  );
});

redis.on("error", (error) => {
  logger.error(
    {
      err: error,
      event: "REDIS_ERROR",
    },
    "Application Redis error",
  );
});

/**
 * ============================================================
 * STARTUP
 * ============================================================
 */

async function connectRedis() {
  try {
    if (redis.status === "wait") {
      await redis.connect();
    }

    const pong = await redis.ping();

    if (pong !== "PONG") {
      throw new Error(`Unexpected Redis PING response: ${pong}`);
    }

    logger.info(
      {
        event: "REDIS_STARTUP_SUCCESS",
      },
      "Application Redis connection established successfully",
    );
  } catch (error) {
    logger.fatal(
      {
        err: error,
        event: "REDIS_STARTUP_FAILED",
      },
      "Unable to connect to application Redis",
    );

    /**
     * Your booking concurrency currently depends on Redis.
     *
     * MongoDB uniqueness remains the final integrity boundary,
     * but failing startup here avoids running the application
     * in an unexpectedly degraded state.
     */
    process.exit(1);
  }
}

connectRedis();

module.exports = redis;
