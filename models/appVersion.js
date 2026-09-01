const mongoose = require("mongoose");

const appVersionSchema = new mongoose.Schema(
  {
    platform: {
      type: String,
      enum: ["android", "ios"],
      required: true,
      unique: true,
      index: true,
    },

    latestVersion: {
      type: String,
      required: true,
      trim: true,
    },

    minimumVersion: {
      type: String,
      required: true,
      trim: true,
    },

    forceUpdate: {
      type: Boolean,
      default: false,
    },

    maintenanceMode: {
      type: Boolean,
      default: false,
    },

    updateTitle: {
      type: String,
      default: "Update Available",
      trim: true,
      maxlength: 120,
    },

    updateMessage: {
      type: String,
      default: "A new version of AapkaKaam is available. Please update the app.",
      trim: true,
      maxlength: 500,
    },

    updateUrl: {
      type: String,
      default: "",
      trim: true,
      maxlength: 1000,
    },

    enabled: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  },
);

module.exports = mongoose.models.AppVersion || mongoose.model("AppVersion", appVersionSchema);
