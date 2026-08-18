"use strict";

const zlib = require("zlib");
const { promisify } = require("util");

const RedisService = require("./RedisService");
const { CacheLogger } = require("../logger/index");
const gzipAsync = promisify(zlib.gzip);
const gunzipAsync = promisify(zlib.gunzip);
let brotliCompressAsync = null;
let brotliDecompressAsync = null;

try {
  const brotli = require("brotli");
  brotliCompressAsync = promisify(brotli.compress);
  brotliDecompressAsync = promisify(brotli.decompress);
} catch (error) {
  CacheLogger.warn(
    {
      event: "BROTLI_UNAVAILABLE",
      error: error.message,
      component: "CacheService",
    },
    "Brotli compression not available, falling back to gzip",
  );
}

/**
 * CacheService - Enterprise-grade caching layer for the entire application
 *
 * Implements a robust caching system with graceful fallbacks, comprehensive metrics,
 * and enterprise-grade error handling. All application caching must go through this service.
 *
 * @class CacheService
 */
class CacheService {
  /**
   * Default configuration
   * @static
   * @readonly
   */
  static CONFIG = {
    DEFAULT_TTL: 300,
    MAX_TTL: 604800,
    MIN_TTL: 1,
    COMPRESSION_THRESHOLD: 10240, // 10KB
    COMPRESSION_MIN_RATIO: 0.8,
    COUNTER_TTL: 86400,
    MAX_BATCH_SIZE: 1000,
    SCAN_COUNT: 100,
    CACHE_VERSION: "v1",
    CACHE_NAMESPACE: process.env.NODE_ENV || "development",
    ENABLE_COMPRESSION: true,
    ENABLE_STALE_WHILE_REVALIDATE: false,
    STALE_REVALIDATE_TTL: 60,
    HEALTH_CACHE_TTL: 60,
    LOCK_TIMEOUT: 10000,
    LOCK_RETRY_DELAY: 100,
    LOCK_BACKOFF_FACTOR: 1.5,
    LOCK_MAX_WAIT: 30000,
    RETRY_COUNT: 3,
    RETRY_DELAY: 100,
    RETRY_BACKOFF_FACTOR: 2,
    TTL_JITTER_PERCENT: 10,
    ENABLE_TTL_JITTER: true,
    ENABLE_DISTRIBUTED_COALESCING: true,
    PENDING_REQUEST_TIMEOUT: 30000,
    MAX_PENDING_REQUESTS: 1000,
    MAX_SERIALIZED_SIZE: 10485760, // 10MB
    ENABLE_CACHE_TAGS: true,
    MAX_TAG_COUNT: 100,
    UNLINK_ENABLED: true,
    BROTLI_ENABLED: true,
    PIPELINE_BATCH_SIZE: 100,
    MAX_RETRY_QUEUE_SIZE: 10000,
    RETRY_QUEUE_PROCESS_INTERVAL: 1000,
    ENABLE_METRICS_TRACKING: true,
  };

  /**
   * Create CacheService instance
   * @constructor
   */
  constructor() {
    this.redis = null;
    this.pendingRequests = new Map();
    this.staleCache = new Map();
    this.tagCache = new Map();
    this.healthCache = {
      data: null,
      expiresAt: null,
    };
    this.retryQueue = [];
    this._compressionBuffer = Buffer.allocUnsafe(0);
    this._customSerializers = new Map();
    this._unlinkSupported = null;
    this._retryTimer = null;
    this._shuttingDown = false;

    this.metrics = {
      cacheHits: 0,
      cacheMisses: 0,
      cacheSets: 0,
      cacheDeletes: 0,
      cacheErrors: 0,
      rememberHits: 0,
      rememberMisses: 0,
      fallbackExecutions: 0,
      compressionCount: 0,
      decompressionCount: 0,
      staleServed: 0,
      backgroundRefreshes: 0,
      pendingRequests: 0,
      averageLatency: 0,
      totalLatency: 0,
      totalOperations: 0,
      hitRatio: 0,
      lastError: null,
      startTime: Date.now(),
      cacheWriteRetries: 0,
      cacheRetryFailures: 0,
      distributedLockSuccess: 0,
      distributedLockFailure: 0,
      distributedLockTimeout: 0,
      staleResponses: 0,
      backgroundRefreshSuccess: 0,
      backgroundRefreshFailure: 0,
      compressionSavings: 0,
      averageCompressionRatio: 0,
      pipelineOperations: 0,
      serializationFailures: 0,
      deserializationFailures: 0,
      cacheWriteSuccesses: 0,
      cacheWriteFailures: 0,
    };

    this.healthStatus = {
      status: "unknown",
      latency: 0,
      lastCheck: null,
      memory: null,
      connectedClients: 0,
      redisVersion: null,
    };

    this._initialized = false;
    this._initPromise = null;
    this._lockCounter = 0;

    this._startRetryProcessor();

    CacheLogger.info(
      {
        event: "CACHE_SERVICE_INITIALIZED",
        namespace: CacheService.CONFIG.CACHE_NAMESPACE,
        version: CacheService.CONFIG.CACHE_VERSION,
        compressionThreshold: CacheService.CONFIG.COMPRESSION_THRESHOLD,
        ttlJitterPercent: CacheService.CONFIG.TTL_JITTER_PERCENT,
        component: "CacheService",
      },
      "CacheService initialized successfully",
    );
  }

  /**
   * Get Redis client instance with proper async handling
   * @private
   * @returns {Promise<Object>} Redis client
   */
  async _getRedisClient() {
    if (this.redis) {
      return this.redis;
    }

    if (this._initPromise) {
      return this._initPromise;
    }

    this._initPromise = (async () => {
      try {
        this.redis = await RedisService.getClient();
        this._initialized = true;
        this._unlinkSupported = await this._checkUnlinkSupport();
        CacheLogger.info(
          {
            event: "REDIS_CLIENT_ACQUIRED",
            unlinkSupported: this._unlinkSupported,
            component: "CacheService",
          },
          "Redis client acquired successfully",
        );
        return this.redis;
      } catch (error) {
        CacheLogger.error(
          {
            event: "REDIS_CLIENT_ERROR",
            error: error.message,
            stack: error.stack,
            component: "CacheService",
          },
          "Failed to acquire Redis client",
        );
        throw error;
      } finally {
        this._initPromise = null;
      }
    })();

    return this._initPromise;
  }

