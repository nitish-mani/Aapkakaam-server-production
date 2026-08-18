const express = require("express");
const router = express.Router();

const { body, param, query } = require("express-validator");

const concernController = require("../controller/concern");
const authenticate = require("../middleware/authenticate");
const is_admin = require("../middleware/is_admin");

// ============================================================
// USER / VENDOR ROUTES
// Base path: /api/concerns
// ============================================================

// Create concern
// POST /api/concerns
router.post(
  "/",
  authenticate,
  [
    body("category")
      .isIn([
        "booking_issue",
        "payment_issue",
        "refund_issue",
        "vendor_issue",
        "user_issue",
        "technical_issue",
        "account_issue",
        "dispute",
        "cancellation",
        "other",
      ])
      .withMessage("Invalid category"),

    body("subject")
      .notEmpty()
      .withMessage("Subject is required")
      .isLength({ max: 200 })
      .withMessage("Subject cannot exceed 200 characters"),

    body("description")
      .notEmpty()
      .withMessage("Description is required")
      .isLength({ max: 5000 })
      .withMessage("Description cannot exceed 5000 characters"),

    body("priority")
      .optional()
      .isIn(["Low", "Medium", "High", "Urgent"])
      .withMessage("Invalid priority level"),

    body("attachments").optional().isArray().withMessage("Attachments must be an array"),
  ],
  concernController.createConcern,
);

// Get logged-in user's concerns
// GET /api/concerns
router.get(
  "/",
  authenticate,
  [
    query("status")
      .optional()
      .isIn(["Open", "InProgress", "Resolved", "Rejected", "Closed"])
      .withMessage("Invalid status"),

    query("category")
      .optional()
      .isIn([
        "booking_issue",
        "payment_issue",
        "refund_issue",
        "vendor_issue",
        "user_issue",
        "technical_issue",
        "account_issue",
        "dispute",
        "cancellation",
        "other",
      ])
      .withMessage("Invalid category"),

    query("priority")
      .optional()
      .isIn(["Low", "Medium", "High", "Urgent"])
      .withMessage("Invalid priority"),

    query("raisedBy").optional().isIn(["User", "Vendor"]).withMessage("Invalid raisedBy value"),

    query("page").optional().isInt({ min: 1 }).toInt(),

    query("limit").optional().isInt({ min: 1, max: 100 }).toInt(),
  ],
  concernController.getMyConcerns,
);

// Get single concern (own concern)
// GET /api/concerns/:concernId
router.get(
  "/:concernId",
  authenticate,
  [param("concernId").isMongoId().withMessage("Invalid concern ID")],
  concernController.getConcernById,
);

// ============================================================
// ADMIN ROUTES
// ============================================================

// Get all concerns (Admin only)
// GET /api/concerns/admin/all
router.get(
  "/admin/all",
  authenticate,
  is_admin,
  [
    query("status")
      .optional()
      .isIn(["Open", "InProgress", "Resolved", "Rejected", "Closed"])
      .withMessage("Invalid status"),

    query("category")
      .optional()
      .isIn([
        "booking_issue",
        "payment_issue",
        "refund_issue",
        "vendor_issue",
        "user_issue",
        "technical_issue",
        "account_issue",
        "dispute",
        "cancellation",
        "other",
      ])
      .withMessage("Invalid category"),

    query("priority")
      .optional()
      .isIn(["Low", "Medium", "High", "Urgent"])
      .withMessage("Invalid priority"),

    query("raisedBy").optional().isIn(["User", "Vendor"]).withMessage("Invalid raisedBy value"),

    query("page").optional().isInt({ min: 1 }).toInt(),

    query("limit").optional().isInt({ min: 1, max: 100 }).toInt(),
  ],
  concernController.getAllConcerns,
);

// Get single concern (Admin only)
// GET /api/concerns/admin/:concernId
router.get(
  "/admin/:concernId",
  authenticate,
  is_admin,
  [param("concernId").isMongoId().withMessage("Invalid concern ID")],
  concernController.getConcernByIdAdmin,
);

// Update concern status (Admin only)
// PUT /api/concerns/admin/:concernId/status
router.put(
  "/admin/:concernId/status",
  authenticate,
  is_admin,
  [
    param("concernId").isMongoId().withMessage("Invalid concern ID"),

    body("status")
      .isIn(["Open", "InProgress", "Resolved", "Rejected", "Closed"])
      .withMessage("Invalid status"),

    body("adminResponse")
      .optional()
      .isLength({ max: 2000 })
      .withMessage("Admin response cannot exceed 2000 characters"),
  ],
  concernController.updateConcernStatus,
);

// Delete concern (Admin only)
// DELETE /api/concerns/admin/:concernId
router.delete(
  "/admin/:concernId",
  authenticate,
  is_admin,
  [param("concernId").isMongoId().withMessage("Invalid concern ID")],
  concernController.deleteConcern,
);

module.exports = router;
