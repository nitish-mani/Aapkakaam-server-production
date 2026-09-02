// ============================================================
// routes/systemRoutes.js
// ============================================================

const express = require("express");

const router = express.Router();

const systemController =
  require("../controller/systemController");

const is_admin =
  require("../middleware/is_admin");

// ============================================================
// SYSTEM STATUS
// ============================================================

router.get(
  "/status",
  is_admin,
  systemController.getSystemStatus,
);

// ============================================================
// PM2 PROCESS RESTART
// ============================================================

router.post(
  "/restart/:processName",
  is_admin,
  systemController.restartPm2Process,
);

// ============================================================
// PM2 INSTANCE RESTART
// ============================================================

router.post(
  "/restart-instance/:processId",
  is_admin,
  systemController.restartPm2Instance,
);

module.exports = router;
