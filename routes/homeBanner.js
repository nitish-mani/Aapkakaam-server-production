const express = require("express");
const { getPublicHomeBanner } = require("../controller/homeBanner");

const router = express.Router();

router.get("/", getPublicHomeBanner);

module.exports = router;
