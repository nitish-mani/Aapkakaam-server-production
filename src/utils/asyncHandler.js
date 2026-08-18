/**
 * Async handler to eliminate try-catch boilerplate
 * Automatically catches errors and passes to Express error handler
 */
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

module.exports = asyncHandler;
