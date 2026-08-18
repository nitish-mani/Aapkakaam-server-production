const mongoose = require("mongoose");
const { Schema } = mongoose;

const adminSchema = new Schema({
  name: { type: String, required: true },
  phoneNo: { type: Number, required: true },
  verifyPhoneNo: { type: Boolean, default: false },
  email: { type: String, required: true },
  password: { type: String, required: true },
  gender: { type: String },
  status: {
    type: String,
    enum: ["active", "blocked"],
    default: "active",
    index: true,
  },
},

  { timestamps: true }, // adds createdAt, updatedAt
);

module.exports = mongoose.model.Admin || mongoose.model("Admin", adminSchema);
