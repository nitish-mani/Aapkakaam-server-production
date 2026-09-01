const mongoose = require("mongoose");

const appVersionEventSchema = new mongoose.Schema(
  {
    platform: {
      type: String,
      enum: ["android", "ios"],
      required: true,
      index: true,
    },

    version: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },

    type: {
      type: String,
      enum: ["version_check", "update_click", "apk_download"],
      required: true,
      index: true,
    },

    createdAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
  },
  {
    versionKey: false,
  },
);

module.exports =
  mongoose.models.AppVersionEvent || mongoose.model("AppVersionEvent", appVersionEventSchema);
