const express = require("express");

const router = express.Router();
const is_user = require("../middleware/is_user");
const is_vendor = require("../middleware/is_vendor");
const authenticate = require("../middleware/authenticate");

const bookings_controller = require("../controller/bookings");

router.post(
  "/postToBookingsU",
  authenticate,
  is_user,
  bookings_controller.bookings_controller_postU,
);
router.post(
  "/postToBookingsV",
  authenticate,
  is_vendor,
  bookings_controller.bookings_controller_postV,
);

router.get(
  "/getOrdersU/:userId/:pageNo",
  authenticate,
  is_user,
  bookings_controller.bookings_controller_getU,
);

router.get(
  "/getOrdersV/:userId/:pageNo",
  authenticate,
  is_vendor,
  bookings_controller.bookings_controller_getV,
);

router.patch(
  "/cancelOrderU",
  authenticate,
  is_user,
  bookings_controller.bookings_controller_cancelU,
);
router.patch(
  "/cancelOrderV",
  authenticate,
  is_vendor,
  bookings_controller.bookings_controller_cancelV,
);

router.patch(
  "/orderCompletedU",
  authenticate,
  is_user,
  bookings_controller.bookings_controller_completeU,
);
router.patch(
  "/orderCompletedV",
  authenticate,
  is_vendor,
  bookings_controller.bookings_controller_completeV,
);

router.patch("/ratingU", authenticate, is_user, bookings_controller.bookings_controller_ratingU);
router.patch("/ratingV", authenticate, is_vendor, bookings_controller.bookings_controller_ratingV);

router.get(
  "/getReviewsU/:userId/:vendorId/:pageNo",
  authenticate,
  is_user,
  bookings_controller.bookings_controller_getReviewsU,
);
router.get(
  "/getReviewsV/:vendorUserId/:vendorId/:pageNo",
  authenticate,
  is_vendor,
  bookings_controller.bookings_controller_getReviewsV,
);

module.exports = router;
