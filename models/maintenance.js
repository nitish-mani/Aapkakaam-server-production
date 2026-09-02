const mongoose = require("mongoose");

const maintenanceSchema = new mongoose.Schema(
  {
    // ============================================================
    // MASTER CONTROL
    // ============================================================

    mode: {
      type: String,
      enum: ["auto", "on", "off"],
      default: "auto",
      required: true,
    },

    // ============================================================
    // SCHEDULE TYPE
    // ============================================================

    maintenanceType: {
      type: String,
      enum: ["scheduled", "recurring"],
      default: "scheduled",
    },

    // ============================================================
    // SPECIFIC DATE & TIME MAINTENANCE
    // ============================================================

    startDateTime: {
      type: Date,
      default: null,
    },

    endDateTime: {
      type: Date,
      default: null,
    },

    // ============================================================
    // ADVANCE NOTIFICATION
    // ============================================================

    notificationEnabled: {
      type: Boolean,
      default: true,
    },

    notifyBeforeMinutes: {
      type: Number,
      default: 1440,
      min: 0,
      max: 43200,
    },

    // ============================================================
    // PLATFORM TARGETING
    // ============================================================

    showOnWebsite: {
      type: Boolean,
      default: true,
    },

    showOnAndroid: {
      type: Boolean,
      default: true,
    },

    showOnIOS: {
      type: Boolean,
      default: true,
    },

    // ============================================================
    // FULL PAGE SETTINGS
    // ============================================================

    fullPageEnabled: {
      type: Boolean,
      default: true,
    },

    // ============================================================
    // RECURRING WEEKLY SCHEDULE
    // ============================================================

    scheduleEnabled: {
      type: Boolean,
      default: false,
    },

    startDay: {
      type: Number,
      default: 6,
      min: 0,
      max: 6,
    },

    startTime: {
      type: String,
      default: "12:00",
      trim: true,
    },

    endDay: {
      type: Number,
      default: 0,
      min: 0,
      max: 6,
    },

    endTime: {
      type: String,
      default: "02:00",
      trim: true,
    },

    // ============================================================
    // ENGLISH CONTENT
    // ============================================================

    title: {
      type: String,
      default: "Scheduled Maintenance",
      trim: true,
      maxlength: 150,
    },

    subtitle: {
      type: String,
      default: "We'll be back soon.",
      trim: true,
      maxlength: 250,
    },

    message: {
      type: String,
      default:
        "AapkaKaam is temporarily unavailable while we perform scheduled maintenance. Please try again later.",
      trim: true,
      maxlength: 2000,
    },

    // ============================================================
    // HINDI CONTENT
    // ============================================================

    hindiTitle: {
      type: String,
      default: "निर्धारित रखरखाव",
      trim: true,
      maxlength: 150,
    },

    hindiSubtitle: {
      type: String,
      default: "हम जल्द ही वापस आएंगे।",
      trim: true,
      maxlength: 250,
    },

    hindiMessage: {
      type: String,
      default: "AapkaKaam पर रखरखाव का कार्य चल रहा है। कृपया कुछ समय बाद दोबारा प्रयास करें।",
      trim: true,
      maxlength: 2000,
    },

    // ============================================================
    // ADMIN INFORMATION
    // ============================================================

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

// ============================================================
// VALIDATION
// ============================================================

maintenanceSchema.pre("validate", function (next) {
  if (
    this.maintenanceType === "scheduled" &&
    this.startDateTime &&
    this.endDateTime &&
    this.endDateTime <= this.startDateTime
  ) {
    return next(new Error("Maintenance endDateTime must be later than startDateTime."));
  }

  next();
});

module.exports = mongoose.models.maintenance || mongoose.model("maintenance", maintenanceSchema);
