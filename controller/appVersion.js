const AppVersion = require("../models/appVersion");
const AppVersionEvent = require("../models/appVersionEvent");

const { compareVersions } = require("../src/utils/compareVersions");

const PLATFORMS = ["android", "ios"];

const EVENT_TYPES = ["version_check", "update_click", "apk_download"];

/* ============================================================
 * HELPERS
 * ========================================================== */

/**
 * Normalize platform.
 */
function getPlatform(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

/**
 * Clean string safely.
 */
function cleanString(value, fallback = "") {
  if (value === undefined || value === null) {
    return fallback;
  }

  return String(value).trim();
}

/**
 * Normalize event type.
 */
function getEventType(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

/**
 * Validate semantic version.
 *
 * Valid:
 * 1.0.0
 * 2.5.0
 * 2.10.3
 *
 * Invalid:
 * 1
 * 1.0
 * abc
 * 2.x.0
 */
function isValidVersion(version) {
  return /^\d+\.\d+\.\d+$/.test(version);
}

/* ============================================================
 * PUBLIC
 * GET /api/app-version/check
 *
 * Example:
 * /api/app-version/check?platform=android&version=1.0.1
 *
 * Authentication is NOT required.
 * ========================================================== */

exports.checkVersion = async (req, res, next) => {
  try {
    const platform = getPlatform(req.query.platform);

    const currentVersion = cleanString(req.query.version);

    /* ---------- Validate platform ---------- */

    if (!PLATFORMS.includes(platform)) {
      return res.status(400).json({
        success: false,
        message: "platform must be android or ios",
      });
    }

    /* ---------- Validate version ---------- */

    if (!currentVersion) {
      return res.status(400).json({
        success: false,
        message: "version is required",
      });
    }

    if (!isValidVersion(currentVersion)) {
      return res.status(400).json({
        success: false,
        message: "version must use the format x.y.z",
      });
    }

    /* ---------- Find active configuration ---------- */

    const config = await AppVersion.findOne({
      platform,
      enabled: true,
    }).lean();

    /*
     * Record version check.
     *
     * Analytics must NEVER break the version API.
     */
    AppVersionEvent.create({
      platform,
      version: currentVersion,
      type: "version_check",
    }).catch((error) => {
      console.error("Unable to record version check:", error);
    });

    /*
     * If admin has not configured this platform,
     * NEVER block the app.
     */
    if (!config) {
      return res.status(200).json({
        success: true,
        updateAvailable: false,
        forceUpdate: false,
        maintenanceMode: false,

        latestVersion: currentVersion,
        minimumVersion: currentVersion,

        updateTitle: "",
        updateMessage: "",
        updateUrl: "",
      });
    }

    /* ---------- Version comparison ---------- */

    const belowMinimum = compareVersions(currentVersion, config.minimumVersion) < 0;

    const newerAvailable = compareVersions(currentVersion, config.latestVersion) < 0;

    /* ---------- Response ---------- */

    return res.status(200).json({
      success: true,

      updateAvailable: newerAvailable,

      /*
       * Mandatory update when:
       *
       * 1. Current version < minimum version
       *
       * OR
       *
       * 2. Admin enabled forceUpdate
       */
      forceUpdate: belowMinimum || config.forceUpdate === true,

      maintenanceMode: config.maintenanceMode === true,

      latestVersion: config.latestVersion,

      minimumVersion: config.minimumVersion,

      updateTitle: config.updateTitle,

      updateMessage: config.updateMessage,

      updateUrl: config.updateUrl,
    });
  } catch (error) {
    console.error("App version check error:", error);

    return next(error);
  }
};

/* ============================================================
 * PUBLIC
 * POST /api/app-version/event
 *
 * Used by Flutter for:
 *
 * update_click
 *
 * version_check is recorded automatically by checkVersion().
 * ========================================================== */

exports.recordEvent = async (req, res, next) => {
  try {
    const platform = getPlatform(req.body.platform);

    const version = cleanString(req.body.version);

    const type = getEventType(req.body.type);

    /* ---------- Validate platform ---------- */

    if (!PLATFORMS.includes(platform)) {
      return res.status(400).json({
        success: false,
        message: "platform must be android or ios",
      });
    }

    /* ---------- Validate version ---------- */

    if (!version) {
      return res.status(400).json({
        success: false,
        message: "version is required",
      });
    }

    if (!isValidVersion(version)) {
      return res.status(400).json({
        success: false,
        message: "version must use the format x.y.z",
      });
    }

    /* ---------- Validate event ---------- */

    if (!EVENT_TYPES.includes(type)) {
      return res.status(400).json({
        success: false,
        message: "Invalid event type",
      });
    }

    /*
     * version_check is generated automatically
     * by checkVersion().
     */
    if (type === "version_check") {
      return res.status(400).json({
        success: false,
        message: "version_check is recorded automatically",
      });
    }

    /* ---------- Save event ---------- */

    await AppVersionEvent.create({
      platform,
      version,
      type,
    });

    return res.status(200).json({
      success: true,
      message: "Event recorded",
    });
  } catch (error) {
    console.error("Record app version event error:", error);

    /*
     * Analytics should not cause unexpected
     * server errors for the Flutter application.
     */
    return next(error);
  }
};

/* ============================================================
 * PUBLIC
 * GET /api/app-version/download/:platform/:version
 *
 * Example:
 *
 * /api/app-version/download/android/1.0.2
 *
 * Flow:
 *
 * Flutter
 *   ↓
 * Backend
 *   ↓
 * Record APK download
 *   ↓
 * Redirect
 *   ↓
 * Cloudflare R2
 * ========================================================== */

exports.downloadApk = async (req, res, next) => {
  try {
    const platform = getPlatform(req.params.platform);

    const version = cleanString(req.params.version);

    /* ---------- Validate platform ---------- */

    if (!PLATFORMS.includes(platform)) {
      return res.status(400).json({
        success: false,
        message: "platform must be android or ios",
      });
    }

    /* ---------- Validate version ---------- */

    if (!version) {
      return res.status(400).json({
        success: false,
        message: "version is required",
      });
    }

    if (!isValidVersion(version)) {
      return res.status(400).json({
        success: false,
        message: "version must use the format x.y.z",
      });
    }

    /* ---------- Find configuration ---------- */

    const config = await AppVersion.findOne({
      platform,
      enabled: true,
    }).lean();

    if (!config) {
      return res.status(404).json({
        success: false,
        message: "App version configuration not found",
      });
    }

    if (!config.updateUrl) {
      return res.status(404).json({
        success: false,
        message: "Update URL is not configured",
      });
    }

    /*
     * Only Android APK downloads should use
     * this endpoint.
     */
    if (platform !== "android") {
      return res.status(400).json({
        success: false,
        message: "APK download is only available for Android",
      });
    }

    /*
     * Record download event.
     */
    AppVersionEvent.create({
      platform,
      version,
      type: "apk_download",
    }).catch((error) => {
      console.error("Unable to record APK download:", error);
    });

    /*
     * Redirect to Cloudflare R2 URL.
     */
    return res.redirect(302, config.updateUrl);
  } catch (error) {
    console.error("APK download error:", error);

    return next(error);
  }
};

/* ============================================================
 * ADMIN
 * GET /api/admin/app-versions
 * ========================================================== */

exports.getVersions = async (req, res, next) => {
  try {
    const versions = await AppVersion.find()
      .sort({
        platform: 1,
      })
      .lean();

    return res.status(200).json({
      success: true,
      versions,
    });
  } catch (error) {
    console.error("Get app versions error:", error);

    return next(error);
  }
};

/* ============================================================
 * ADMIN
 * PUT /api/admin/app-versions/:platform
 *
 * Example:
 *
 * PUT /api/admin/app-versions/android
 * ========================================================== */

exports.upsertVersion = async (req, res, next) => {
  try {
    /* ---------- Platform ---------- */

    const platform = getPlatform(req.params.platform);

    if (!PLATFORMS.includes(platform)) {
      return res.status(400).json({
        success: false,
        message: "platform must be android or ios",
      });
    }

    /* ---------- Versions ---------- */

    const latestVersion = cleanString(req.body.latestVersion);

    const minimumVersion = cleanString(req.body.minimumVersion);

    /* ---------- Required fields ---------- */

    if (!latestVersion || !minimumVersion) {
      return res.status(400).json({
        success: false,
        message: "latestVersion and minimumVersion are required",
      });
    }

    /* ---------- Version format ---------- */

    if (!isValidVersion(latestVersion) || !isValidVersion(minimumVersion)) {
      return res.status(400).json({
        success: false,
        message: "Version must use the format x.y.z, for example 2.5.0",
      });
    }

    /* ---------- Version relationship ---------- */

    if (compareVersions(latestVersion, minimumVersion) < 0) {
      return res.status(400).json({
        success: false,
        message: "latestVersion cannot be lower than minimumVersion",
      });
    }

    /* ---------- Update object ---------- */

    const update = {
      platform,

      latestVersion,

      minimumVersion,

      forceUpdate: req.body.forceUpdate === true,

      maintenanceMode: req.body.maintenanceMode === true,

      updateTitle: cleanString(req.body.updateTitle, "Update Available"),

      updateMessage: cleanString(
        req.body.updateMessage,
        "A new version of AapkaKaam is available. Please update the app.",
      ),

      updateUrl: cleanString(req.body.updateUrl),

      enabled: req.body.enabled !== false,
    };

    /* ---------- Android URL validation ---------- */

    if (platform === "android" && update.updateUrl) {
      try {
        const url = new URL(update.updateUrl);

        if (!["http:", "https:"].includes(url.protocol)) {
          return res.status(400).json({
            success: false,
            message: "updateUrl must be a valid HTTP or HTTPS URL",
          });
        }
      } catch {
        return res.status(400).json({
          success: false,
          message: "updateUrl must be a valid HTTP or HTTPS URL",
        });
      }
    }

    /* ---------- Create/update ---------- */

    const saved = await AppVersion.findOneAndUpdate(
      {
        platform,
      },
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

    /* ---------- Logging ---------- */

    req.log?.info?.(
      {
        platform,
        latestVersion,
        minimumVersion,
        forceUpdate: update.forceUpdate,
        maintenanceMode: update.maintenanceMode,
      },
      "App version settings updated",
    );

    /* ---------- Response ---------- */

    return res.status(200).json({
      success: true,

      message: `${platform.toUpperCase()} app version settings saved successfully`,

      version: saved,
    });
  } catch (error) {
    console.error("Update app version error:", error);

    return next(error);
  }
};

/* ============================================================
 * ADMIN
 * GET /api/admin/app-versions/analytics
 *
 * Optional:
 *
 * /analytics?platform=android
 * ========================================================== */

exports.getAnalytics = async (req, res, next) => {
  try {
    const platformParam = getPlatform(req.query.platform);

    const match = {};

    /* ---------- Optional platform filter ---------- */

    if (platformParam) {
      if (!PLATFORMS.includes(platformParam)) {
        return res.status(400).json({
          success: false,
          message: "platform must be android or ios",
        });
      }

      match.platform = platformParam;
    }

    /* ---------- Total events ---------- */

    const totals = await AppVersionEvent.aggregate([
      {
        $match: match,
      },

      {
        $group: {
          _id: "$type",

          count: {
            $sum: 1,
          },
        },
      },
    ]);

    const totalMap = {
      version_check: 0,
      update_click: 0,
      apk_download: 0,
    };

    for (const item of totals) {
      if (Object.prototype.hasOwnProperty.call(totalMap, item._id)) {
        totalMap[item._id] = item.count;
      }
    }

    /* ---------- Version distribution ---------- */

    const versions = await AppVersionEvent.aggregate([
      {
        $match: {
          ...match,
          type: "version_check",
        },
      },

      {
        $group: {
          _id: {
            platform: "$platform",

            version: "$version",
          },

          checks: {
            $sum: 1,
          },
        },
      },

      {
        $sort: {
          checks: -1,
        },
      },
    ]);

    const totalChecks = versions.reduce((sum, item) => sum + item.checks, 0);

    const versionDistribution = versions.map((item) => ({
      platform: item._id.platform,

      version: item._id.version,

      checks: item.checks,

      percentage: totalChecks > 0 ? Number(((item.checks / totalChecks) * 100).toFixed(2)) : 0,
    }));

    /* ---------- Response ---------- */

    return res.status(200).json({
      success: true,

      summary: {
        versionChecks: totalMap.version_check,

        updateClicks: totalMap.update_click,

        apkDownloads: totalMap.apk_download,
      },

      versions: versionDistribution,
    });
  } catch (error) {
    console.error("Get app version analytics error:", error);

    return next(error);
  }
};
