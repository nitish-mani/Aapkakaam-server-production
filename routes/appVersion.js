const express = require("express");

const controller = require("../controller/appVersion");

const router = express.Router();

/**
 * ============================================================
 * PUBLIC VERSION CHECK
 * ============================================================
 *
 * GET /api/app-version/check
 *
 * Example:
 * /api/app-version/check?platform=android&version=1.0.1
 *
 * No authentication required.
 */
router.get("/check", controller.checkVersion);

/**
 * ============================================================
 * PUBLIC ANALYTICS EVENT
 * ============================================================
 *
 * POST /api/app-version/event
 *
 * Used by Flutter to record:
 *
 * - update_click
 *
 * version_check is recorded automatically
 * by controller.checkVersion().
 */
router.post("/event", controller.recordEvent);

/**
 * ============================================================
 * APK DOWNLOAD
 * ============================================================
 *
 * GET /api/app-version/download/:platform/:version
 *
 * Example:
 *
 * /api/app-version/download/android/1.0.2
 *
 * Backend:
 *
 * 1. Records APK download
 * 2. Redirects to Cloudflare R2 APK URL
 */
router.get("/download/:platform/:version", controller.downloadApk);

module.exports = router;
