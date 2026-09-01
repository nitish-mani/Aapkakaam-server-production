const mongoose = require("mongoose");

const vendorSignupPaymentSchema = new mongoose.Schema(
  {
    signupToken: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },

    razorpayOrderId: {
      type: String,
      unique: true,
      sparse: true,
      index: true,
    },

    razorpayPaymentId: {
      type: String,
      unique: true,
      sparse: true,
      index: true,
    },

    name: {
      type: String,
      required: true,
      trim: true,
    },

    phoneNo: {
      type: Number,
      required: true,
      index: true,
    },

    password: {
      type: String,
      required: true,
    },

    gender: {
      type: String,
      default: "",
    },

    type: {
      type: [String],
      default: [],
      validate: {
        validator: (value) => value.length <= 5,
        message: "Maximum 5 jobs allowed.",
      },
    },

    experience: {
      type: Number,
      default: 0,
    },

    sharedBy: {
      type: String,
      default: "",
    },

    cd: {
      type: String,
      default: "",
    },

    validPhoneNoId: {
      type: String,
      default: "",
    },

    agreedToTnCnP: {
      type: Boolean,
      default: false,
    },

    amount: {
      type: Number,
      default: 50,
    },
    fcmToken: {
      type: String,
    },
    status: {
      type: String,
      enum: ["created", "paid", "failed", "expired"],
      default: "created",
      index: true,
    },

    vendorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Vendor",
      default: null,
    },

    expiresAt: {
      type: Date,
      required: true,
    },
  },
  {
    timestamps: true,
  },
);

// Automatically remove expired signup sessions.
vendorSignupPaymentSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports =
  mongoose.models.VendorSignupPayment ||
  mongoose.model("VendorSignupPayment", vendorSignupPaymentSchema);
