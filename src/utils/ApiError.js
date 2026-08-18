/**
 * Custom API Error class
 * Extends native Error class with HTTP status code and details
 */
class ApiError extends Error {
  constructor(statusCode, message, details = null, isOperational = true) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
    this.isOperational = isOperational;
    this.timestamp = new Date().toISOString();

    // Capture stack trace for debugging
    Error.captureStackTrace(this, this.constructor);
  }

  /**
   * Create a Bad Request (400) error
   * @param {string} message - Error message
   * @param {*} details - Additional details
   * @returns {ApiError}
   */
  static badRequest(message = "Bad request", details = null) {
    return new ApiError(400, message, details);
  }

  /**
   * Create an Unauthorized (401) error
   * @param {string} message - Error message
   * @param {*} details - Additional details
   * @returns {ApiError}
   */
  static unauthorized(message = "Unauthorized", details = null) {
    return new ApiError(401, message, details);
  }
  /**
   * Create a Payment Required (402) error
   * Used when an operation cannot continue because
   * the account has insufficient balance/funds.
   *
   * @param {string} message - Error message
   * @param {*} details - Additional details
   * @returns {ApiError}
   */
  static paymentRequired(message = "Payment required", details = null) {
    return new ApiError(402, message, details);
  }
  /**
   * Create a Forbidden (403) error
   * @param {string} message - Error message
   * @param {*} details - Additional details
   * @returns {ApiError}
   */
  static forbidden(message = "Forbidden", details = null) {
    return new ApiError(403, message, details);
  }

  /**
   * Create a Not Found (404) error
   * @param {string} message - Error message
   * @param {*} details - Additional details
   * @returns {ApiError}
   */
  static notFound(message = "Resource not found", details = null) {
    return new ApiError(404, message, details);
  }

  /**
   * Create a Conflict (409) error
   * @param {string} message - Error message
   * @param {*} details - Additional details
   * @returns {ApiError}
   */
  static conflict(message = "Resource conflict", details = null) {
    return new ApiError(409, message, details);
  }

  /**
   * Create a Validation (422) error
   * @param {string} message - Error message
   * @param {*} details - Additional details
   * @returns {ApiError}
   */
  static validation(message = "Validation failed", details = null) {
    return new ApiError(422, message, details);
  }

  /**
   * Create an Internal Server Error (500)
   * @param {string} message - Error message
   * @param {*} details - Additional details
   * @returns {ApiError}
   */
  static internal(message = "Internal server error", details = null) {
    return new ApiError(500, message, details, false);
  }

  /**
   * Convert to JSON format for response
   * @returns {Object} JSON representation of error
   */
  toJSON() {
    return {
      success: false,
      statusCode: this.statusCode,
      message: this.message,
      details: this.details,
      timestamp: this.timestamp,
      ...(process.env.NODE_ENV === "development" && { stack: this.stack }),
    };
  }
}

module.exports = ApiError;
