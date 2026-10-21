"use strict";

const express = require("express");
const router = express.Router();

const { getVendorSearchAnalytics } = require("../controller/vendorSearchAnalytics");

// Replace with your existing admin authentication middleware.
// Do not expose this analytics endpoint publicly.
const isAdmin = require("../middleware/is_admin");

router.get("/", isAdmin, getVendorSearchAnalytics);

module.exports = router;
