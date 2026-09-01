const WebsiteMaintenance = require("../models/WebsiteMaintenance");
const { isMaintenanceActive } = require("../src/utils/websiteMaintenance");

const getSettings = async () => {
  let settings = await WebsiteMaintenance.findOne();

  if (!settings) {
    settings = await WebsiteMaintenance.create({});
  }

  return settings;
};

const getPublicMaintenance = async (req, res) => {
  try {
    const settings = await getSettings();

    const active = isMaintenanceActive(settings, new Date());

    return res.status(200).json({
      success: true,
      maintenance: {
        active,

        title: settings.title,
        subtitle: settings.subtitle,
        message: settings.message,

        hindiTitle: settings.hindiTitle,
        hindiSubtitle: settings.hindiSubtitle,
        hindiMessage: settings.hindiMessage,
      },
    });
  } catch (error) {
    console.error("Website maintenance check error:", error);

    // Fail open
    return res.status(200).json({
      success: true,
      maintenance: {
        active: false,
      },
    });
  }
};

const getAdminMaintenance = async (req, res) => {
  try {
    const settings = await getSettings();

    const active = isMaintenanceActive(settings, new Date());

    return res.status(200).json({
      success: true,
      settings,
      active,
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      success: false,
      message: "Unable to fetch maintenance settings",
    });
  }
};

const updateAdminMaintenance = async (req, res) => {
  try {
    const allowedFields = [
      "mode",
      "scheduleEnabled",
      "startDay",
      "startTime",
      "endDay",
      "endTime",
      "title",
      "subtitle",
      "message",
      "hindiTitle",
      "hindiSubtitle",
      "hindiMessage",
    ];

    const update = {};

    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        update[field] = req.body[field];
      }
    }

    if (req.user?._id) {
      update.updatedBy = req.user._id;
    }

    const settings = await WebsiteMaintenance.findOneAndUpdate(
      {},
      { $set: update },
      {
        new: true,
        upsert: true,
        runValidators: true,
        setDefaultsOnInsert: true,
      },
    );

    const active = isMaintenanceActive(settings, new Date());

    return res.status(200).json({
      success: true,
      message: "Maintenance settings updated",
      active,
      settings,
    });
  } catch (error) {
    console.error("Website maintenance update error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to update maintenance settings",
    });
  }
};

module.exports = {
  getPublicMaintenance,
  getAdminMaintenance,
  updateAdminMaintenance,
};
