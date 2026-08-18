const mongoose = require("mongoose");

const { Schema } = mongoose;

const concernSchema = new Schema(
  {
    // Who created the concern
    raisedBy: {
      type: String,
      enum: ["User", "Vendor"],
      required: true,
      index: true,
    },

    // User/Vendor who raised it
    raisedById: {
      type: Schema.Types.ObjectId,
      required: true,
      refPath: "raisedBy",
      index: true,
    },

    // Type of concern
    category: {
      type: String,
      enum: [
        "Payment",
        "Booking",
        "Service",
        "Vendor",
        "User",
        "Cancellation",
        "Refund",
        "Technical",
        "Other",
      ],
      required: true,
      index: true,
    },

    // Short title
    subject: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200,
    },

    // User/Vendor explanation
    description: {
      type: String,
      required: true,
      trim: true,
      maxlength: 5000,
    },

    // Admin resolution status
    status: {
      type: String,
      enum: ["Open", "InProgress", "Resolved", "Rejected", "Closed"],
      default: "Open",
      index: true,
    },

    // Importance of concern
    priority: {
      type: String,
      enum: ["Low", "Medium", "High", "Critical"],
      default: "Medium",
    },

    // Admin's response when resolving/rejecting
    adminResponse: {
      type: String,
      trim: true,
      maxlength: 5000,
      default: null,
    },

    // When admin resolved/rejected it
    resolvedAt: {
      type: Date,
      default: null,
    },

    // Optional images/documents
    attachments: [
      {
        url: {
          type: String,
          trim: true,
        },

        type: {
          type: String,
          enum: ["image", "video", "document"],
        },

        name: {
          type: String,
          trim: true,
        },
      },
    ],

    // Soft delete
    isDeleted: {
      type: Boolean,
      default: false,
      index: true,
    },

    deletedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

// Find concerns belonging to a particular User/Vendor
concernSchema.index({
  raisedBy: 1,
  raisedById: 1,
  createdAt: -1,
});

// Admin dashboard queries
concernSchema.index({
  status: 1,
  priority: 1,
  createdAt: -1,
});

module.exports = mongoose.model("Concern", concernSchema);
