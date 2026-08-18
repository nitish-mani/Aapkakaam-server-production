const mongoose = require("mongoose");
const Concern = require("../models/concern");

const { ObjectId } = mongoose.Types;

// ============================================================
// Helpers
// ============================================================

const getUserOrVendorAuth = (req) => {
  if (!req.auth || !req.auth.id || !req.auth.role) {
    return null;
  }

  if (!["user", "vendor"].includes(req.auth.role)) {
    return null;
  }

  return {
    id: req.auth.id,
    raisedBy: req.auth.role === "user" ? "User" : "Vendor",
  };
};

const isAdmin = (req) => {
  return req.auth?.role === "admin";
};

// ============================================================
// CREATE CONCERN
// User / Vendor
// ============================================================

const createConcern = async (req, res) => {
  try {
    const { category, subject, description, priority, attachments } = req.body;

    // --------------------------------------------------------
    // Authentication
    // --------------------------------------------------------

    const auth = getUserOrVendorAuth(req);

    if (!auth) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
      });
    }

    // --------------------------------------------------------
    // Validate required fields
    // --------------------------------------------------------

    if (!category || !subject || !description) {
      return res.status(400).json({
        success: false,
        message: "Category, subject and description are required",
      });
    }

    // --------------------------------------------------------
    // Validate ObjectId
    // --------------------------------------------------------

    if (!ObjectId.isValid(auth.id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid account ID",
      });
    }

    // --------------------------------------------------------
    // Create concern
    // --------------------------------------------------------

    const concern = await Concern.create({
      raisedBy: auth.raisedBy,

      raisedById: new ObjectId(auth.id),

      category,

      subject: subject.trim(),

      description: description.trim(),

      priority: priority || "Medium",

      attachments: Array.isArray(attachments) ? attachments : [],
    });

    return res.status(201).json({
      success: true,
      message: "Concern submitted successfully",
      concern,
    });
  } catch (error) {
    console.error("createConcern error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to create concern",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
};

// ============================================================
// GET MY CONCERNS
// User / Vendor
// ============================================================

const getMyConcerns = async (req, res) => {
  try {
    const auth = getUserOrVendorAuth(req);

    if (!auth) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
      });
    }

    // --------------------------------------------------------
    // Validate ObjectId
    // --------------------------------------------------------

    if (!ObjectId.isValid(auth.id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid account ID",
      });
    }

    // --------------------------------------------------------
    // Build query
    // --------------------------------------------------------

    const filter = {
      raisedBy: auth.raisedBy,

      raisedById: new ObjectId(auth.id),

      isDeleted: false,
    };

    // Optional filters
    const { status, category, priority } = req.query;

    if (status) {
      filter.status = status;
    }

    if (category) {
      filter.category = category;
    }

    if (priority) {
      filter.priority = priority;
    }

    // --------------------------------------------------------
    // Fetch concerns
    // --------------------------------------------------------

    const concerns = await Concern.find(filter).sort({ createdAt: -1 }).lean();

    return res.status(200).json({
      success: true,

      count: concerns.length,

      concerns,
    });
  } catch (error) {
    console.error("getMyConcerns error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch concerns",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
};

// ============================================================
// GET SINGLE CONCERN
// User / Vendor - Own concern only
// ============================================================

const getConcernById = async (req, res) => {
  try {
    const { concernId } = req.params;

    // --------------------------------------------------------
    // Authentication
    // --------------------------------------------------------

    const auth = getUserOrVendorAuth(req);

    if (!auth) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
      });
    }

    // --------------------------------------------------------
    // Validate concern ID
    // --------------------------------------------------------

    if (!ObjectId.isValid(concernId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid concern ID",
      });
    }

    // --------------------------------------------------------
    // Validate account ID
    // --------------------------------------------------------

    if (!ObjectId.isValid(auth.id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid account ID",
      });
    }

    // --------------------------------------------------------
    // Find only user's/vendor's own concern
    // --------------------------------------------------------

    const concern = await Concern.findOne({
      _id: new ObjectId(concernId),

      raisedBy: auth.raisedBy,

      raisedById: new ObjectId(auth.id),

      isDeleted: false,
    }).lean();

    if (!concern) {
      return res.status(404).json({
        success: false,
        message: "Concern not found",
      });
    }

    return res.status(200).json({
      success: true,
      concern,
    });
  } catch (error) {
    console.error("getConcernById error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch concern",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
};

// ============================================================
// GET ALL CONCERNS
// Admin only
// ============================================================

const getAllConcerns = async (req, res) => {
  try {
    // --------------------------------------------------------
    // Admin authentication
    // --------------------------------------------------------

    if (!isAdmin(req)) {
      return res.status(403).json({
        success: false,
        message: "Admin access required",
      });
    }

    const { status, category, priority, raisedBy, page = 1, limit = 20 } = req.query;

    const pageNumber = Math.max(parseInt(page, 10) || 1, 1);

    const limitNumber = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);

    const filter = {
      isDeleted: false,
    };

    if (status) {
      filter.status = status;
    }

    if (category) {
      filter.category = category;
    }

    if (priority) {
      filter.priority = priority;
    }

    if (raisedBy) {
      if (!["User", "Vendor"].includes(raisedBy)) {
        return res.status(400).json({
          success: false,
          message: "Invalid raisedBy value",
        });
      }

      filter.raisedBy = raisedBy;
    }

    const skip = (pageNumber - 1) * limitNumber;

    const [concerns, totalCount] = await Promise.all([
      Concern.find(filter)
        .populate({
          path: "raisedById",
          select: "name phoneNo email",
        })
        .sort({
          createdAt: -1,
        })
        .skip(skip)
        .limit(limitNumber)
        .lean(),

      Concern.countDocuments(filter),
    ]);

    return res.status(200).json({
      success: true,

      concerns,

      pagination: {
        page: pageNumber,

        limit: limitNumber,

        totalCount,

        totalPages: Math.ceil(totalCount / limitNumber),

        hasNextPage: pageNumber * limitNumber < totalCount,
      },
    });
  } catch (error) {
    console.error("getAllConcerns error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch concerns",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
};

// ============================================================
// GET SINGLE CONCERN
// Admin only
// ============================================================

const getConcernByIdAdmin = async (req, res) => {
  try {
    const { concernId } = req.params;

    // --------------------------------------------------------
    // Admin authentication
    // --------------------------------------------------------

    if (!isAdmin(req)) {
      return res.status(403).json({
        success: false,
        message: "Admin access required",
      });
    }

    // --------------------------------------------------------
    // Validate ID
    // --------------------------------------------------------

    if (!ObjectId.isValid(concernId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid concern ID",
      });
    }

    // --------------------------------------------------------
    // Find concern
    // --------------------------------------------------------

    const concern = await Concern.findOne({
      _id: new ObjectId(concernId),
      isDeleted: false,
    })
      .populate({
        path: "raisedById",
        select: "name phoneNo email",
      })
      .lean();

    if (!concern) {
      return res.status(404).json({
        success: false,
        message: "Concern not found",
      });
    }

    return res.status(200).json({
      success: true,
      concern,
    });
  } catch (error) {
    console.error("getConcernByIdAdmin error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch concern",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
};

// ============================================================
// UPDATE CONCERN STATUS
// Admin only
// ============================================================

const updateConcernStatus = async (req, res) => {
  try {
    const { concernId } = req.params;

    const { status, adminResponse } = req.body;

    // --------------------------------------------------------
    // Admin authentication
    // --------------------------------------------------------

    if (!isAdmin(req)) {
      return res.status(403).json({
        success: false,
        message: "Admin access required",
      });
    }

    // --------------------------------------------------------
    // Validate concern ID
    // --------------------------------------------------------

    if (!ObjectId.isValid(concernId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid concern ID",
      });
    }

    // --------------------------------------------------------
    // Validate status
    // --------------------------------------------------------

    const allowedStatuses = ["Open", "InProgress", "Resolved", "Rejected", "Closed"];

    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Invalid concern status",
      });
    }

    // --------------------------------------------------------
    // Response required for resolution/rejection
    // --------------------------------------------------------

    if (["Resolved", "Rejected"].includes(status) && (!adminResponse || !adminResponse.trim())) {
      return res.status(400).json({
        success: false,
        message: "Admin response is required when resolving or rejecting a concern",
      });
    }

    // --------------------------------------------------------
    // Prepare update
    // --------------------------------------------------------

    const updateData = {
      status,
    };

    if (adminResponse !== undefined) {
      updateData.adminResponse = adminResponse.trim();
    }

    if (status === "Resolved" || status === "Rejected") {
      updateData.resolvedAt = new Date();
    } else {
      updateData.resolvedAt = null;
    }

    // --------------------------------------------------------
    // Update concern
    // --------------------------------------------------------

    const concern = await Concern.findOneAndUpdate(
      {
        _id: new ObjectId(concernId),

        isDeleted: false,
      },

      {
        $set: updateData,
      },

      {
        new: true,
        runValidators: true,
      },
    );

    if (!concern) {
      return res.status(404).json({
        success: false,
        message: "Concern not found",
      });
    }

    return res.status(200).json({
      success: true,

      message: `Concern ${status.toLowerCase()} successfully`,

      concern,
    });
  } catch (error) {
    console.error("updateConcernStatus error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to update concern",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
};

// ============================================================
// DELETE CONCERN
// Admin only
// ============================================================

const deleteConcern = async (req, res) => {
  try {
    const { concernId } = req.params;

    // --------------------------------------------------------
    // Admin authentication
    // --------------------------------------------------------

    if (!isAdmin(req)) {
      return res.status(403).json({
        success: false,
        message: "Admin access required",
      });
    }

    // --------------------------------------------------------
    // Validate ID
    // --------------------------------------------------------

    if (!ObjectId.isValid(concernId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid concern ID",
      });
    }

    // --------------------------------------------------------
    // Soft delete
    // --------------------------------------------------------

    const concern = await Concern.findOneAndUpdate(
      {
        _id: new ObjectId(concernId),

        isDeleted: false,
      },

      {
        $set: {
          isDeleted: true,
          deletedAt: new Date(),
        },
      },

      {
        new: true,
      },
    );

    if (!concern) {
      return res.status(404).json({
        success: false,
        message: "Concern not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Concern deleted successfully",
    });
  } catch (error) {
    console.error("deleteConcern error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to delete concern",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
};

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  createConcern,
  getMyConcerns,
  getConcernById,
  getAllConcerns,
  getConcernByIdAdmin,
  updateConcernStatus,
  deleteConcern,
};