  /**
   * Check if UNLINK is supported by Redis
   * @private
   * @returns {Promise<boolean>} True if UNLINK is supported
   */
  async _checkUnlinkSupport() {
    try {
      const redis = await this._getRedisClient();
      const version = await redis.info("server");
      const match = version.match(/redis_version:(\d+\.\d+\.\d+)/);
      if (match) {
        const [major, minor] = match[1].split(".").map(Number);
        return major > 4 || (major === 4 && minor >= 0);
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Build cache key with namespace and version
   * @private
   * @param {string} key - Original cache key
   * @returns {string} Fully qualified cache key
   */
  _buildKey(key) {
    const { CACHE_NAMESPACE, CACHE_VERSION } = CacheService.CONFIG;
    return `${CACHE_NAMESPACE}:${CACHE_VERSION}:${key}`;
  }

  /**
   * Apply TTL jitter to prevent cache stampede
   * @private
   * @param {number} ttl - Original TTL in seconds
   * @returns {number} TTL with jitter applied
   */
  _applyJitter(ttl) {
    if (!CacheService.CONFIG.ENABLE_TTL_JITTER || ttl <= 0) {
      return ttl;
    }

    const jitterPercent = CacheService.CONFIG.TTL_JITTER_PERCENT;
    const jitterRange = Math.floor(ttl * (jitterPercent / 100));
    const jitter = Math.floor(Math.random() * jitterRange * 2) - jitterRange;
    const result = ttl + jitter;

    return Math.min(Math.max(result, CacheService.CONFIG.MIN_TTL), CacheService.CONFIG.MAX_TTL);
  }

  /**
   * Build cache tags key
   * @private
   * @param {string} tag - Tag name
   * @returns {string} Tag key
   */
  _buildTagKey(tag) {
    return `${CacheService.CONFIG.CACHE_NAMESPACE}:tags:${tag}`;
  }

  /**
   * Start retry queue processor
   * @private
   */
  _startRetryProcessor() {
    this._retryTimer = setInterval(async () => {
      if (this._shuttingDown || this.retryQueue.length === 0) {
        return;
      }

      const batch = this.retryQueue.splice(0, 100);
      for (const item of batch) {
        try {
          const redis = await this._getRedisClient();
          const { fullKey, serialized, ttl, attempt, maxAttempts } = item;

          await redis.set(fullKey, serialized, "EX", ttl);
          this.metrics.cacheWriteSuccesses++;

          CacheLogger.debug(
            {
              event: "CACHE_RETRY_SUCCESS",
              key: item.key,
              attempt: attempt + 1,
              component: "CacheService",
            },
            "Cache retry successful",
          );
        } catch (error) {
          const itemWithUpdatedAttempt = {
            ...item,
            attempt: item.attempt + 1,
          };

          if (item.attempt < item.maxAttempts) {
            const delay =
              CacheService.CONFIG.RETRY_DELAY *
              Math.pow(CacheService.CONFIG.RETRY_BACKOFF_FACTOR, item.attempt);

            setTimeout(() => {
              if (!this._shuttingDown) {
                this.retryQueue.push(itemWithUpdatedAttempt);
              }
            }, delay);

            this.metrics.cacheWriteRetries++;
          } else {
            this.metrics.cacheWriteFailures++;
            this.metrics.cacheRetryFailures++;

            CacheLogger.error(
              {
                event: "CACHE_RETRY_FAILED",
                key: item.key,
                attempts: maxAttempts,
                error: error.message,
                component: "CacheService",
              },
              "Cache retry failed permanently",
            );
          }
        }
      }
    }, CacheService.CONFIG.RETRY_QUEUE_PROCESS_INTERVAL);
  }

  /**
   * Queue a retry for cache write
   * @private
   */
  _queueRetry(key, fullKey, serialized, ttl, maxAttempts = CacheService.CONFIG.RETRY_COUNT) {
    if (this.retryQueue.length >= CacheService.CONFIG.MAX_RETRY_QUEUE_SIZE) {
      CacheLogger.warn(
        {
          event: "CACHE_RETRY_QUEUE_FULL",
          size: this.retryQueue.length,
          component: "CacheService",
        },
        "Retry queue is full, dropping retry",
      );
      return;
    }

    this.retryQueue.push({
      key,
      fullKey,
      serialized,
      ttl,
      attempt: 0,
      maxAttempts,
    });
  }

  /**
   * Validate cache key format
   * @private
   * @param {string} key - Cache key to validate
   * @returns {boolean} True if valid
   * @throws {Error} If key is invalid
   */
  validateKey(key) {
    if (!key || typeof key !== "string") {
      throw new Error("Cache key must be a non-empty string");
    }

    if (key.length > 512) {
      throw new Error("Cache key exceeds maximum length of 512 characters");
    }

    if (/[\n\r\t]/.test(key)) {
      throw new Error("Cache key contains invalid characters");
    }

    if (key.startsWith("_") || key.includes("*") || key.includes("?")) {
      throw new Error("Cache key contains reserved characters");
    }

    return true;
  }

  /**
   * Validate and normalize TTL
   * @private
   * @param {number|string} ttl - Time to live in seconds
   * @param {number} defaultTTL - Default TTL if not provided
   * @returns {number} Validated and normalized TTL
   * @throws {Error} If TTL is invalid
   */
  validateTTL(ttl = null, defaultTTL = CacheService.CONFIG.DEFAULT_TTL) {
    let normalizedTTL = defaultTTL;

    if (ttl !== null && ttl !== undefined) {
      const parsedTTL = typeof ttl === "string" ? parseInt(ttl, 10) : ttl;

      if (isNaN(parsedTTL) || parsedTTL < 0) {
        throw new Error(`Invalid TTL: ${ttl}. TTL must be a positive number`);
      }

      if (parsedTTL > 0) {
        normalizedTTL = Math.min(parsedTTL, CacheService.CONFIG.MAX_TTL);
        normalizedTTL = Math.max(normalizedTTL, CacheService.CONFIG.MIN_TTL);
      } else {
        normalizedTTL = CacheService.CONFIG.MAX_TTL;
      }
    }

    normalizedTTL = Math.floor(normalizedTTL);
    return this._applyJitter(normalizedTTL);
  }

  /**
   * Validate object for serialization
   * @private
   * @param {any} value - Value to validate
   * @param {number} maxSize - Maximum allowed serialized size
   * @returns {boolean} True if valid
   * @throws {Error} If value is invalid
   */
  validateObject(value, maxSize = CacheService.CONFIG.MAX_SERIALIZED_SIZE) {
    if (value === null || value === undefined) {
      return true;
    }

    try {
      const seen = new WeakSet();
      const detectCircular = (obj) => {
        if (obj && typeof obj === "object") {
          if (seen.has(obj)) {
            throw new Error("Circular reference detected");
          }
          seen.add(obj);
          for (const key in obj) {
            if (obj.hasOwnProperty(key)) {
              detectCircular(obj[key]);
            }
          }
        }
      };
      detectCircular(value);

      const serialized = JSON.stringify(value);
      if (serialized.length > maxSize) {
        throw new Error(
          `Object exceeds maximum serialized size: ${serialized.length} > ${maxSize}`,
        );
      }

      return true;
    } catch (error) {
      throw new Error(`Object validation failed: ${error.message}`);
    }
  }

  /**
   * Register custom serializer
   * @param {string} type - Type identifier
   * @param {Function} serializer - Serializer function
   * @param {Function} deserializer - Deserializer function
   */
  registerSerializer(type, serializer, deserializer) {
    if (typeof serializer !== "function" || typeof deserializer !== "function") {
      throw new Error("Serializer and deserializer must be functions");
    }
    this._customSerializers.set(type, { serializer, deserializer });
  }

  /**
   * Serialize value with compression and type handling
   * @private
   * @param {any} value - Value to serialize
   * @param {Array<string>} [tags] - Optional tags
   * @returns {Promise<string>} Serialized data
   */
  async serialize(value, tags = null) {
    if (value === null || value === undefined) {
      return "null";
    }

    let serialized;
    const type = value.constructor?.name || typeof value;

    // Check custom serializers first
    if (this._customSerializers.has(type)) {
      try {
        const { serializer } = this._customSerializers.get(type);
        const result = await serializer(value);
        return JSON.stringify({
          __type: `custom:${type}`,
          value: result,
        });
      } catch (error) {
        CacheLogger.warn(
          {
            event: "CUSTOM_SERIALIZER_FAILED",
            type,
            error: error.message,
            component: "CacheService",
          },
          "Custom serializer failed, falling back to default",
        );
      }
    }

    // Handle special types
    if (value instanceof Date) {
      return JSON.stringify({
        __type: "Date",
        value: value.toISOString(),
      });
    }

    if (value instanceof Buffer || Buffer.isBuffer(value)) {
      return JSON.stringify({
        __type: "Buffer",
        value: value.toString("base64"),
      });
    }

    if (value instanceof ArrayBuffer) {
      const buffer = Buffer.from(value);
      return JSON.stringify({
        __type: "ArrayBuffer",
        value: buffer.toString("base64"),
      });
    }

    if (ArrayBuffer.isView(value)) {
      const buffer = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      return JSON.stringify({
        __type: "TypedArray",
        value: buffer.toString("base64"),
        constructor: value.constructor.name,
        byteLength: value.byteLength,
      });
    }

    if (value instanceof Map) {
      const obj = {};
      for (const [k, v] of value) {
        obj[k] = await this.serialize(v);
      }
      return JSON.stringify({
        __type: "Map",
        value: obj,
      });
    }

    if (value instanceof Set) {
      const arr = await Promise.all(Array.from(value).map((v) => this.serialize(v)));
      return JSON.stringify({
        __type: "Set",
        value: arr,
      });
    }

    if (value instanceof RegExp) {
      return JSON.stringify({
        __type: "RegExp",
        pattern: value.source,
        flags: value.flags,
      });
    }

    if (value instanceof Error) {
      return JSON.stringify({
        __type: "Error",
        name: value.name,
        message: value.message,
        stack: value.stack,
      });
    }

    if (value instanceof URL) {
      return JSON.stringify({
        __type: "URL",
        href: value.href,
      });
    }

    if (typeof value === "bigint") {
      return JSON.stringify({
        __type: "BigInt",
        value: value.toString(),
      });
    }

    try {
      serialized = JSON.stringify(value);
    } catch (error) {
      this.metrics.serializationFailures++;
      throw new Error(`Serialization failed: ${error.message}`);
    }

    // Check if compression is needed
    const shouldCompress =
      CacheService.CONFIG.ENABLE_COMPRESSION &&
      serialized.length > CacheService.CONFIG.COMPRESSION_THRESHOLD &&
      !this._isAlreadyCompressed(serialized);

    if (shouldCompress) {
      try {
        const buffer = Buffer.from(serialized, "utf8");
        let compressed;
        let algorithm = "gzip";
        const startTime = Date.now();

        // Try Brotli first if available
        if (CacheService.CONFIG.BROTLI_ENABLED && brotliCompressAsync) {
          try {
            compressed = await brotliCompressAsync(buffer, {
              quality: 6,
              lgwin: 22,
            });
            algorithm = "brotli";
          } catch (error) {
            CacheLogger.debug(
              {
                event: "BROTLI_COMPRESS_FAILED",
                error: error.message,
                component: "CacheService",
              },
              "Brotli compression failed, falling back to gzip",
            );
            compressed = await gzipAsync(buffer, { level: 6 });
          }
        } else {
          compressed = await gzipAsync(buffer, { level: 6 });
        }

        const ratio = compressed.length / serialized.length;
        const compressionTime = Date.now() - startTime;

        if (ratio < CacheService.CONFIG.COMPRESSION_MIN_RATIO) {
          this.metrics.compressionCount++;
          this.metrics.compressionSavings += serialized.length - compressed.length;
          this.metrics.averageCompressionRatio =
            (this.metrics.averageCompressionRatio * (this.metrics.compressionCount - 1) + ratio) /
            this.metrics.compressionCount;

          const result = JSON.stringify({
            __compressed: true,
            __encoding: algorithm,
            __length: serialized.length,
            __data: compressed.toString("base64"),
          });

          CacheLogger.debug(
            {
              event: "CACHE_COMPRESS",
              algorithm,
              originalSize: serialized.length,
              compressedSize: compressed.length,
              ratio: (ratio * 100).toFixed(2) + "%",
              time: compressionTime + "ms",
              component: "CacheService",
            },
            "Cache value compressed",
          );

          return result;
        }

        CacheLogger.debug(
          {
            event: "CACHE_COMPRESS_SKIPPED",
            originalSize: serialized.length,
            compressedSize: compressed.length,
            ratio: (ratio * 100).toFixed(2) + "%",
            reason: "Savings insufficient",
            component: "CacheService",
          },
          "Compression skipped",
        );

        return serialized;
      } catch (error) {
        CacheLogger.warn(
          {
            event: "CACHE_COMPRESS_FAILED",
            error: error.message,
            component: "CacheService",
          },
          "Compression failed, storing uncompressed",
        );
        return serialized;
      }
    }

    return serialized;
  }

  /**
   * Check if data is already compressed
   * @private
   */
  _isAlreadyCompressed(data) {
    const magicBytes = {
      gzip: [0x1f, 0x8b],
      zlib: [0x78, 0x9c],
      brotli: [0x62, 0x72, 0x6f, 0x74, 0x6c, 0x69],
    };

    const buffer = Buffer.from(data, "utf8");
    for (const [format, bytes] of Object.entries(magicBytes)) {
      if (bytes.every((b, i) => buffer[i] === b)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Deserialize value with decompression and type handling
   * @private
   * @param {string|null} data - Serialized JSON string
   * @returns {Promise<any>} Deserialized value
   */
  async deserialize(data) {
    if (data === null || data === undefined) {
      return null;
    }

    if (typeof data !== "string") {
      return data;
    }

    try {
      let parsed = JSON.parse(data);

      // Check for compressed data
      if (parsed && typeof parsed === "object" && parsed.__compressed) {
        try {
          const buffer = Buffer.from(parsed.__data, "base64");
          let decompressed;
          const startTime = Date.now();

          if (parsed.__encoding === "brotli" && brotliDecompressAsync) {
            try {
              decompressed = await brotliDecompressAsync(buffer);
            } catch (error) {
              CacheLogger.debug(
                {
                  event: "BROTLI_DECOMPRESS_FAILED",
                  error: error.message,
                  component: "CacheService",
                },
                "Brotli decompression failed, falling back to gzip",
              );
              decompressed = await gunzipAsync(buffer);
            }
          } else {
            decompressed = await gunzipAsync(buffer);
          }

          this.metrics.decompressionCount++;

          CacheLogger.debug(
            {
              event: "CACHE_DECOMPRESS",
              algorithm: parsed.__encoding || "gzip",
              originalSize: parsed.__length,
              compressedSize: buffer.length,
              time: Date.now() - startTime + "ms",
              component: "CacheService",
            },
            "Cache value decompressed",
          );

          parsed = JSON.parse(decompressed.toString("utf8"));
        } catch (error) {
          this.metrics.deserializationFailures++;
          CacheLogger.error(
            {
              event: "CACHE_DECOMPRESS_FAILED",
              error: error.message,
              component: "CacheService",
            },
            "Decompression failed",
          );
          return null;
        }
      }

      // Handle special types
      if (parsed && typeof parsed === "object") {
        // Check custom deserializers
        if (parsed.__type && parsed.__type.startsWith("custom:")) {
          const type = parsed.__type.replace("custom:", "");
          if (this._customSerializers.has(type)) {
            try {
              const { deserializer } = this._customSerializers.get(type);
              return await deserializer(parsed.value);
            } catch (error) {
              CacheLogger.warn(
                {
                  event: "CUSTOM_DESERIALIZER_FAILED",
                  type,
                  error: error.message,
                  component: "CacheService",
                },
                "Custom deserializer failed, falling back to default",
              );
            }
          }
        }

        if (parsed.__type === "Date") {
          return new Date(parsed.value);
        }
        if (parsed.__type === "Buffer") {
          return Buffer.from(parsed.value, "base64");
        }
        if (parsed.__type === "ArrayBuffer") {
          const buffer = Buffer.from(parsed.value, "base64");
          return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
        }
        if (parsed.__type === "TypedArray") {
          const buffer = Buffer.from(parsed.value, "base64");
          const constructor = global[parsed.constructor];
          if (constructor && typeof constructor === "function") {
            return new constructor(buffer.buffer, buffer.byteOffset, buffer.length);
          }
          return buffer;
        }
        if (parsed.__type === "Map") {
          const map = new Map();
          for (const [k, v] of Object.entries(parsed.value)) {
            map.set(k, await this.deserialize(v));
          }
          return map;
        }
        if (parsed.__type === "Set") {
          const set = new Set();
          for (const v of parsed.value) {
            set.add(await this.deserialize(v));
          }
          return set;
        }
        if (parsed.__type === "RegExp") {
          return new RegExp(parsed.pattern, parsed.flags);
        }
        if (parsed.__type === "Error") {
          const error = new Error(parsed.message);
          error.name = parsed.name;
          error.stack = parsed.stack;
          return error;
        }
        if (parsed.__type === "URL") {
          return new URL(parsed.href);
        }
        if (parsed.__type === "BigInt") {
          return BigInt(parsed.value);
        }
      }

      return parsed;
    } catch (error) {
      this.metrics.deserializationFailures++;
      CacheLogger.warn(
        {
          event: "CACHE_DESERIALIZE_FAILED",
          error: error.message,
          component: "CacheService",
        },
        "Deserialization failed, returning raw data",
      );
      return data;
    }
  }

  /**
   * Associate tags with a cache key
   * @private
   * @param {string} key - Cache key
   * @param {Array<string>} tags - Tags to associate
   * @returns {Promise<void>}
   */
  async _associateTags(key, tags) {
    if (!CacheService.CONFIG.ENABLE_CACHE_TAGS || !tags || tags.length === 0) {
      return;
    }

    if (tags.length > CacheService.CONFIG.MAX_TAG_COUNT) {
      CacheLogger.warn(
        {
          event: "CACHE_TAG_LIMIT_EXCEEDED",
          count: tags.length,
          max: CacheService.CONFIG.MAX_TAG_COUNT,
          component: "CacheService",
        },
        "Tag limit exceeded",
      );
      tags = tags.slice(0, CacheService.CONFIG.MAX_TAG_COUNT);
    }

    try {
      const redis = await this._getRedisClient();
      const pipeline = redis.pipeline();

      for (const tag of tags) {
        const tagKey = this._buildTagKey(tag);
        pipeline.sadd(tagKey, key);
        pipeline.expire(tagKey, CacheService.CONFIG.DEFAULT_TTL * 2);
      }

      await pipeline.exec();
    } catch (error) {
      CacheLogger.error(
        {
          event: "CACHE_TAG_ERROR",
          error: error.message,
          tags: tags.slice(0, 5),
          component: "CacheService",
        },
        "Failed to associate tags",
      );
    }
  }

  /**
   * Get value from cache
   * @param {string} key - Cache key
   * @returns {Promise<any>} Cached value or null if not found
   */
  async get(key) {
    const startTime = Date.now();
    try {
      this.validateKey(key);
      const fullKey = this._buildKey(key);
      this.metrics.totalOperations++;

      const redis = await this._getRedisClient();
      const data = await redis.get(fullKey);

      if (data === null) {
        this.metrics.cacheMisses++;
        this._updateMetrics(startTime);
        CacheLogger.debug(
          {
            event: "CACHE_MISS",
            key,
            fullKey,
            component: "CacheService",
          },
          "Cache miss",
        );
        return null;
      }

      this.metrics.cacheHits++;
      const value = await this.deserialize(data);
      this._updateMetrics(startTime);

      CacheLogger.debug(
        {
          event: "CACHE_HIT",
          key,
          fullKey,
          latency: Date.now() - startTime,
          component: "CacheService",
        },
        "Cache hit",
      );

      return value;
    } catch (error) {
      this.metrics.cacheErrors++;
      this.metrics.lastError = error.message;
      this._updateMetrics(startTime);

      CacheLogger.error(
        {
          event: "CACHE_ERROR",
          key,
          error: error.message,
          stack: error.stack,
          operation: "get",
          component: "CacheService",
        },
        "Cache get failed",
      );

      return null;
    }
  }

  /**
   * Set value in cache
   * @param {string} key - Cache key
   * @param {any} value - Value to cache
   * @param {number} [ttl] - Time to live in seconds
   * @param {Object} [options] - Additional options
   * @param {Array<string>} [options.tags] - Tags for cache invalidation
   * @param {boolean} [options.staleWhileRevalidate] - Enable stale while revalidate
   * @returns {Promise<boolean>} True if successful
   */
  async set(key, value, ttl = null, options = {}) {
    const startTime = Date.now();
    try {
      this.validateKey(key);
      this.validateObject(value);
      const normalizedTTL = this.validateTTL(ttl);
      const fullKey = this._buildKey(key);

      const serialized = await this.serialize(value);
      const redis = await this._getRedisClient();

      try {
        await redis.set(fullKey, serialized, "EX", normalizedTTL);
        this.metrics.cacheWriteSuccesses++;
        this.metrics.cacheSets++;
      } catch (setError) {
        this.metrics.cacheWriteFailures++;
        this._queueRetry(key, fullKey, serialized, normalizedTTL);
        CacheLogger.warn(
          {
            event: "CACHE_SET_RETRY_QUEUED",
            key,
            fullKey,
            error: setError.message,
            component: "CacheService",
          },
          "Cache set failed, queued for retry",
        );
      }

      if (options.tags && options.tags.length > 0) {
        await this._associateTags(fullKey, options.tags);
      }

      this._updateMetrics(startTime);

      CacheLogger.debug(
        {
          event: "CACHE_SET",
          key,
          fullKey,
          ttl: normalizedTTL,
          size: typeof serialized === "string" ? serialized.length : serialized.length,
          tags: options.tags ? options.tags.slice(0, 5) : undefined,
          staleWhileRevalidate: options.staleWhileRevalidate || false,
          component: "CacheService",
        },
        "Cache set successful",
      );

      return true;
    } catch (error) {
      this.metrics.cacheErrors++;
      this.metrics.lastError = error.message;
      this._updateMetrics(startTime);

      CacheLogger.error(
        {
          event: "CACHE_ERROR",
          key,
          error: error.message,
          stack: error.stack,
          operation: "set",
          component: "CacheService",
        },
        "Cache set failed",
      );

      return false;
    }
  }

  /**
   * Remember - Laravel-style cache with callback fallback and request coalescing
   * @param {string} key - Cache key
   * @param {number} ttl - Time to live in seconds
   * @param {Function} callback - Function to execute on cache miss
   * @param {Object} [options] - Additional options
   * @param {Array<string>} [options.tags] - Tags for cache invalidation
   * @param {boolean} [options.staleWhileRevalidate] - Enable stale while revalidate
   * @returns {Promise<any>} Cached or computed value
   */
  async remember(key, ttl, callback, options = {}) {
    const startTime = Date.now();
    const fullKey = this._buildKey(key);

    if (typeof callback !== "function") {
      throw new Error("Callback must be a function");
    }

    // Check for existing pending request (in-memory coalescing)
    if (this.pendingRequests.has(fullKey)) {
      CacheLogger.debug(
        {
          event: "CACHE_COALESCING",
          key,
          fullKey,
          type: "in-memory",
          component: "CacheService",
        },
        "Request coalescing (in-memory)",
      );
      this.metrics.pendingRequests++;
      return this.pendingRequests.get(fullKey);
    }

    // Check pending requests limit
    if (this.pendingRequests.size >= CacheService.CONFIG.MAX_PENDING_REQUESTS) {
      CacheLogger.warn(
        {
          event: "CACHE_PENDING_LIMIT_EXCEEDED",
          size: this.pendingRequests.size,
          max: CacheService.CONFIG.MAX_PENDING_REQUESTS,
          component: "CacheService",
        },
        "Pending requests limit exceeded, executing callback directly",
      );

      try {
        const result = await callback();
        if (result !== null && result !== undefined) {
          await this.set(key, result, ttl, options);
        }
        return result;
      } catch (error) {
        this.metrics.fallbackExecutions++;
        return null;
      }
    }

    // Try distributed coalescing with Redis lock
    if (CacheService.CONFIG.ENABLE_DISTRIBUTED_COALESCING) {
      try {
        const redis = await this._getRedisClient();
        const lockKey = `${fullKey}:lock`;
        const lockValue = `${process.pid}:${Date.now()}:${this._lockCounter++}`;
        const lockTTL = Math.min(Math.floor(ttl / 10), 30);
        const locked = await redis.set(lockKey, lockValue, "NX", "EX", lockTTL);

        if (locked) {
          CacheLogger.debug(
            {
              event: "CACHE_COALESCING",
              key,
              fullKey,
              type: "distributed-lock-winner",
              component: "CacheService",
            },
            "Distributed lock acquired (winner)",
          );

          try {
            const result = await this._executeRemember(
              key,
              ttl,
              callback,
              options,
              startTime,
              fullKey,
            );

            // Safely release lock
            await this._releaseLock(lockKey, lockValue);
            return result;
          } catch (error) {
            await this._releaseLock(lockKey, lockValue);
            throw error;
          }
        } else {
          // Wait for the winner with exponential backoff
          CacheLogger.debug(
            {
              event: "CACHE_COALESCING",
              key,
              fullKey,
              type: "distributed-lock-waiting",
              component: "CacheService",
            },
            "Waiting for distributed lock",
          );

          const startWait = Date.now();
          const timeout = CacheService.CONFIG.LOCK_MAX_WAIT;
          let delay = CacheService.CONFIG.LOCK_RETRY_DELAY;

          while (Date.now() - startWait < timeout) {
            await new Promise((resolve) => setTimeout(resolve, delay));
            delay = Math.min(delay * CacheService.CONFIG.LOCK_BACKOFF_FACTOR, 1000);

            const exists = await redis.exists(fullKey);
            if (exists) {
              const value = await this.get(key);
              if (value !== null) {
                this.metrics.distributedLockSuccess++;
                return value;
              }
            }
          }

          this.metrics.distributedLockTimeout++;
          CacheLogger.warn(
            {
              event: "CACHE_COALESCING_TIMEOUT",
              key,
              fullKey,
              timeout,
              component: "CacheService",
            },
            "Distributed coalescing timeout, executing callback directly",
          );

          // Fallback - execute callback directly
          const result = await callback();
          if (result !== null && result !== undefined) {
            await this.set(key, result, ttl, options);
          }
          return result;
        }
      } catch (error) {
        this.metrics.distributedLockFailure++;
        CacheLogger.warn(
          {
            event: "CACHE_COALESCING_ERROR",
            key,
            fullKey,
            error: error.message,
            component: "CacheService",
          },
          "Distributed coalescing failed, falling back to in-memory",
        );
        return this._executeRemember(key, ttl, callback, options, startTime, fullKey);
      }
    } else {
      return this._executeRemember(key, ttl, callback, options, startTime, fullKey);
    }
  }

  /**
   * Safely release distributed lock
   * @private
   */
  async _releaseLock(lockKey, lockValue) {
    try {
      const redis = await this._getRedisClient();
      const luaScript = `
                if redis.call('GET', KEYS[1]) == ARGV[1] then
                    return redis.call('DEL', KEYS[1])
                else
                    return 0
                end
            `;
      const result = await redis.eval(luaScript, 1, lockKey, lockValue);

      if (result === 1) {
        CacheLogger.debug(
          {
            event: "CACHE_LOCK_RELEASED",
            lockKey,
            component: "CacheService",
          },
          "Distributed lock released successfully",
        );
      } else {
        CacheLogger.warn(
          {
            event: "CACHE_LOCK_RELEASE_FAILED",
            lockKey,
            reason: "Lock ownership mismatch",
            component: "CacheService",
          },
          "Failed to release lock - ownership mismatch",
        );
      }
    } catch (error) {
      CacheLogger.error(
        {
          event: "CACHE_LOCK_ERROR",
          lockKey,
          error: error.message,
          component: "CacheService",
        },
        "Error releasing distributed lock",
      );
    }
  }

  /**
   * Execute remember logic with in-memory coalescing
   * @private
   */
  async _executeRemember(key, ttl, callback, options, startTime, fullKey) {
    const promise = (async () => {
      try {
        // Try to get from cache
        const cached = await this.get(key);

        if (cached !== null) {
          this.metrics.rememberHits++;
          this._updateMetrics(startTime);
          return cached;
        }

        // Check stale while revalidate
        if (CacheService.CONFIG.ENABLE_STALE_WHILE_REVALIDATE || options.staleWhileRevalidate) {
          const stale = await this._getStale(key);
          if (stale !== null) {
            this.metrics.staleServed++;
            this.metrics.staleResponses++;

            // Refresh in background
            setImmediate(() => {
              this._refreshInBackground(key, ttl, callback, options);
            });

            return stale;
          }
        }

        // Cache miss - execute callback
        this.metrics.rememberMisses++;
        CacheLogger.debug(
          {
            event: "CACHE_MISS",
            key,
            fullKey,
            action: "executing_callback",
            component: "CacheService",
          },
          "Cache miss, executing callback",
        );

        const result = await callback();

        if (result !== null && result !== undefined) {
          await this.set(key, result, ttl, options);
        }

        this._updateMetrics(startTime);
        return result;
      } catch (error) {
        this.metrics.cacheErrors++;
        this.metrics.fallbackExecutions++;
        this.metrics.lastError = error.message;

        CacheLogger.error(
          {
            event: "CACHE_FALLBACK",
            key,
            fullKey,
            error: error.message,
            stack: error.stack,
            operation: "remember",
            component: "CacheService",
          },
          "Cache miss error, executing fallback",
        );

        try {
          const fallbackResult = await callback();
          this._updateMetrics(startTime);
          return fallbackResult;
        } catch (callbackError) {
          CacheLogger.error(
            {
              event: "CACHE_ERROR",
              key,
              fullKey,
              error: callbackError.message,
              stack: callbackError.stack,
              operation: "remember_fallback",
              component: "CacheService",
            },
            "Callback execution failed",
          );
          this._updateMetrics(startTime);
          return null;
        }
      } finally {
        this.pendingRequests.delete(fullKey);
      }
    })();

    this.pendingRequests.set(fullKey, promise);

    // Clean up hung promises
    const timeoutId = setTimeout(() => {
      if (this.pendingRequests.has(fullKey)) {
        this.pendingRequests.delete(fullKey);
        CacheLogger.warn(
          {
            event: "CACHE_PENDING_CLEANUP",
            key,
            fullKey,
            component: "CacheService",
          },
          "Cleaned up hung pending request",
        );
      }
    }, CacheService.CONFIG.PENDING_REQUEST_TIMEOUT);

    promise.finally(() => {
      clearTimeout(timeoutId);
    });

    return promise;
  }

  /**
   * Get stale value from cache
   * @private
   */
  async _getStale(key) {
    try {
      const fullKey = this._buildKey(key);
      const staleKey = `${fullKey}:stale`;
      const redis = await this._getRedisClient();
      const data = await redis.get(staleKey);

      if (data === null) {
        return null;
      }

      return this.deserialize(data);
    } catch (error) {
      CacheLogger.warn(
        {
          event: "CACHE_STALE_ERROR",
          key,
          error: error.message,
          component: "CacheService",
        },
        "Failed to get stale value",
      );
      return null;
    }
  }

  /**
   * Refresh cache in background
   * @private
   */
  async _refreshInBackground(key, ttl, callback, options) {
    try {
      this.metrics.backgroundRefreshes++;
      const result = await callback();

      if (result !== null && result !== undefined) {
        await this.set(key, result, ttl, options);
        this.metrics.backgroundRefreshSuccess++;

        CacheLogger.info(
          {
            event: "CACHE_REFRESH",
            key,
            ttl,
            component: "CacheService",
          },
          "Background cache refresh successful",
        );
      }
    } catch (error) {
      this.metrics.backgroundRefreshFailure++;
      CacheLogger.error(
        {
          event: "CACHE_REFRESH_FAILED",
          key,
          error: error.message,
          stack: error.stack,
          component: "CacheService",
        },
        "Background cache refresh failed",
      );
    }
  }

  /**
   * Delete key from cache
   * @param {string} key - Cache key
   * @returns {Promise<number>} Number of keys deleted
   */
  async delete(key) {
    const startTime = Date.now();
    try {
      this.validateKey(key);
      const fullKey = this._buildKey(key);

      const redis = await this._getRedisClient();
      const result = await redis.del(fullKey);
      this.metrics.cacheDeletes += result;
      this.metrics.totalOperations++;
      this._updateMetrics(startTime);

      CacheLogger.debug(
        {
          event: "CACHE_DELETE",
          key,
          fullKey,
          deleted: result,
          component: "CacheService",
        },
        "Cache delete successful",
      );

      return result;
    } catch (error) {
      this.metrics.cacheErrors++;
      this.metrics.lastError = error.message;
      this._updateMetrics(startTime);

      CacheLogger.error(
        {
          event: "CACHE_ERROR",
          key,
          error: error.message,
          stack: error.stack,
          operation: "delete",
          component: "CacheService",
        },
        "Cache delete failed",
      );

      return 0;
    }
  }

  /**
   * Invalidate all cache entries with a specific tag
   * @param {string} tag - Tag to invalidate
   * @returns {Promise<number>} Number of keys deleted
   */
  async invalidateTag(tag) {
    const startTime = Date.now();
    try {
      if (!CacheService.CONFIG.ENABLE_CACHE_TAGS) {
        CacheLogger.warn(
          {
            event: "CACHE_TAG_DISABLED",
            tag,
            component: "CacheService",
          },
          "Cache tags are disabled",
        );
        return 0;
      }

      const tagKey = this._buildTagKey(tag);
      const redis = await this._getRedisClient();

      // Get all keys with this tag using SCAN for large sets
      let keys = [];
      let cursor = "0";
      do {
        const [nextCursor, batch] = await redis.sscan(tagKey, cursor, "COUNT", 100);
        cursor = nextCursor;
        keys = keys.concat(batch);
      } while (cursor !== "0");

      if (keys.length === 0) {
        // Clean up empty tag set
        await redis.del(tagKey);
        return 0;
      }

      // Delete all keys and the tag itself
      const pipeline = redis.pipeline();
      const useUnlink = this._unlinkSupported;

      const chunks = [];
      for (let i = 0; i < keys.length; i += 100) {
        chunks.push(keys.slice(i, i + 100));
      }

      for (const chunk of chunks) {
        if (useUnlink) {
          pipeline.unlink(...chunk);
        } else {
          pipeline.del(...chunk);
        }
        this.metrics.pipelineOperations++;
      }

      pipeline.del(tagKey);
      const results = await pipeline.exec();

      // Count successful deletions
      const deleted = results.filter((r) => r[1] > 0).length;
      this.metrics.cacheDeletes += deleted;
      this.metrics.totalOperations += deleted;
      this._updateMetrics(startTime);

      CacheLogger.info(
        {
          event: "CACHE_TAG_INVALIDATED",
          tag,
          count: deleted,
          component: "CacheService",
        },
        "Cache tag invalidated",
      );

      return deleted;
    } catch (error) {
      this.metrics.cacheErrors++;
      this.metrics.lastError = error.message;
      this._updateMetrics(startTime);

      CacheLogger.error(
        {
          event: "CACHE_TAG_ERROR",
          tag,
          error: error.message,
          stack: error.stack,
          component: "CacheService",
        },
        "Cache tag invalidation failed",
      );

      return 0;
    }
  }

  /**
   * Check if key exists in cache
   * @param {string} key - Cache key
   * @returns {Promise<boolean>} True if exists
   */
  async exists(key) {
    const startTime = Date.now();
    try {
      this.validateKey(key);
      const fullKey = this._buildKey(key);

      const redis = await this._getRedisClient();
      const result = await redis.exists(fullKey);
      this.metrics.totalOperations++;
      this._updateMetrics(startTime);
      return result === 1;
    } catch (error) {
      this.metrics.cacheErrors++;
      this.metrics.lastError = error.message;
      this._updateMetrics(startTime);

      CacheLogger.error(
        {
          event: "CACHE_ERROR",
          key,
          error: error.message,
          stack: error.stack,
          operation: "exists",
          component: "CacheService",
        },
        "Cache exists failed",
      );

      return false;
    }
  }

  /**
   * Get TTL of key in seconds
   * @param {string} key - Cache key
   * @returns {Promise<number>} TTL in seconds (-1 if no TTL, -2 if not found)
   */
  async ttl(key) {
    const startTime = Date.now();
    try {
      this.validateKey(key);
      const fullKey = this._buildKey(key);

      const redis = await this._getRedisClient();
      const result = await redis.ttl(fullKey);
      this.metrics.totalOperations++;
      this._updateMetrics(startTime);
      return result;
    } catch (error) {
      this.metrics.cacheErrors++;
      this.metrics.lastError = error.message;
      this._updateMetrics(startTime);

      CacheLogger.error(
        {
          event: "CACHE_ERROR",
          key,
          error: error.message,
          stack: error.stack,
          operation: "ttl",
          component: "CacheService",
        },
        "Cache ttl failed",
      );

      return -2;
    }
  }

  /**
   * Touch/refresh TTL of key without fetching value
   * @param {string} key - Cache key
   * @param {number} ttl - New TTL in seconds
   * @returns {Promise<boolean>} True if successful
   */
  async touch(key, ttl) {
    const startTime = Date.now();
    try {
      this.validateKey(key);
      const normalizedTTL = this.validateTTL(ttl);
      const fullKey = this._buildKey(key);

      const redis = await this._getRedisClient();
      const result = await redis.expire(fullKey, normalizedTTL);
      this.metrics.totalOperations++;
      this._updateMetrics(startTime);

      CacheLogger.debug(
        {
          event: "CACHE_TOUCH",
          key,
          fullKey,
          ttl: normalizedTTL,
          success: result === 1,
          component: "CacheService",
        },
        "Cache touch successful",
      );

      return result === 1;
    } catch (error) {
      this.metrics.cacheErrors++;
      this.metrics.lastError = error.message;
      this._updateMetrics(startTime);

      CacheLogger.error(
        {
          event: "CACHE_ERROR",
          key,
          error: error.message,
          stack: error.stack,
          operation: "touch",
          component: "CacheService",
        },
        "Cache touch failed",
      );

      return false;
    }
  }

  /**
   * Get multiple keys at once using pipelining
   * @param {string[]} keys - Array of cache keys
   * @returns {Promise<any[]>} Array of values (null for misses)
   */
  async mget(keys) {
    const startTime = Date.now();
    if (!Array.isArray(keys) || keys.length === 0) {
      return [];
    }

    const batchSize = CacheService.CONFIG.PIPELINE_BATCH_SIZE;
    const chunks = [];

    for (let i = 0; i < keys.length; i += batchSize) {
      chunks.push(keys.slice(i, i + batchSize));
    }

    try {
      let results = [];
      const redis = await this._getRedisClient();

      for (const chunk of chunks) {
        const fullKeys = chunk.map((key) => {
          this.validateKey(key);
          return this._buildKey(key);
        });

        const pipeline = redis.pipeline();
        fullKeys.forEach((fullKey) => pipeline.get(fullKey));
        this.metrics.pipelineOperations++;

        const chunkResults = await pipeline.exec();
        const deserialized = await Promise.all(
          chunkResults.map(async ([err, data]) => {
            if (err || data === null) {
              this.metrics.cacheMisses++;
              return null;
            }
            this.metrics.cacheHits++;
            return this.deserialize(data);
          }),
        );

        results = results.concat(deserialized);
      }

      this.metrics.totalOperations += keys.length;
      this._updateMetrics(startTime);
      return results;
    } catch (error) {
      this.metrics.cacheErrors++;
      this.metrics.lastError = error.message;
      this._updateMetrics(startTime);

      CacheLogger.error(
        {
          event: "CACHE_ERROR",
          keys: keys.slice(0, 10),
          error: error.message,
          stack: error.stack,
          operation: "mget",
          component: "CacheService",
        },
        "Cache mget failed",
      );

      return keys.map(() => null);
    }
  }

  /**
   * Set multiple keys at once using pipelining
   * @param {Array<{key: string, value: any}>} items - Array of key-value pairs
   * @param {number} [ttl] - TTL for all items
   * @param {Object} [options] - Additional options
   * @param {Array<string>} [options.tags] - Tags for cache invalidation
   * @returns {Promise<boolean[]>} Array of success indicators
   */
  async mset(items, ttl = null, options = {}) {
    const startTime = Date.now();
    if (!Array.isArray(items) || items.length === 0) {
      return [];
    }

    const normalizedTTL = this.validateTTL(ttl);
    const batchSize = CacheService.CONFIG.PIPELINE_BATCH_SIZE;
    const chunks = [];

    for (let i = 0; i < items.length; i += batchSize) {
      chunks.push(items.slice(i, i + batchSize));
    }

    try {
      const redis = await this._getRedisClient();
      let allResults = [];

      for (const chunk of chunks) {
        const pipeline = redis.pipeline();
        const processedItems = await Promise.all(
          chunk.map(async ({ key, value }) => {
            this.validateKey(key);
            this.validateObject(value);
            const fullKey = this._buildKey(key);
            const serialized = await this.serialize(value);

            if (options.tags && options.tags.length > 0) {
              await this._associateTags(fullKey, options.tags);
            }

            return { fullKey, serialized };
          }),
        );

        processedItems.forEach(({ fullKey, serialized }) => {
          pipeline.set(fullKey, serialized, "EX", normalizedTTL);
          this.metrics.cacheSets++;
        });
        this.metrics.pipelineOperations++;

        const results = await pipeline.exec();
        allResults = allResults.concat(results.map(([err]) => err === null));
      }

      this.metrics.totalOperations += items.length;
      this._updateMetrics(startTime);

      CacheLogger.debug(
        {
          event: "CACHE_MSET",
          count: items.length,
          ttl: normalizedTTL,
          tags: options.tags ? options.tags.slice(0, 5) : undefined,
          component: "CacheService",
        },
        "Cache mset successful",
      );

      return allResults;
    } catch (error) {
      this.metrics.cacheErrors++;
      this.metrics.lastError = error.message;
      this._updateMetrics(startTime);

      CacheLogger.error(
        {
          event: "CACHE_ERROR",
          count: items.length,
          error: error.message,
          stack: error.stack,
          operation: "mset",
          component: "CacheService",
        },
        "Cache mset failed",
      );

      return items.map(() => false);
    }
  }

  /**
   * Delete keys matching pattern using SCAN (safe for production)
   * @param {string} pattern - Redis pattern to match
   * @returns {Promise<number>} Number of keys deleted
   */
  async deletePattern(pattern) {
    const startTime = Date.now();
    if (typeof pattern !== "string" || !pattern) {
      throw new Error("Pattern must be a non-empty string");
    }

    try {
      const fullPattern = this._buildKey(pattern);
      let deletedCount = 0;
      let cursor = "0";
      const redis = await this._getRedisClient();
      const useUnlink = this._unlinkSupported;
      const batchSize = CacheService.CONFIG.SCAN_COUNT;

      do {
        const [nextCursor, keys] = await redis.scan(
          cursor,
          "MATCH",
          fullPattern,
          "COUNT",
          batchSize,
        );

        cursor = nextCursor;

        if (keys.length > 0) {
          const pipeline = redis.pipeline();
          const chunks = [];
          for (let i = 0; i < keys.length; i += 100) {
            chunks.push(keys.slice(i, i + 100));
          }

          for (const chunk of chunks) {
            if (useUnlink) {
              pipeline.unlink(...chunk);
            } else {
              pipeline.del(...chunk);
            }
            this.metrics.pipelineOperations++;
          }

          const results = await pipeline.exec();
          const successful = results.filter(([err]) => err === null).length;
          deletedCount += successful;
          this.metrics.cacheDeletes += successful;
        }
      } while (cursor !== "0");

      this.metrics.totalOperations += deletedCount;
      this._updateMetrics(startTime);

      CacheLogger.info(
        {
          event: "CACHE_PATTERN_DELETE",
          pattern,
          fullPattern,
          deleted: deletedCount,
          method: useUnlink ? "UNLINK" : "DEL",
          component: "CacheService",
        },
        "Cache pattern delete successful",
      );

      return deletedCount;
    } catch (error) {
      this.metrics.cacheErrors++;
      this.metrics.lastError = error.message;
      this._updateMetrics(startTime);

      CacheLogger.error(
        {
          event: "CACHE_ERROR",
          pattern,
          error: error.message,
          stack: error.stack,
          operation: "deletePattern",
          component: "CacheService",
        },
        "Cache pattern delete failed",
      );

      return 0;
    }
  }

  /**
   * Increment counter by 1
   * @param {string} key - Counter key
   * @returns {Promise<number>} New counter value
   */
  async increment(key) {
    return this.incrementBy(key, 1);
  }

  /**
   * Increment counter by specified amount
   * @param {string} key - Counter key
   * @param {number} amount - Amount to increment by (must be positive)
   * @returns {Promise<number>} New counter value
   */
  async incrementBy(key, amount = 1) {
    const startTime = Date.now();
    try {
      this.validateKey(key);

      if (typeof amount !== "number" || amount <= 0) {
        throw new Error("Amount must be a positive number");
      }

      const fullKey = this._buildKey(key);
      const redis = await this._getRedisClient();

      const luaScript = `
                local current = redis.call('GET', KEYS[1])
                local result = redis.call('INCRBY', KEYS[1], ARGV[1])
                if current == false then
                    redis.call('EXPIRE', KEYS[1], ARGV[2])
                end
                return result
            `;

      const result = await redis.eval(
        luaScript,
        1,
        fullKey,
        amount,
        CacheService.CONFIG.COUNTER_TTL,
      );

      this.metrics.totalOperations++;
      this._updateMetrics(startTime);
      return result;
    } catch (error) {
      this.metrics.cacheErrors++;
      this.metrics.lastError = error.message;
      this._updateMetrics(startTime);

      CacheLogger.error(
        {
          event: "CACHE_ERROR",
          key,
          error: error.message,
          stack: error.stack,
          operation: "incrementBy",
          component: "CacheService",
        },
        "Counter increment failed",
      );

      return 0;
    }
  }

  /**
   * Decrement counter by 1
   * @param {string} key - Counter key
   * @returns {Promise<number>} New counter value
   */
  async decrement(key) {
    return this.decrementBy(key, 1);
  }

  /**
   * Decrement counter by specified amount
   * @param {string} key - Counter key
   * @param {number} amount - Amount to decrement by (must be positive)
   * @returns {Promise<number>} New counter value
   */
  async decrementBy(key, amount = 1) {
    const startTime = Date.now();
    try {
      this.validateKey(key);

      if (typeof amount !== "number" || amount <= 0) {
        throw new Error("Amount must be a positive number");
      }

      const fullKey = this._buildKey(key);
      const redis = await this._getRedisClient();

      const luaScript = `
                local current = redis.call('GET', KEYS[1])
                local result = redis.call('DECRBY', KEYS[1], ARGV[1])
                if current == false then
                    redis.call('EXPIRE', KEYS[1], ARGV[2])
                end
                return result
            `;

      const result = await redis.eval(
        luaScript,
        1,
        fullKey,
        amount,
        CacheService.CONFIG.COUNTER_TTL,
      );

      this.metrics.totalOperations++;
      this._updateMetrics(startTime);
      return result;
    } catch (error) {
      this.metrics.cacheErrors++;
      this.metrics.lastError = error.message;
      this._updateMetrics(startTime);

      CacheLogger.error(
        {
          event: "CACHE_ERROR",
          key,
          error: error.message,
          stack: error.stack,
          operation: "decrementBy",
          component: "CacheService",
        },
        "Counter decrement failed",
      );

      return 0;
    }
  }

  /**
   * Warm up cache with value
   * @param {string} key - Cache key
   * @param {number} ttl - Time to live in seconds
   * @param {Function} callback - Function to generate value
   * @param {Object} [options] - Additional options
   * @param {Array<string>} [options.tags] - Tags for cache invalidation
   * @returns {Promise<boolean>} True if warmup successful
   */
  async warmup(key, ttl, callback, options = {}) {
    const startTime = Date.now();
    if (typeof callback !== "function") {
      throw new Error("Callback must be a function");
    }

    try {
      this.validateKey(key);
      const normalizedTTL = this.validateTTL(ttl);
      const fullKey = this._buildKey(key);

      const redis = await this._getRedisClient();
      const exists = await redis.exists(fullKey);

      if (exists) {
        CacheLogger.debug(
          {
            event: "CACHE_WARMUP_SKIPPED",
            key,
            fullKey,
            reason: "Already exists",
            component: "CacheService",
          },
          "Cache warmup skipped",
        );
        this._updateMetrics(startTime);
        return true;
      }

      const value = await callback();

      if (value === null || value === undefined) {
        CacheLogger.warn(
          {
            event: "CACHE_WARMUP_FAILED",
            key,
            fullKey,
            reason: "Callback returned null/undefined",
            component: "CacheService",
          },
          "Cache warmup failed",
        );
        this._updateMetrics(startTime);
        return false;
      }

      await this.set(key, value, normalizedTTL, options);

      CacheLogger.info(
        {
          event: "CACHE_WARMUP",
          key,
          fullKey,
          ttl: normalizedTTL,
          component: "CacheService",
        },
        "Cache warmup successful",
      );

      this.metrics.totalOperations++;
      this._updateMetrics(startTime);
      return true;
    } catch (error) {
      this.metrics.cacheErrors++;
      this.metrics.lastError = error.message;
      this._updateMetrics(startTime);

      CacheLogger.error(
        {
          event: "CACHE_ERROR",
          key,
          error: error.message,
          stack: error.stack,
          operation: "warmup",
          component: "CacheService",
        },
        "Cache warmup failed",
      );

      return false;
    }
  }

  /**
   * Update metrics with operation latency
   * @private
   * @param {number} startTime - Operation start time
   */
  _updateMetrics(startTime) {
    if (!CacheService.CONFIG.ENABLE_METRICS_TRACKING) {
      return;
    }

    const latency = Date.now() - startTime;
    this.metrics.totalLatency += latency;
    this.metrics.totalOperations = Math.max(0, this.metrics.totalOperations);
    this.metrics.averageLatency =
      this.metrics.totalOperations > 0
        ? this.metrics.totalLatency / this.metrics.totalOperations
        : 0;
    this.metrics.hitRatio =
      this.metrics.cacheHits + this.metrics.cacheMisses > 0
        ? (this.metrics.cacheHits / (this.metrics.cacheHits + this.metrics.cacheMisses)) * 100
        : 0;
  }

  /**
   * Get current cache metrics
   * @returns {Object} Cache metrics
   */
  getMetrics() {
    const uptime = Math.floor((Date.now() - this.metrics.startTime) / 1000);

    return {
      ...this.metrics,
      hitRatio: this.metrics.hitRatio,
      uptime,
      pendingRequests: this.pendingRequests.size,
      retryQueueSize: this.retryQueue.length,
      timestamp: new Date().toISOString(),
      config: {
        defaultTTL: CacheService.CONFIG.DEFAULT_TTL,
        maxTTL: CacheService.CONFIG.MAX_TTL,
        minTTL: CacheService.CONFIG.MIN_TTL,
        compressionThreshold: CacheService.CONFIG.COMPRESSION_THRESHOLD,
        namespace: CacheService.CONFIG.CACHE_NAMESPACE,
        version: CacheService.CONFIG.CACHE_VERSION,
        ttlJitterPercent: CacheService.CONFIG.TTL_JITTER_PERCENT,
        enableDistributedCoalescing: CacheService.CONFIG.ENABLE_DISTRIBUTED_COALESCING,
        brotliEnabled: CacheService.CONFIG.BROTLI_ENABLED,
      },
    };
  }

  /**
   * Reset cache metrics
   */
  resetMetrics() {
    this.metrics = {
      cacheHits: 0,
      cacheMisses: 0,
      cacheSets: 0,
      cacheDeletes: 0,
      cacheErrors: 0,
      rememberHits: 0,
      rememberMisses: 0,
      fallbackExecutions: 0,
      compressionCount: 0,
      decompressionCount: 0,
      staleServed: 0,
      backgroundRefreshes: 0,
      pendingRequests: 0,
      averageLatency: 0,
      totalLatency: 0,
      totalOperations: 0,
      hitRatio: 0,
      lastError: null,
      startTime: Date.now(),
      cacheWriteRetries: 0,
      cacheRetryFailures: 0,
      distributedLockSuccess: 0,
      distributedLockFailure: 0,
      distributedLockTimeout: 0,
      staleResponses: 0,
      backgroundRefreshSuccess: 0,
      backgroundRefreshFailure: 0,
      compressionSavings: 0,
      averageCompressionRatio: 0,
      pipelineOperations: 0,
      serializationFailures: 0,
      deserializationFailures: 0,
      cacheWriteSuccesses: 0,
      cacheWriteFailures: 0,
    };

    CacheLogger.info(
      {
        event: "CACHE_METRICS_RESET",
        component: "CacheService",
      },
      "Cache metrics reset",
    );
  }

  /**
   * Check health of cache service
   * @param {boolean} [forceRefresh=false] - Force refresh health cache
   * @returns {Promise<Object>} Health status
   */
  async health(forceRefresh = false) {
    const startTime = Date.now();

    if (!forceRefresh && this.healthCache.data && this.healthCache.expiresAt > Date.now()) {
      return this.healthCache.data;
    }

    try {
      const redis = await this._getRedisClient();

      // Get Redis info with specific sections only
      const [serverInfo, memoryInfo, statsInfo] = await Promise.all([
        redis.info("server"),
        redis.info("memory"),
        redis.info("stats"),
      ]);

      const parseInfo = (data) => {
        const obj = {};
        const lines = data.split("\n");
        for (const line of lines) {
          if (line && !line.startsWith("#")) {
            const [key, value] = line.split(":");
            if (key && value) {
              obj[key.trim()] = value.trim();
            }
          }
        }
        return obj;
      };

      const server = parseInfo(serverInfo);
      const memory = parseInfo(memoryInfo);
      const stats = parseInfo(statsInfo);

      const pingResult = await redis.ping();
      const latency = Date.now() - startTime;

      this.healthStatus = {
        status: pingResult === "PONG" ? "healthy" : "degraded",
        latency,
        lastCheck: new Date().toISOString(),
        redisConnected: pingResult === "PONG",
        memory: memory.used_memory_human || "N/A",
        connectedClients: parseInt(stats.connected_clients, 10) || 0,
        redisVersion: server.redis_version || "N/A",
        hitRatio: this.metrics.hitRatio,
        uptime: Math.floor((Date.now() - this.metrics.startTime) / 1000),
        pendingRequests: this.pendingRequests.size,
        totalOperations: this.metrics.totalOperations,
        cacheErrors: this.metrics.cacheErrors,
        compressionEnabled: CacheService.CONFIG.ENABLE_COMPRESSION,
        unlinkSupported: this._unlinkSupported,
        retryQueueSize: this.retryQueue.length,
        totalMemory: memory.total_system_memory_human || "N/A",
        maxMemory: memory.maxmemory_human || "N/A",
        memoryFragmentation: memory.mem_fragmentation_ratio || "N/A",
        totalConnectionsReceived: stats.total_connections_received || "N/A",
        totalCommandsProcessed: stats.total_commands_processed || "N/A",
      };

      this.healthCache.data = this.healthStatus;
      this.healthCache.expiresAt = Date.now() + CacheService.CONFIG.HEALTH_CACHE_TTL * 1000;

      CacheLogger.debug(
        {
          event: "CACHE_HEALTH",
          status: this.healthStatus.status,
          latency: this.healthStatus.latency,
          component: "CacheService",
        },
        "Cache health check successful",
      );

      return this.healthStatus;
    } catch (error) {
      const latency = Date.now() - startTime;

      this.healthStatus = {
        status: "unhealthy",
        latency,
        lastCheck: new Date().toISOString(),
        redisConnected: false,
        error: error.message,
        hitRatio: this.metrics.hitRatio,
        uptime: Math.floor((Date.now() - this.metrics.startTime) / 1000),
        pendingRequests: this.pendingRequests.size,
      };

      CacheLogger.error(
        {
          event: "CACHE_HEALTH_FAILED",
          error: error.message,
          stack: error.stack,
          component: "CacheService",
        },
        "Cache health check failed",
      );

      return this.healthStatus;
    }
  }

  /**
   * Graceful shutdown
   * @returns {Promise<void>}
   */
  async shutdown() {
    this._shuttingDown = true;

    if (this._retryTimer) {
      clearInterval(this._retryTimer);
      this._retryTimer = null;
    }

    // Wait for pending requests to complete
    if (this.pendingRequests.size > 0) {
      const pending = Array.from(this.pendingRequests.values());
      await Promise.allSettled(pending);
    }

    // Clear pending requests
    this.pendingRequests.clear();
    this.retryQueue = [];
    this.staleCache.clear();
    this.tagCache.clear();

    CacheLogger.info(
      {
        event: "CACHE_SHUTDOWN",
        component: "CacheService",
      },
      "CacheService shutdown complete",
    );
  }
}

// Export singleton instance
module.exports = new CacheService();
