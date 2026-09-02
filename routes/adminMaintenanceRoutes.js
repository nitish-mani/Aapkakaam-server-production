const express = require("express");

const is_admin = require("../middleware/is_admin");

const { getAdminMaintenance, updateAdminMaintenance } = require("../controller/maintenance");

const router = express.Router();

router.get("/", is_admin, getAdminMaintenance);

router.put("/", is_admin, updateAdminMaintenance);

module.exports = router;
