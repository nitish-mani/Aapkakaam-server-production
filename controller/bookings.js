/**
 * Bookings Controller
 */
const asyncHandler = require("../src/utils/asyncHandler");
const ApiResponse = require("../src/utils/ApiResponse");
const ApiError = require("../src/utils/ApiError");
const BookingService = require("../src/services/BookingService");
const BookingValidator = require("../src/validators/bookingValidators");

/**
 * Ensure authenticated account owns the requested resource identity.
 */
function assertAuthenticatedOwner(req, requestedId, expectedRole) {
  if (!req.auth?.id || req.auth.role !== expectedRole) {
    throw ApiError.unauthorized("Authentication required.");
  }

  if (String(req.auth.id) !== String(requestedId)) {
    throw ApiError.forbidden("You are not authorized to access or modify this resource.");
  }
}

/**
 * User creates booking
 */
exports.bookings_controller_postU = asyncHandler(async (req, res) => {
  const validatedData = BookingValidator.validateBookingRequest(req.body);

  assertAuthenticatedOwner(req, validatedData.userId, "user");

  const result = await BookingService.createUserBooking({
    ...validatedData,

    // Authenticated identity is authoritative.
    userId: req.auth.id,

    requestId: req.id,
  });

  res.status(201).json(ApiResponse.created(result.message, result.data));
});

/**
 * Vendor acting as customer creates booking
 */
exports.bookings_controller_postV = asyncHandler(async (req, res) => {
  const validatedData = BookingValidator.validateBookingRequest(req.body);

  assertAuthenticatedOwner(req, validatedData.userId, "vendor");

  const requestData = {
    ...validatedData,

    // Authenticated vendor is the customer.
    userId: req.auth.id,

    isSelfBooking: req.body.isSelfBooking === true,

    name: req.body.name,
    phoneNo: req.body.phoneNo,
    vill: req.body.vill,
    post: req.body.post,
    dist: req.body.dist,

    requestId: req.id,
  };

  const result = await BookingService.createVendorBooking(requestData);

  res.status(201).json(ApiResponse.created(result.message, result.data));
});

/**
 * Get user's bookings
 */
/**
 * GET USER CUSTOMER ORDERS
 *
 * A normal User is acting as customer.
 */
exports.bookings_controller_getU = asyncHandler(async (req, res) => {
  const { userId, pageNo } = req.params;

  if (!req.auth?.id || req.auth.role !== "user") {
    throw ApiError.unauthorized("Authentication required.");
  }

  if (String(req.auth.id) !== String(userId)) {
    throw ApiError.forbidden("You are not authorized to access these bookings.");
  }

  const { page, pageSize } = BookingValidator.validatePagination(req.auth.id, pageNo);

  const result = await BookingService.getUserBookings(req.auth.id, page, pageSize);

  res.status(200).json(result);
});

/**
 * GET VENDOR-CUSTOMER ORDERS
 *
 * A Vendor is acting as customer.
 *
 * IMPORTANT:
 * The vendor is still the CUSTOMER in this flow.
 * Therefore booking.userId contains this vendor's ID.
 */
exports.bookings_controller_getV = asyncHandler(async (req, res) => {
  const { userId, pageNo } = req.params;

  if (!req.auth?.id || req.auth.role !== "vendor") {
    throw ApiError.unauthorized("Authentication required.");
  }

  if (String(req.auth.id) !== String(userId)) {
    throw ApiError.forbidden("You are not authorized to access these bookings.");
  }

  const { page, pageSize } = BookingValidator.validatePagination(req.auth.id, pageNo);

  const result = await BookingService.getUserBookings(req.auth.id, page, pageSize);

  res.status(200).json(result);
});

/**
 * User cancellation
 */
exports.bookings_controller_cancelU = asyncHandler(async (req, res) => {
  const { bookingId } = BookingValidator.validateCancelRequest(req.body);

  const result = await BookingService.cancelUserBooking(bookingId, req.auth.id, req.id);

  res.status(200).json(ApiResponse.success(result.message, result.data));
});

/**
 * Vendor-as-customer cancellation
 */
exports.bookings_controller_cancelV = asyncHandler(async (req, res) => {
  const { bookingId } = BookingValidator.validateCancelRequest(req.body);

  const result = await BookingService.cancelVendorBooking(bookingId, req.auth.id, req.id);

  res.status(200).json(ApiResponse.success(result.message, result.data));
});

/**
 * User completion
 */
exports.bookings_controller_completeU = asyncHandler(async (req, res) => {
  const { bookingId } = BookingValidator.validateCompleteRequest(req.body);

  const result = await BookingService.completeUserBooking(bookingId, req.auth.id, req.id);

  res.status(200).json(ApiResponse.success(result.message));
});

/**
 * Vendor-as-customer completion
 */
exports.bookings_controller_completeV = asyncHandler(async (req, res) => {
  const { bookingId } = BookingValidator.validateCompleteRequest(req.body);

  const result = await BookingService.completeVendorBooking(bookingId, req.auth.id, req.id);

  res.status(200).json(ApiResponse.success(result.message));
});

/**
 * User rating
 */
exports.bookings_controller_ratingU = asyncHandler(async (req, res) => {
  const { bookingId, rating, review } = BookingValidator.validateRatingRequest(req.body);

  const result = await BookingService.giveRating(bookingId, rating, review, "user", req.auth.id);

  res.status(200).json(ApiResponse.success(result.message));
});

/**
 * Vendor-as-customer rating
 */
exports.bookings_controller_ratingV = asyncHandler(async (req, res) => {
  const { bookingId, rating, review } = BookingValidator.validateRatingRequest(req.body);

  const result = await BookingService.giveRating(bookingId, rating, review, "vendor", req.auth.id);

  res.status(200).json(ApiResponse.success(result.message));
});

exports.bookings_controller_getReviewsU = asyncHandler(async (req, res) => {
  const { userId, pageNo, vendorId } = req.params;

  if (String(req.auth.id) !== String(userId)) {
    throw ApiError.forbidden("You are not authorized to access these bookings.");
  }
  if (!req.auth?.id || req.auth.role !== "user") {
    throw ApiError.unauthorized("Authentication required.");
  }

  const { page, pageSize } = BookingValidator.validatePagination(req.auth.id, pageNo);

  const result = await BookingService.getVendorReviews(vendorId, page, pageSize);

  res.status(200).json(result);
});

exports.bookings_controller_getReviewsV = asyncHandler(async (req, res) => {
  const { vendorUserId, vendorId, pageNo } = req.params;
  if (String(req.auth.id) !== String(vendorUserId)) {
    throw ApiError.forbidden("You are not authorized to access these bookings.");
  }
  if (!req.auth?.id || req.auth.role !== "vendor") {
    throw ApiError.unauthorized("Authentication required.");
  }

  const { page, pageSize } = BookingValidator.validatePagination(req.auth.id, pageNo);

  const result = await BookingService.getVendorReviews(vendorId, page, pageSize);

  res.status(200).json(result);
});
