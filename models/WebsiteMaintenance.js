const mongoose = require("mongoose");

const websiteMaintenanceSchema = new mongoose.Schema(
  {
    // Master control
    mode: {
      type: String,
      enum: ["auto", "on", "off"],
      default: "auto",
      required: true,
    },

    // Automatic schedule
    scheduleEnabled: {
      type: Boolean,
      default: true,
    },

    startDay: {
      type: Number,
      default: 6, // Saturday
      min: 0,
      max: 6,
    },

    startTime: {
      type: String,
      default: "12:00",
    },

    endDay: {
      type: Number,
      default: 0, // Sunday
      min: 0,
      max: 6,
    },

    endTime: {
      type: String,
      default: "02:00",
    },

    // UI content
    title: {
      type: String,
      default: "We'll Be Back Soon",
      trim: true,
    },

    subtitle: {
      type: String,
      default: "We are improving something better for you.",
      trim: true,
    },

    message: {
      type: String,
      default:
        "AapkaKaam is temporarily unavailable while we perform scheduled maintenance. Please try again later.",
      trim: true,
    },

    // Optional bilingual content
    hindiTitle: {
      type: String,
      default: "हम जल्द वापस आएंगे",
      trim: true,
    },

    hindiSubtitle: {
      type: String,
      default: "हम आपके लिए कुछ बेहतर बना रहे हैं",
      trim: true,
    },

    hindiMessage: {
      type: String,
      default: "AapkaKaam पर रखरखाव का काम चल रहा है। कृपया कुछ समय बाद दोबारा प्रयास करें।",
      trim: true,
    },

    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

module.exports = mongoose.model("WebsiteMaintenance", websiteMaintenanceSchema);
