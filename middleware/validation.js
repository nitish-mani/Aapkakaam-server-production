/**
 * Validate payment request
 */
const validatePaymentRequest = (req, res, next) => {
  const { amount, userId, vendorId, discount, discountPercent } = req.body;

  // Validate amount
  if (amount !== undefined) {
    if (typeof amount !== "number" || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid amount. Amount must be a positive number",
      });
    }
    if (amount > 1000000) {
      return res.status(400).json({
        success: false,
        message: "Amount exceeds maximum limit of 1,000,000",
      });
    }
  }

  // Validate userId or vendorId
  if (!userId && !vendorId) {
    return res.status(400).json({
      success: false,
      message: "Either userId or vendorId is required",
    });
  }

  // Validate discount
  if (discount !== undefined) {
    if (typeof discount !== "number" || discount < 0) {
      return res.status(400).json({
        success: false,
        message: "Discount must be a positive number",
      });
    }
  }

  // Validate discountPercent
  if (discountPercent !== undefined) {
    if (typeof discountPercent !== "number" || discountPercent < 0 || discountPercent > 100) {
      return res.status(400).json({
        success: false,
        message: "Discount percentage must be between 0 and 100",
      });
    }
  }

  next();
};

module.exports = { validatePaymentRequest };
