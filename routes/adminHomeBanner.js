const express = require("express");
const is_admin = require("../middleware/is_admin");

const { getAdminHomeBanner, updateAdminHomeBanner } = require("../controller/homeBanner");

const router = express.Router();

router.get("/", is_admin, getAdminHomeBanner);
router.put("/", is_admin, updateAdminHomeBanner);

module.exports = router;
