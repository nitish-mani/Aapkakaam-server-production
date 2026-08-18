const mongoose = require("mongoose");
const { Schema } = mongoose;

const vendorSchema = new Schema(
  {
    name: { type: String, required: true },
    phoneNo: { type: Number, required: true, index: true },
    verifyPhoneNo: { type: Boolean, default: false },
    email: { type: String, default: "", index: true },
    verifyEmail: { type: Boolean, default: false },
    password: { type: String, required: true },

    type: { type: String, required: true, index: true },
    validPhoneNoId: String,
    validEmailId: String,
    imgURL: String,
    experience: {
      type: Number,
      default: 0,
    },

    isVerified: {
      type: Boolean,
      default: false,
    },

      isSelfBooked: {
      type: Boolean,
      default: false,
    },


    address: [Object], // lightweight array (small number of entries)
    shareBy: { type: String }, //userId or vendorId

    pending: { type: Number, default: 0 }, // when acting as user
    completed: { type: Number, default: 0 }, // when acting as user
    canceled: { type: Number, default: 0 }, // when acting as user
    wageRate: { type: Number, default: 0 },
    wageRateType: { type: String },
    earning: { type: Number, default: 0 }, // earnigs by share
    commission: { type: Number, default: 0 },

    pendingVendor: { type: Number, default: 0 }, // when acting as vendor booked by user or vendor
    completedVendor: { type: Number, default: 0 }, // when acting as vendor booked by user or vendor
    canceledVendor: { type: Number, default: 0 }, // when acting as vendor booked by user or vendor

    pendingShareBy: { type: Number, default: 0 }, // when recipient create booking
    completedShareBy: { type: Number, default: 0 }, // when recipient mark booking complete
    canceledShareBy: { type: Number, default: 0 }, // when recipient mark booking cancel

    rating: { type: Number, default: 0 },
    ratingCount: { type: Number, default: 0 },
    gender: String,

    pincode: { type: String, index: true },
    accountCreatedOn: { type: Date, default: Date.now },
    cd: { type: String }, // user or vendor
    leaveTaken: [],
    balance: { type: Number, default: 0 },

    fcmToken: String,
    agreedToTnCnP: { type: Boolean, default: false },
    lastShownContext: {
      type: String,
      default: null,
    },

    // stats for external collections
    bookingCount: { type: Number, default: 0 },
    bookingCountVendor: { type: Number, default: 0 },
    shareCount: { type: Number, default: 0 },
    totalDiscount: { type: Number, default: 0 },
    totalOriginalAmount: { type: Number, default: 0 },
    transactionCount: { type: Number, default: 0 },
    presentDate: { type: Date },

    userShownContext: {
      type: Map,
      of: String,
      default: {},
    },

    status: {
      type: String,
      enum: ["active", "blocked"],
      default: "active",
      index: true,
    },
  },
  { timestamps: true }, // adds createdAt, updatedAt
);

// indexes

// Vendor.js
module.exports = mongoose.models.Vendor || mongoose.model("Vendor", vendorSchema);
