const maintenance = require("../models/maintenance");

const { getMaintenanceStatus } = require("../src/utils/maintenance");

/**
 * ============================================================
 * GET OR CREATE SINGLETON SETTINGS
 * ============================================================
 */

const getSettings = async () => {
  let settings = await maintenance.findOne();

  if (!settings) {
    settings = await maintenance.create({});
  }

  return settings;
};

/**
 * ============================================================
 * BUILD SAFE PUBLIC RESPONSE
 * ============================================================
 */

const buildPublicMaintenanceResponse = (settings, status) => {
  return {
    status: status.status,

    active: status.active,

    upcoming: status.upcoming,

    showBanner: status.showBanner,

    showMaintenancePage: status.showMaintenancePage,

    startDateTime: status.startDateTime,

    endDateTime: status.endDateTime,

    notificationStartTime: status.notificationStartTime,

    fullPageEnabled: settings.fullPageEnabled !== false,

    title: settings.title,

    subtitle: settings.subtitle,

    message: settings.message,

    hindiTitle: settings.hindiTitle,

    hindiSubtitle: settings.hindiSubtitle,

    hindiMessage: settings.hindiMessage,
  };
};

/**
 * ============================================================
 * PUBLIC
 *
 * GET /api/website-maintenance/status
 *
 * Optional:
 * ?platform=website
 * ?platform=android
 * ?platform=ios
 * ============================================================
 */

const getPublicMaintenance = async (req, res) => {
  try {
    const platform = String(req.query.platform || "website")
      .trim()
      .toLowerCase();

    const allowedPlatforms = ["website", "android", "ios"];

    if (!allowedPlatforms.includes(platform)) {
      return res.status(400).json({
        success: false,
        message: "platform must be website, android or ios",
      });
    }

    const settings = await getSettings();

    const status = getMaintenanceStatus(settings, new Date(), platform);

    return res.status(200).json({
      success: true,

      maintenance: buildPublicMaintenanceResponse(settings, status),
    });
  } catch (error) {
    console.error("Website maintenance check error:", error);

    /**
     * FAIL OPEN
     *
     * Maintenance API failure must never
     * block users from accessing the app.
     */
    return res.status(200).json({
      success: true,

      maintenance: {
        status: "inactive",

        active: false,

        upcoming: false,

        showBanner: false,

        showMaintenancePage: false,
      },
    });
  }
};

/**
 * ============================================================
 * ADMIN
 *
 * GET /api/admin/website-maintenance
 * ============================================================
 */

const getAdminMaintenance = async (req, res) => {
  try {
    const settings = await getSettings();

    const statuses = {
      website: getMaintenanceStatus(settings, new Date(), "website"),

      android: getMaintenanceStatus(settings, new Date(), "android"),

      ios: getMaintenanceStatus(settings, new Date(), "ios"),
    };

    return res.status(200).json({
      success: true,

      settings,

      status: statuses,
    });
  } catch (error) {
    console.error("Get maintenance settings error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to fetch maintenance settings",
    });
  }
};

/**
 * ============================================================
 * ADMIN
 *
 * PUT /api/admin/website-maintenance
 * ============================================================
 */

const updateAdminMaintenance = async (req, res) => {
  try {
    const allowedFields = [
      "mode",

      "maintenanceType",

      "startDateTime",
      "endDateTime",

      "notificationEnabled",
      "notifyBeforeMinutes",

      "showOnWebsite",
      "showOnAndroid",
      "showOnIOS",

      "fullPageEnabled",

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
      if (Object.prototype.hasOwnProperty.call(req.body, field)) {
        update[field] = req.body[field];
      }
    }

    /**
     * Validate scheduled dates.
     */
    const maintenanceType = update.maintenanceType;

    if (
      maintenanceType === "scheduled" ||
      (!maintenanceType && (update.startDateTime || update.endDateTime))
    ) {
      const existing = await maintenance.findOne().lean();

      const startValue =
        update.startDateTime !== undefined ? update.startDateTime : existing?.startDateTime;

      const endValue =
        update.endDateTime !== undefined ? update.endDateTime : existing?.endDateTime;

      if (startValue && endValue && new Date(endValue) <= new Date(startValue)) {
        return res.status(400).json({
          success: false,
          message: "Maintenance end date must be after the start date.",
        });
      }
    }

    /**
     * Record admin user.
     */
    if (req.user?._id) {
      update.updatedBy = req.user._id;
    }

    const settings = await maintenance.findOneAndUpdate(
      {},
      {
        $set: update,
      },
      {
        new: true,
        upsert: true,
        runValidators: true,
        setDefaultsOnInsert: true,
      },
    );

    const now = new Date();

    return res.status(200).json({
      success: true,

      message: "Maintenance settings updated successfully",

      settings,

      status: {
        website: getMaintenanceStatus(settings, now, "website"),

        android: getMaintenanceStatus(settings, now, "android"),

        ios: getMaintenanceStatus(settings, now, "ios"),
      },
    });
  } catch (error) {
    console.error("Website maintenance update error:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Unable to update maintenance settings",
    });
  }
};

module.exports = {
  getPublicMaintenance,

  getAdminMaintenance,

  updateAdminMaintenance,
};
