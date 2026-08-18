const ApiResponse = require("../utils/ApiResponse");
const ApiError = require("../utils/ApiError");
const logger = require("../config/logger");

const errorHandler = (err, req, res, next) => {
  const log = req.log || logger;

  log.error(
    {
      err, // <-- Pino serializes this automatically
      requestId: req.requestId,
      authId: req.auth?.id,
      role: req.auth?.role,
      method: req.method,
      url: req.originalUrl,
      ip: req.ip,
      query: req.query,
      params: req.params,
    },
    err.message || "Unhandled application error",
  );

  // ApiError
  if (err instanceof ApiError) {
    return res
      .status(err.statusCode)
      .json(ApiResponse.error(err.message, err.details, err.statusCode));
  }

  // Validation
  if (err.name === "ValidationError") {
    const messages = Object.values(err.errors).map((e) => e.message);

    return res.status(400).json(ApiResponse.error("Validation failed", { errors: messages }, 400));
  }

  // Duplicate key
  if (err.code === 11000) {
    const field = Object.keys(err.keyPattern)[0];

    return res.status(409).json(ApiResponse.error(`Duplicate value for ${field}`, null, 409));
  }

  // Invalid ObjectId
  if (err.name === "CastError") {
    return res.status(400).json(ApiResponse.error(`Invalid ${err.path}: ${err.value}`, null, 400));
  }

  // JWT
  if (err.name === "JsonWebTokenError") {
    return res.status(401).json(ApiResponse.error("Invalid token", null, 401));
  }

  if (err.name === "TokenExpiredError") {
    return res.status(401).json(ApiResponse.error("Token expired", null, 401));
  }

  const statusCode = err.statusCode || 500;

  const details =
    process.env.NODE_ENV === "development"
      ? {
          stack: err.stack,
        }
      : null;

  return res
    .status(statusCode)
    .json(ApiResponse.error(err.message || "Internal Server Error", details, statusCode));
};

module.exports = errorHandler;
