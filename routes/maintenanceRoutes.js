const express = require("express");

const { getPublicMaintenance } = require("../controller/maintenance");

const router = express.Router();

router.get("/status", getPublicMaintenance);

module.exports = router;
