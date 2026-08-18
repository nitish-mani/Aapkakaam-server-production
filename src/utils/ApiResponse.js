/**
 * Standard API Response utility
 * Provides consistent response structure across the application
 */
class ApiResponse {
  /**
   * Create a success response
   * @param {string} message - Success message
   * @param {*} data - Response data
   * @param {number} statusCode - HTTP status code (default: 200)
   * @returns {Object} Formatted success response
   */
  // Add this to your ApiResponse class
  static created(message = "Resource created successfully", data = null) {
    return {
      success: true,
      statusCode: 201,
      message,
      data,
      timestamp: new Date().toISOString(),
    };
  }
  static success(message = "Success", data = null, statusCode = 200) {
    return {
      success: true,
      statusCode,
      message,
      data,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Create an error response
   * @param {string} message - Error message
   * @param {*} details - Additional error details
   * @param {number} statusCode - HTTP status code (default: 400)
   * @returns {Object} Formatted error response
   */
  static error(message = "Internal Server Error", details = null, statusCode = 400, meta = {}) {
    return {
      success: false,
      statusCode,
      message,
      details,
      timestamp: new Date().toISOString(),
      ...meta,
    };
  }

  /**
   * Create a paginated response
   * @param {Array} data - Data array
   * @param {Object} pagination - Pagination metadata
   * @param {string} message - Success message
   * @returns {Object} Formatted paginated response
   */
  static paginated(data, pagination, message = "Data retrieved successfully") {
    return {
      success: true,
      statusCode: 200,
      message,
      data,
      pagination: {
        page: pagination.page || 1,
        limit: pagination.limit || 10,
        total: pagination.total || data.length,
        totalPages:
          pagination.totalPages ||
          Math.ceil((pagination.total || data.length) / (pagination.limit || 10)),
      },
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Create a validation error response
   * @param {Object} errors - Validation errors object
   * @param {string} message - Error message
   * @returns {Object} Formatted validation error response
   */
  static validationError(errors, message = "Validation failed") {
    return {
      success: false,
      statusCode: 400,
      message,
      errors,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Create a not found response
   * @param {string} resource - Resource name
   * @param {string} message - Custom message
   * @returns {Object} Formatted not found response
   */
  static notFound(resource = "Resource", message = null) {
    return {
      success: false,
      statusCode: 404,
      message: message || `${resource} not found`,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Create an unauthorized response
   * @param {string} message - Error message
   * @returns {Object} Formatted unauthorized response
   */
  static unauthorized(message = "Unauthorized access") {
    return {
      success: false,
      statusCode: 401,
      message,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Create a forbidden response
   * @param {string} message - Error message
   * @returns {Object} Formatted forbidden response
   */
  static forbidden(message = "Access forbidden") {
    return {
      success: false,
      statusCode: 403,
      message,
      timestamp: new Date().toISOString(),
    };
  }
}

module.exports = ApiResponse;
