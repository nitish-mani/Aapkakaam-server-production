const express = require("express");

const {
  getAdminMaintenance,
  updateAdminMaintenance,
} = require("../controller/websiteMaintenanceController");

const router = express.Router();

// Replace this with your existing admin JWT middleware
const adminAuth = require("../middleware/is_admin");

router.get("/", adminAuth, getAdminMaintenance);

router.put("/", adminAuth, updateAdminMaintenance);

module.exports = router;
