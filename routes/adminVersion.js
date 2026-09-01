const express = require("express");
const is_admin = require("../middleware/is_admin");
const controller = require("../controller/appVersion");

const router = express.Router();

/**
 * GET
 * /api/admin/app-versions
 *
 * Get Android + iOS version settings
 */
router.get("/", is_admin, controller.getVersions);

/**
 * GET
 * /api/admin/app-versions/analytics
 *
 * Get:
 * - version checks
 * - update clicks
 * - APK downloads
 * - installed version distribution
 */
router.get("/analytics", is_admin, controller.getAnalytics);

/**
 * PUT
 * /api/admin/app-versions/android
 *
 * PUT /api/admin/app-versions/ios
 *
 * Create or update platform version settings
 */
router.put("/:platform", is_admin, controller.upsertVersion);

module.exports = router;
