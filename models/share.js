const mongoose = require("mongoose");
const { Schema } = mongoose;

const shareSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: "User", index: true }, // who shared
  vendorId: { type: Schema.Types.ObjectId, ref: "Vendor", index: true }, // which vendor was shared

  phoneNo: { type: Number, index: true }, // for quick lookups by phone number
  status: {
    type: String,
    enum: ["pending", "accepted", "rejected", "completed"],
    default: "pending",
  },
  shareDate: { type: Date, default: Date.now, index: true },
});

module.exports = mongoose.model("Share", shareSchema);
