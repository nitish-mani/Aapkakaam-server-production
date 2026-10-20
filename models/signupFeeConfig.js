const mongoose = require("mongoose");

const signupFeeConfigSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      default: "signup-fees",
      unique: true,
      immutable: true,
    },
    userAmountPaise: {
      type: Number,
      default: 0,
      min: 0,
      validate: Number.isSafeInteger,
    },
    vendorAmountPaise: {
      type: Number,
      default: 5000, // ₹50
      min: 0,
      validate: Number.isSafeInteger,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
  },
  { timestamps: true },
);

module.exports = mongoose.model("SignupFeeConfig", signupFeeConfigSchema);
