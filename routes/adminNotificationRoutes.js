"use strict";

const express = require("express");

const { sendAdminLinkNotification } = require("../controller/adminNotificationController");

const requireAdmin = require("../middleware/is_admin");

const router = express.Router();

router.post("/notifications/send", requireAdmin, sendAdminLinkNotification);

module.exports = router;
