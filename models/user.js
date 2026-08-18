const mongoose = require("mongoose");
const { Schema } = mongoose;

const userSchema = new Schema(
  {
    name: { type: String, required: true },
    phoneNo: { type: Number, required: true, index: true },
    otpForPhoneNo: Number,
    verifyPhoneNo: { type: Boolean, default: false },

    email: { type: String, default: "", index: true },
    otpForEmail: Number,
    verifyEmail: { type: Boolean, default: false },

    password: { type: String, required: true },
    validPhoneNoId: String,
    validEmailId: String,
    imgURL: String,

    address: [Object], // keep small — e.g., multiple saved addresses
    shareBy: { type: String }, //userId or vendorId

    pending: { type: Number, default: 0 },
    completed: { type: Number, default: 0 },
    canceled: { type: Number, default: 0 },
    earning: { type: Number, default: 0 }, // earnigs by share

    pendingShareBy: { type: Number, default: 0 }, // when recipient create booking
    completedShareBy: { type: Number, default: 0 }, // when recipient mark booking complete
    canceledShareBy: { type: Number, default: 0 }, // when recipient mark booking cancel

    gender: String,
    pincode: { type: String, index: true },

    accountCreatedOn: { type: Date, default: Date.now },
    cd: { type: String }, // user or vendor

    balance: { type: Number, default: 0 },

    fcmToken: String,
    agreedToTnCnP: { type: Boolean, default: false },

    // stats tracking instead of large embedded arrays
    bookingCount: { type: Number, default: 0 },
    shareCount: { type: Number, default: 0 },
    transactionCount: { type: Number, default: 0 },
    totalDiscount: { type: Number, default: 0 },
    totalOriginalAmount: { type: Number, default: 0 },
    presentDate: { type: Date },

    status: {
      type: String,
      enum: ["active", "blocked"],
      default: "active",
      index: true,
    },
  },
  { timestamps: true }, // adds createdAt and updatedAt automatically
);

// 🔍 useful indexes for frequent queries
// User.js
module.exports = mongoose.models.User || mongoose.model("User", userSchema);
