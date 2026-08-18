const Share = require("../models/share");
const User = require("../models/user");
const Vendor = require("../models/vendor");
const Employee = require("../models/employee");

exports.share_controller_post = async (req, res, next) => {
  try {
    const { userId, vendorId, employeeId, phoneNo } = req.body;

    // Validate input
    if (!phoneNo) {
      return res.status(400).json({ message: "Phone number is required" });
    }

    // Validate that at least one ID is provided
    if (!userId && !vendorId && !employeeId) {
      return res.status(400).json({ 
        message: "At least one of userId, vendorId, or employeeId is required" 
      });
    }

    // Validate that only one ID type is provided
    const idCount = [userId, vendorId, employeeId].filter(Boolean).length;
    if (idCount > 1) {
      return res.status(400).json({ 
        message: "Only one of userId, vendorId, or employeeId should be provided" 
      });
    }

    // Validate phone number format (basic validation)
    const phoneRegex = /^[6-9]\d{9}$/; // Indian phone number format
    if (!phoneRegex.test(phoneNo.toString())) {
      return res.status(400).json({ 
        message: "Invalid phone number format" 
      });
    }

    // Check if the referrer exists
    let referrerExists = false;
    if (userId) {
      const user = await User.findById(userId).select('_id');
      referrerExists = !!user;
    } else if (vendorId) {
      const vendor = await Vendor.findById(vendorId).select('_id');
      referrerExists = !!vendor;
    } else if (employeeId) {
      const employee = await Employee.findById(employeeId).select('_id');
      referrerExists = !!employee;
    }

    if (!referrerExists) {
      return res.status(404).json({ 
        message: "Referrer not found" 
      });
    }

    // Check for duplicate share entry (same referrer and phone number within last 24 hours)
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    
    const existingShare = await Share.findOne({
      $or: [
        { userId },
        { vendorId },
        { employeeId }
      ],
      phoneNo,
      shareDate: { $gte: twentyFourHoursAgo }
    });

    if (existingShare) {
      return res.status(409).json({ 
        message: "This phone number has already been shared by you in the last 24 hours" 
      });
    }

    // Create new share record
    const share = new Share({
      userId: userId || undefined,
      vendorId: vendorId || undefined,
      employeeId: employeeId || undefined,
      phoneNo,
      status: "pending",
      shareDate: new Date(),
    });

    const result = await share.save();

    // Update share count for the referrer
    if (userId) {
      await User.findByIdAndUpdate(userId, { 
        $inc: { shareCount: 1 } 
      });
    } else if (vendorId) {
      await Vendor.findByIdAndUpdate(vendorId, { 
        $inc: { shareCount: 1 } 
      });
    } else if (employeeId) {
      await Employee.findByIdAndUpdate(employeeId, { 
        $inc: { shareCount: 1 } 
      });
    }

    res.status(201).json({ 
      message: "Sharing recorded successfully",
      shareId: result._id,
      status: "pending"
    });

  } catch (err) {
    console.error("Share post error:", err);
    
    if (err.name === 'ValidationError') {
      return res.status(400).json({ 
        message: "Validation failed",
        errors: err.errors 
      });
    }
    
    if (err.name === 'CastError') {
      return res.status(400).json({ 
        message: "Invalid ID format" 
      });
    }

    res.status(500).json({ 
      message: "Internal server error",
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
};

exports.share_controller_get = async (req, res, next) => {
  try {
    const { 
      page = 1, 
      limit = 10, 
      status, 
      userId, 
      vendorId, 
      employeeId,
      startDate,
      endDate 
    } = req.query;

    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;

    // Build filter object
    const filter = {};
    
    if (status) {
      if (!['pending', 'accepted', 'rejected', 'completed'].includes(status)) {
        return res.status(400).json({ 
          message: "Invalid status value. Must be one of: pending, accepted, rejected, completed" 
        });
      }
      filter.status = status;
    }

    if (userId) filter.userId = userId;
    if (vendorId) filter.vendorId = vendorId;
    if (employeeId) filter.employeeId = employeeId;

    // Date range filter
    if (startDate || endDate) {
      filter.shareDate = {};
      if (startDate) filter.shareDate.$gte = new Date(startDate);
      if (endDate) filter.shareDate.$lte = new Date(endDate);
    }

    const [shares, totalCount] = await Promise.all([
      Share.find(filter)
        .populate('userId', 'name phoneNo')
        .populate('vendorId', 'name phoneNo type')
        .populate('employeeId', 'name phoneNo')
        .sort({ shareDate: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),

      Share.countDocuments(filter)
    ]);

    if (shares.length === 0) {
      return res.status(404).json({ 
        message: "No shares found",
        shares: [],
        pagination: {
          currentPage: pageNum,
          totalPages: 0,
          totalCount: 0,
          hasNext: false,
          hasPrev: false
        }
      });
    }

    // Format response
    const formattedShares = shares.map(share => ({
      _id: share._id,
      referrer: share.userId ? {
        type: 'user',
        id: share.userId._id,
        name: share.userId.name,
        phoneNo: share.userId.phoneNo
      } : share.vendorId ? {
        type: 'vendor',
        id: share.vendorId._id,
        name: share.vendorId.name,
        phoneNo: share.vendorId.phoneNo,
        serviceType: share.vendorId.type
      } : share.employeeId ? {
        type: 'employee',
        id: share.employeeId._id,
        name: share.employeeId.name,
        phoneNo: share.employeeId.phoneNo
      } : null,
      sharedPhoneNo: share.phoneNo,
      status: share.status,
      shareDate: share.shareDate,
    }));

    const totalPages = Math.ceil(totalCount / limitNum);

    res.status(200).json({
      message: "Shares retrieved successfully",
      shares: formattedShares,
      pagination: {
        currentPage: pageNum,
        totalPages,
        totalCount,
        hasNext: pageNum < totalPages,
        hasPrev: pageNum > 1
      }
    });

  } catch (err) {
    console.error("Share get error:", err);
    
    if (err.name === 'CastError') {
      return res.status(400).json({ 
        message: "Invalid ID format in query parameters" 
      });
    }

    res.status(500).json({ 
      message: "Internal server error",
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
};

// Additional optional endpoints for better functionality

exports.share_controller_getById = async (req, res, next) => {
  try {
    const { id } = req.params;

    const share = await Share.findById(id)
      .populate('userId', 'name phoneNo')
      .populate('vendorId', 'name phoneNo type')
      .populate('employeeId', 'name phoneNo')
      .lean();

    if (!share) {
      return res.status(404).json({ 
        message: "Share record not found" 
      });
    }

    res.status(200).json({
      message: "Share retrieved successfully",
      share
    });

  } catch (err) {
    console.error("Share getById error:", err);
    
    if (err.name === 'CastError') {
      return res.status(400).json({ 
        message: "Invalid share ID format" 
      });
    }

    res.status(500).json({ 
      message: "Internal server error" 
    });
  }
};

exports.share_controller_updateStatus = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!status || !['pending', 'accepted', 'rejected', 'completed'].includes(status)) {
      return res.status(400).json({ 
        message: "Valid status is required (pending, accepted, rejected, completed)" 
      });
    }

    const share = await Share.findByIdAndUpdate(
      id,
      { status },
      { new: true, runValidators: true }
    )
    .populate('userId', 'name phoneNo')
    .populate('vendorId', 'name phoneNo type')
    .populate('employeeId', 'name phoneNo');

    if (!share) {
      return res.status(404).json({ 
        message: "Share record not found" 
      });
    }

    res.status(200).json({
      message: "Share status updated successfully",
      share
    });

  } catch (err) {
    console.error("Share updateStatus error:", err);
    
    if (err.name === 'ValidationError') {
      return res.status(400).json({ 
        message: "Validation failed",
        errors: err.errors 
      });
    }
    
    if (err.name === 'CastError') {
      return res.status(400).json({ 
        message: "Invalid share ID format" 
      });
    }

    res.status(500).json({ 
      message: "Internal server error" 
    });
  }
};