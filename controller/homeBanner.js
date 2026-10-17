const mongoose = require("mongoose");
const HomeBanner = require("../models/homeBanner");

const getSettings = async () => {
  let settings = await HomeBanner.findOne();

  if (!settings) {
    settings = await HomeBanner.create({});
  }

  return settings;
};

// Public API: only return an enabled banner.
const getPublicHomeBanner = async (req, res) => {
  try {
    const settings = await getSettings();

    return res.status(200).json({
      success: true,
      banner: {
        enabled: settings.enabled === true,
        imageUrl: settings.enabled === true ? settings.imageUrl : "",
        clickUrl: settings.enabled === true ? settings.clickUrl : "",
      },
    });
  } catch (error) {
    console.error("Public home banner error:", error);

    // Banner failure must not block the home page.
    return res.status(200).json({
      success: true,
      banner: { enabled: false, imageUrl: "" },
    });
  }
};

// Admin API: retrieve current configuration.
const getAdminHomeBanner = async (req, res) => {
  try {
    const settings = await getSettings();

    return res.status(200).json({
      success: true,
      settings,
    });
  } catch (error) {
    console.error("Get home banner error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to fetch home banner settings",
    });
  }
};

// Admin API: update image URL and enable/disable.
const updateAdminHomeBanner = async (req, res) => {
  try {
    const { imageUrl, enabled, clickUrl } = req.body;

    if (imageUrl !== undefined && (typeof imageUrl !== "string" || imageUrl.length > 2048)) {
      return res.status(400).json({
        success: false,
        message: "Invalid image URL",
      });
    }

    if (enabled !== undefined && typeof enabled !== "boolean") {
      return res.status(400).json({
        success: false,
        message: "enabled must be a boolean",
      });
    }

    const update = {};

    if (imageUrl !== undefined) {
      const url = imageUrl.trim();

      if (url) {
        let parsed;

        try {
          parsed = new URL(url);
        } catch {
          return res.status(400).json({
            success: false,
            message: "Please enter a valid image URL",
          });
        }

        if (parsed.protocol !== "https:") {
          return res.status(400).json({
            success: false,
            message: "Image URL must use HTTPS",
          });
        }
      }

      update.imageUrl = url;
    }
    if (clickUrl !== undefined) {
      if (typeof clickUrl !== "string" || clickUrl.length > 2048) {
        return res.status(400).json({
          success: false,
          message: "Invalid click URL",
        });
      }

      const url = clickUrl.trim();

      if (url) {
        try {
          const parsed = new URL(url);

          if (parsed.protocol !== "https:") {
            return res.status(400).json({
              success: false,
              message: "Click URL must use HTTPS",
            });
          }
        } catch {
          return res.status(400).json({
            success: false,
            message: "Please enter a valid click URL",
          });
        }
      }

      update.clickUrl = url;
    }

    if (enabled !== undefined) {
      update.enabled = enabled;
    }

    const existing = await HomeBanner.findOne().lean();
    const finalImageUrl =
      update.imageUrl !== undefined ? update.imageUrl : existing?.imageUrl || "";

    const finalEnabled = update.enabled !== undefined ? update.enabled : existing?.enabled === true;

    if (finalEnabled && !finalImageUrl) {
      return res.status(400).json({
        success: false,
        message: "Add an image URL before enabling the banner",
      });
    }

    if (req.user?._id && mongoose.isValidObjectId(req.user._id)) {
      update.updatedBy = req.user._id;
    }

    const settings = await HomeBanner.findOneAndUpdate(
      {},
      { $set: update },
      {
        new: true,
        upsert: true,
        runValidators: true,
        setDefaultsOnInsert: true,
      },
    );

    return res.status(200).json({
      success: true,
      message: "Home banner settings updated successfully",
      settings,
    });
  } catch (error) {
    console.error("Update home banner error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to update home banner settings",
    });
  }
};

module.exports = {
  getPublicHomeBanner,
  getAdminHomeBanner,
  updateAdminHomeBanner,
};
