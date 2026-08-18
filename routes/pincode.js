const express = require("express");

const router = express.Router();
const isAuthenticated = require("../middleware/authenticate");
const pincode_controller = require("../controller/pincode");

router.post("/getU",isAuthenticated, pincode_controller.pincode_controller);
router.post("/getV", isAuthenticated, pincode_controller.pincode_controller);

module.exports = router;
