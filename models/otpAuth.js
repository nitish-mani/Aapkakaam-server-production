const mongoose = require("mongoose");
const { Schema } = mongoose;

const otpAuthSchema = new Schema({
  otp: {
    type: String,
    required: true,
  },

  purpose: {
    type: String,
    enum: ["verify_phone", "reset_password"],
    required: true,
    index: true,
  },

  accountType: {
    type: String,
    enum: ["user", "vendor", "admin"],
    required: true,
    index: true,
  },

  accountId: {
    type: Schema.Types.ObjectId,
    default: null,
    index: true,
  },

  target: {
    type: String,
    required: true,
  },

  verified: {
    type: Boolean,
    default: false,
  },

  consumedAt: {
    type: Date,
    default: null,
  },

  createdAt: {
    type: Date,
    default: Date.now,
    expires: 600,
  },
});

otpAuthSchema.index({
  accountType: 1,
  accountId: 1,
  purpose: 1,
});

module.exports = mongoose.model("OtpAuth", otpAuthSchema);
