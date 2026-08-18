const express = require("express");

const router = express.Router();
const is_user = require("../middleware/is_user");
const is_vendor = require("../middleware/is_vendor");

const authenticate = require("../middleware/authenticate");
const share_controller = require("../controller/share");

router.post("/postU", authenticate, is_user, share_controller.share_controller_post);
router.post("/postV", authenticate, is_vendor, share_controller.share_controller_post);

router.get("/getU", authenticate, is_user, share_controller.share_controller_get);
router.get("/getV", authenticate, is_vendor, share_controller.share_controller_get);

module.exports = router;
