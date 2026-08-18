module.exports = {
  BOOKING_LOCK: (bookingId) => `booking:lock:${bookingId}`,

  VENDOR_LOCK: (vendorId) => `vendor:lock:${vendorId}`,

  USER_LOCK: (userId) => `user:lock:${userId}`,

  NOTIFICATION_LOCK: (notificationId) => `notification:lock:${notificationId}`,

  PAYMENT_LOCK: (paymentId) => `payment:lock:${paymentId}`,

  OTP: (phone) => `otp:${phone}`,

  SESSION: (userId) => `session:${userId}`,

  RATE_LIMIT: (ip) => `ratelimit:${ip}`,

  BOOKING_CACHE: (bookingId) => `booking:${bookingId}`,

  USER_CACHE: (userId) => `user:${userId}`,

  VENDOR_CACHE: (vendorId) => `vendor:${vendorId}`,

  VENDOR_LIST_CACHE: (type, pincode, bookingDate, page, minRating, minWageRate) =>
    `vendors:${type}:${pincode}:${bookingDate}:${page}:${minRating}:${minWageRate}`,

  // NEW
  UNAVAILABLE_VENDOR_IDS: (type, pincode, bookingDate) =>
    `vendors:unavailable:${type}:${pincode}:${bookingDate}`,

  // NEW
  VENDOR_COUNT: (type, pincode, bookingDate, minRating, minWageRate) =>
    `vendors:count:${type}:${pincode}:${bookingDate}:${minRating}:${minWageRate}`,

  ADMIN_ANALYTICS_CACHE: () => "admin:analytics",

  CATEGORY_CACHE: () => "categories",

  HOME_CACHE: () => "homepage",

  VENDOR_COUNT_CACHE: (type, pincode, bookingDate, minRating, minWageRate) =>
    `vendors:count:${type}:${pincode}:${bookingDate}:${minRating}:${minWageRate}`,

  VENDOR_REVIEWS_CACHE: (vendorId, page, pageSize) =>
    `vendor:reviews:${vendorId}:${page}:${pageSize}`,

  VENDOR_REVIEW_COUNT: (vendorId) => `vendor:reviews:count:${vendorId}`,
};
