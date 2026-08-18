/**
 * Input validation for booking operations.
 *
 * Responsibilities:
 * - Validate required booking fields
 * - Validate MongoDB ObjectIds
 * - Validate pagination
 * - Validate ratings
 *
 * Client input errors are returned as HTTP 400 through ApiError.
 *
 * Does NOT change the request body structure.
 */

const { ObjectId } = require("mongodb");
const ApiError = require("../utils/ApiError");

class BookingValidator {
  /**
   * Validate MongoDB ObjectId.
   */
  static validateId(id, fieldName) {
    if (!id) {
      throw ApiError.badRequest(`${fieldName} is required`);
    }

    if (!ObjectId.isValid(id)) {
      throw ApiError.badRequest(`Invalid ${fieldName} format`);
    }

    return id;
  }

  /**
   * Validate booking creation request.
   */
  static validateBookingRequest(body) {
    const { userId, vendorId, bookingDate, type, pincode } = body;

    if (!userId || !vendorId || !bookingDate || !type || !pincode) {
      throw ApiError.badRequest("All fields are required");
    }

    return {
      userId: this.validateId(userId, "userId"),
      vendorId: this.validateId(vendorId, "vendorId"),
      bookingDate,
      type,
      pincode,
    };
  }

  /**
   * Validate cancellation request.
   */
  static validateCancelRequest(body) {
    const { bookingId } = body;

    if (!bookingId) {
      throw ApiError.badRequest("Booking ID is required");
    }

    return {
      bookingId: this.validateId(bookingId, "bookingId"),
    };
  }

  /**
   * Completion uses the same booking ID validation
   * as cancellation.
   */
  static validateCompleteRequest(body) {
    return this.validateCancelRequest(body);
  }

  /**
   * Validate rating request.
   */
  static validateRatingRequest(body) {
    const { bookingId, rating, review } = body;

    if (!bookingId) {
      throw ApiError.badRequest("Booking ID is required");
    }

    if (rating === undefined || rating === null || rating === "") {
      throw ApiError.badRequest("Rating is required");
    }

    const parsedRating = Number(rating);

    if (!Number.isInteger(parsedRating) || parsedRating < 1 || parsedRating > 5) {
      throw ApiError.badRequest("Rating must be an integer between 1 and 5");
    }

    return {
      bookingId: this.validateId(bookingId, "bookingId"),
      rating: parsedRating,
      review: review || "",
    };
  }

  /**
   * Validate rating permission request.
   */
  static validateRatingPermissionRequest(body) {
    const { bookingId } = body;

    if (!bookingId) {
      throw ApiError.badRequest("Booking ID is required");
    }

    return {
      bookingId: this.validateId(bookingId, "bookingId"),
    };
  }

  /**
   * Validate booking pagination.
   */
  static validatePagination(userId, pageNo) {
    if (!userId) {
      throw ApiError.badRequest("User ID is required");
    }

    const validatedUserId = this.validateId(userId, "userId");

    const page = Number(pageNo);

    if (!Number.isInteger(page) || page < 1) {
      throw ApiError.badRequest("Page number must be a positive integer");
    }

    return {
      userId: validatedUserId,
      page,
      pageSize: 12,
    };
  }

  static validateGetRatingAndReviewRequest(body) {
    const { bookingId } = body;

    if (!bookingId) {
      throw ApiError.badRequest("Booking ID is required");
    }
    return {
      bookingId: this.validateId(bookingId, "bookingId"),
    };
  }
}

module.exports = BookingValidator;
