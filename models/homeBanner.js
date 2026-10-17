const mongoose = require("mongoose");

const homeBannerSchema = new mongoose.Schema(
  {
    imageUrl: {
      type: String,
      default: "",
      trim: true,
      maxlength: 2048,
    },
    enabled: {
      type: Boolean,
      default: false,
    },
    clickUrl: {
      type: String,
      default: "",
      trim: true,
      maxlength: 2048,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admin",
      default: null,
    },
  },
  { timestamps: true },
);

module.exports = mongoose.model("HomeBanner", homeBannerSchema);
