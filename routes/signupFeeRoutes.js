const express = require("express");
const controller = require("../controller/signupFeeController");
const isAdmin = require("../middleware/is_admin");

const router = express.Router();

router.get("/signup-fees", controller.getPublicSignupFees);

router.get("/admin/signup-fees", isAdmin, controller.getAdminSignupFees);

router.put("/admin/signup-fees", isAdmin, controller.updateAdminSignupFees);

module.exports = router;
