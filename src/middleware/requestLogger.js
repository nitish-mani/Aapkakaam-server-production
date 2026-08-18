const { randomUUID } = require("crypto");
const logger = require("../logger/logger");

/**
 * Request Logger Middleware
 *
 * - Generates/propagates X-Request-Id
 * - Creates request scoped logger (req.log)
 * - Logs every completed request
 */
module.exports = (req, res, next) => {
  const incomingRequestId = req.get("x-request-id");

  req.requestId =
    incomingRequestId && incomingRequestId.length <= 128 ? incomingRequestId : randomUUID();

  // Alias used by many libraries
  req.id = req.requestId;

  res.setHeader("X-Request-Id", req.requestId);

  // Base logger for this request.
  // Authentication middleware will later enrich this with authId and role.
  req.log = logger.child({
    requestId: req.requestId,
  });

  const start = process.hrtime.bigint();

  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;

    const logData = {
      requestId: req.requestId,
      method: req.method,
      url: req.originalUrl,
      status: res.statusCode,
      duration: `${durationMs.toFixed(2)} ms`,
      ip: req.ip,
      userAgent: req.get("user-agent"),
      contentLength: res.getHeader("content-length") || 0,
    };

    if (res.statusCode >= 500) {
      req.log.error(logData, "Request completed");
    } else if (res.statusCode >= 400) {
      req.log.warn(logData, "Request completed");
    } else {
      req.log.info(logData, "Request completed");
    }
  });

  next();
};
