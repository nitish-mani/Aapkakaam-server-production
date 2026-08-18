const mongoose = require("mongoose");
const { Schema } = mongoose;

const attendanceSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: "User", index: true },
  vendorId: { type: Schema.Types.ObjectId, ref: "Vendor", index: true },
  attendance: { type: Boolean, default: false },
  presentDate: { type: String },
  totalTime: { type: Number, default: 0 },
  pageNo1: { type: Boolean, default: false },
  pageNo2: { type: Boolean, default: false },
  pageNo3: { type: Boolean, default: false },
  attendanceData: { type: Object },
});

module.exports = mongoose.model("attendance", attendanceSchema);
