const { body, param, validationResult } = require("express-validator");

const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      message: "Validation failed",
      errors: errors.array().map((e) => e.msg),
    });
  }
  next();
};

exports.validateUserId = [
  param("userId").isMongoId().withMessage("Valid userId required"),
  handleValidationErrors,
];

exports.validateEmail = [
  body("email").isEmail().withMessage("Valid email required"),
  handleValidationErrors,
];

exports.validatePhone = [
  body("phoneNo")
    .isLength({ min: 10, max: 10 })
    .withMessage("Valid 10-digit phone number required"),
  handleValidationErrors,
];

exports.validateOtp = [
  body("otpId").isMongoId().withMessage("Valid OTP ID required"),
  handleValidationErrors,
];

exports.validatePassword = [
  body("password")
    .isLength({ min: 6 })
    .withMessage("Password must be at least 6 characters"),
  handleValidationErrors,
];

exports.validateAddress = [
  body("userId").isMongoId().withMessage("Valid userId required"),
  body("pincode")
    .isLength({ min: 6, max: 6 })
    .withMessage("Valid pincode required"),
  handleValidationErrors,
];

exports.validateName = [
  body("userId").isMongoId().withMessage("Valid userId required"),
  body("name").notEmpty().withMessage("Name is required"),
  handleValidationErrors,
];

exports.validatePagination = [
  param("pageNo")
    .optional()
    .isInt({ min: 1 })
    .withMessage("Page must be a positive integer"),
  handleValidationErrors,
];
