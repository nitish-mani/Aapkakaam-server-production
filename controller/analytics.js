/**
 * Admin Analytics Controller
 * Complete analytics system with caching, aggregation, and reporting
 * Enhanced with vendor-specific analytics and admin modification capabilities
 */
const mongoose = require("mongoose");
const User = require("../models/user");
const Vendor = require("../models/vendor");
const Bookings = require("../models/bookings");
const Transaction = require("../models/transaction");
const Share = require("../models/share");
const WalletLedger = require("../models/walletLedger");
const VendorLeave = require("../models/VendorLeave");
const { AdminLogger } = require("../src/logger/index");
const ENV = require("../src/config/env");

// ============================================
// CONSTANTS & CONFIGURATION
// ============================================

const CACHE_TTL_MS = parseInt(process.env.ANALYTICS_CACHE_TTL || "60") * 1000;
const DEFAULT_CURRENCY = process.env.ANALYTICS_DEFAULT_CURRENCY || "INR";
const MAX_EXPORT_ROWS = parseInt(process.env.ANALYTICS_MAX_EXPORT_ROWS || "10000");

// Cache state
let cache = {
  dashboard: { at: 0, data: null },
  users: { at: 0, data: null },
  vendors: { at: 0, data: null },
  bookings: { at: 0, data: null },
  revenue: { at: 0, data: null },
  referrals: { at: 0, data: null },
};

// ============================================
// UTILITY FUNCTIONS
// ============================================

function getStartOfDayIST(date) {
  const d = new Date(date);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function getStartOfMonthIST(date) {
  const d = new Date(date);
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function getStartOfWeekIST(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  return new Date(d.getFullYear(), d.getMonth(), diff);
}

async function safeCount(countFn, defaultValue = 0) {
  try {
    const result = await countFn();
    return result || defaultValue;
  } catch (err) {
    AdminLogger.warn({ err }, "Count operation failed, using default");
    return defaultValue;
  }
}

function setCache(type, data) {
  if (cache[type]) {
    cache[type] = { at: Date.now(), data };
  }
}

function isCacheValid(type) {
  const cached = cache[type];
  if (!cached || !cached.data) return false;
  return Date.now() - cached.at < CACHE_TTL_MS;
}

// ============================================
// ADMIN MODIFICATION FUNCTIONS
// ============================================

/**
 * Find user by phone number
 */
async function findUserByPhone(phoneNo) {
  return await User.findOne({ phoneNo: phoneNo });
}

/**
 * Find vendor by phone number
 */
async function findVendorByPhone(phoneNo) {
  return await Vendor.findOne({ phoneNo: phoneNo });
}

/**
 * Get complete user details by phone number
 * Includes: user info, bookings, transactions, wallet ledger, referrals
 */
exports.getUserCompleteByPhone = async (req, res, next) => {
  try {
    const { phoneNo } = req.params;
    const { limit = 20, page = 1 } = req.query;

    const pageNum = parseInt(page, 10) || 1;
    const limitNum = parseInt(limit, 10) || 20;
    const skip = (pageNum - 1) * limitNum;

    // Find user by phone
    const user = await User.findOne({ phoneNo: phoneNo }).select("-password -__v").lean();

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found with this phone number",
      });
    }

    // Get user's bookings
    const bookings = await Bookings.find({ userId: user._id })
      .sort({ bookedOn: -1 })
      .skip(skip)
      .limit(limitNum)
      .populate("vendorId", "name phoneNo email type")
      .populate("bookedById", "name phoneNo")
      .lean();

    const totalBookings = await Bookings.countDocuments({ userId: user._id });

    // Get user's transactions
    const transactions = await Transaction.find({ userId: user._id })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNum)
      .lean();

    const totalTransactions = await Transaction.countDocuments({ userId: user._id });

    // Get user's wallet ledger entries
    const walletLedger = await WalletLedger.find({ userId: user._id })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNum)
      .populate("transactionId", "amount finalAmount status paymentGateway")
      .lean();

    const totalWalletEntries = await WalletLedger.countDocuments({ userId: user._id });

    // Get user's referrals (shares)
    const referrals = await Share.find({ userId: user._id })
      .sort({ shareDate: -1 })
      .skip(skip)
      .limit(limitNum)
      .populate("vendorId", "name phoneNo type")
      .lean();

    const totalReferrals = await Share.countDocuments({ userId: user._id });

    // Get booking stats - FIXED
    const bookingStats = await Bookings.aggregate([
      { $match: { userId: user._id } },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          completed: {
            $sum: { $cond: [{ $eq: ["$orderCompleted", true] }, 1, 0] },
          },
          cancelled: {
            $sum: { $cond: [{ $eq: ["$cancelOrder", true] }, 1, 0] },
          },
          active: {
            $sum: {
              $cond: [
                {
                  $and: [{ $eq: ["$cancelOrder", false] }, { $eq: ["$orderCompleted", false] }],
                },
                1,
                0,
              ],
            },
          },
          totalSpent: { $sum: "$expenseUser" },
        },
      },
    ]);

    // Get transaction summary
    const transactionSummary = await Transaction.aggregate([
      { $match: { userId: user._id, status: "completed" } },
      {
        $group: {
          _id: null,
          totalAmount: { $sum: "$amount" },
          totalFinalAmount: { $sum: "$finalAmount" },
          totalDiscounts: { $sum: "$discount" },
          avgOrderValue: { $avg: "$finalAmount" },
          count: { $sum: 1 },
        },
      },
    ]);

    // Get wallet summary
    const walletSummary = await WalletLedger.aggregate([
      { $match: { userId: user._id } },
      {
        $group: {
          _id: null,
          totalCredit: { $sum: "$credit" },
          totalDebit: { $sum: "$debit" },
          currentBalance: { $last: "$balanceAfter" },
        },
      },
    ]);

    return res.status(200).json({
      success: true,
      data: {
        user: user,
        bookings: {
          data: bookings,
          pagination: {
            page: pageNum,
            limit: limitNum,
            total: totalBookings,
            totalPages: Math.ceil(totalBookings / limitNum),
          },
        },
        transactions: {
          data: transactions,
          pagination: {
            page: pageNum,
            limit: limitNum,
            total: totalTransactions,
            totalPages: Math.ceil(totalTransactions / limitNum),
          },
        },
        walletLedger: {
          data: walletLedger,
          pagination: {
            page: pageNum,
            limit: limitNum,
            total: totalWalletEntries,
            totalPages: Math.ceil(totalWalletEntries / limitNum),
          },
        },
        referrals: {
          data: referrals,
          pagination: {
            page: pageNum,
            limit: limitNum,
            total: totalReferrals,
            totalPages: Math.ceil(totalReferrals / limitNum),
          },
        },
        stats: {
          bookings: bookingStats[0] || {
            total: 0,
            completed: 0,
            cancelled: 0,
            active: 0,
            totalSpent: 0,
          },
          transactions: transactionSummary[0] || {
            totalAmount: 0,
            totalFinalAmount: 0,
            totalDiscounts: 0,
            avgOrderValue: 0,
            count: 0,
          },
          wallet: walletSummary[0] || {
            totalCredit: 0,
            totalDebit: 0,
            currentBalance: 0,
          },
        },
      },
    });
  } catch (err) {
    console.error("Error in getUserCompleteByPhone:", err);
    AdminLogger.error({ err }, "Get user complete by phone failed");
    return res.status(500).json({
      success: false,
      message: "Failed to get user details",
      error: process.env.NODE_ENV === "development" ? err.message : undefined,
    });
  }
};

/**
 * Get complete vendor details by phone number
 * Includes: vendor info, bookings, transactions, wallet ledger, referrals, leaves
 */
exports.getVendorCompleteByPhone = async (req, res, next) => {
  try {
    const { phoneNo } = req.params;
    const { limit = 20, page = 1 } = req.query;

    const pageNum = parseInt(page, 10) || 1;
    const limitNum = parseInt(limit, 10) || 20;
    const skip = (pageNum - 1) * limitNum;

    // Find vendor by phone
    const vendor = await Vendor.findOne({ phoneNo: phoneNo }).select("-password -__v").lean();

    if (!vendor) {
      return res.status(404).json({
        success: false,
        message: "Vendor not found with this phone number",
      });
    }

    // Get vendor's bookings (as vendor)
    const bookings = await Bookings.find({ vendorId: vendor._id })
      .sort({ bookedOn: -1 })
      .skip(skip)
      .limit(limitNum)
      .populate("userId", "name phoneNo email")
      .populate("bookedById", "name phoneNo")
      .lean();

    const totalBookings = await Bookings.countDocuments({ vendorId: vendor._id });

    // Get vendor's transactions
    const transactions = await Transaction.find({ vendorId: vendor._id })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNum)
      .lean();

    const totalTransactions = await Transaction.countDocuments({ vendorId: vendor._id });

    // Get vendor's wallet ledger entries
    const walletLedger = await WalletLedger.find({ vendorId: vendor._id })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNum)
      .populate("transactionId", "amount finalAmount status paymentGateway")
      .lean();

    const totalWalletEntries = await WalletLedger.countDocuments({ vendorId: vendor._id });

    // Get vendor's referrals (shares)
    const referrals = await Share.find({ vendorId: vendor._id })
      .sort({ shareDate: -1 })
      .skip(skip)
      .limit(limitNum)
      .populate("userId", "name phoneNo")
      .lean();

    const totalReferrals = await Share.countDocuments({ vendorId: vendor._id });

    // Get vendor's leaves
    const leaves = await VendorLeave.find({ vendorId: vendor._id })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNum)
      .lean();

    const totalLeaves = await VendorLeave.countDocuments({ vendorId: vendor._id });

    // Get active leaves count
    const activeLeaves = await VendorLeave.countDocuments({
      vendorId: vendor._id,
      status: "active",
      from: { $lte: new Date() },
      to: { $gte: new Date() },
    });

    // Get booking stats - FIXED
    const bookingStats = await Bookings.aggregate([
      { $match: { vendorId: vendor._id } },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          completed: {
            $sum: { $cond: [{ $eq: ["$orderCompleted", true] }, 1, 0] },
          },
          cancelled: {
            $sum: { $cond: [{ $eq: ["$cancelOrder", true] }, 1, 0] },
          },
          active: {
            $sum: {
              $cond: [
                {
                  $and: [{ $eq: ["$cancelOrder", false] }, { $eq: ["$orderCompleted", false] }],
                },
                1,
                0,
              ],
            },
          },
          totalEarnings: { $sum: "$expenseVendor" },
        },
      },
    ]);

    // Get booking stats by type (User/Vendor)
    const bookingByType = await Bookings.aggregate([
      { $match: { vendorId: vendor._id } },
      {
        $group: {
          _id: "$bookingBy",
          count: { $sum: 1 },
          completed: {
            $sum: { $cond: [{ $eq: ["$orderCompleted", true] }, 1, 0] },
          },
        },
      },
    ]);

    // Get transaction summary
    const transactionSummary = await Transaction.aggregate([
      { $match: { vendorId: vendor._id, status: "completed" } },
      {
        $group: {
          _id: null,
          totalAmount: { $sum: "$amount" },
          totalFinalAmount: { $sum: "$finalAmount" },
          totalDiscounts: { $sum: "$discount" },
          avgOrderValue: { $avg: "$finalAmount" },
          count: { $sum: 1 },
        },
      },
    ]);

    // Get wallet summary
    const walletSummary = await WalletLedger.aggregate([
      { $match: { vendorId: vendor._id } },
      {
        $group: {
          _id: null,
          totalCredit: { $sum: "$credit" },
          totalDebit: { $sum: "$debit" },
          currentBalance: { $last: "$balanceAfter" },
        },
      },
    ]);

    return res.status(200).json({
      success: true,
      data: {
        vendor: vendor,
        bookings: {
          data: bookings,
          bookingByType: bookingByType,
          pagination: {
            page: pageNum,
            limit: limitNum,
            total: totalBookings,
            totalPages: Math.ceil(totalBookings / limitNum),
          },
        },
        transactions: {
          data: transactions,
          pagination: {
            page: pageNum,
            limit: limitNum,
            total: totalTransactions,
            totalPages: Math.ceil(totalTransactions / limitNum),
          },
        },
        walletLedger: {
          data: walletLedger,
          pagination: {
            page: pageNum,
            limit: limitNum,
            total: totalWalletEntries,
            totalPages: Math.ceil(totalWalletEntries / limitNum),
          },
        },
        referrals: {
          data: referrals,
          pagination: {
            page: pageNum,
            limit: limitNum,
            total: totalReferrals,
            totalPages: Math.ceil(totalReferrals / limitNum),
          },
        },
        leaves: {
          data: leaves,
          activeCount: activeLeaves,
          pagination: {
            page: pageNum,
            limit: limitNum,
            total: totalLeaves,
            totalPages: Math.ceil(totalLeaves / limitNum),
          },
        },
        stats: {
          bookings: bookingStats[0] || {
            total: 0,
            completed: 0,
            cancelled: 0,
            active: 0,
            totalEarnings: 0,
          },
          transactions: transactionSummary[0] || {
            totalAmount: 0,
            totalFinalAmount: 0,
            totalDiscounts: 0,
            avgOrderValue: 0,
            count: 0,
          },
          wallet: walletSummary[0] || {
            totalCredit: 0,
            totalDebit: 0,
            currentBalance: 0,
          },
        },
      },
    });
  } catch (err) {
    console.error("Error in getVendorCompleteByPhone:", err);
    AdminLogger.error({ err }, "Get vendor complete by phone failed");
    return res.status(500).json({
      success: false,
      message: "Failed to get vendor details",
      error: process.env.NODE_ENV === "development" ? err.message : undefined,
    });
  }
};

/**
 * Get vendor leave details by vendor phone number
 */
exports.getVendorLeavesByPhone = async (req, res, next) => {
  try {
    const { phoneNo } = req.params;
    const { status, from, to, limit = 20, page = 1 } = req.query;

    // Find vendor by phone
    const vendor = await Vendor.findOne({ phoneNo: phoneNo }).select("_id name phoneNo").lean();

    if (!vendor) {
      return res.status(404).json({
        success: false,
        message: "Vendor not found with this phone number",
      });
    }

    const pageNum = parseInt(page, 10) || 1;
    const limitNum = parseInt(limit, 10) || 20;
    const skip = (pageNum - 1) * limitNum;

    // Build query
    const query = { vendorId: vendor._id };
    if (status) query.status = status;
    if (from) query.from = { $gte: new Date(from) };
    if (to) query.to = { $lte: new Date(to) };

    const leaves = await VendorLeave.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNum)
      .lean();

    const totalLeaves = await VendorLeave.countDocuments(query);

    // Get leave stats
    const leaveStats = await VendorLeave.aggregate([
      { $match: { vendorId: vendor._id } },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          active: {
            $sum: { $cond: [{ $eq: ["$status", "active"] }, 1, 0] },
          },
          cancelled: {
            $sum: { $cond: [{ $eq: ["$status", "cancelled"] }, 1, 0] },
          },
          currentActive: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ["$status", "active"] },
                    { $lte: ["$from", new Date()] },
                    { $gte: ["$to", new Date()] },
                  ],
                },
                1,
                0,
              ],
            },
          },
        },
      },
    ]);

    return res.status(200).json({
      success: true,
      data: {
        vendor: {
          id: vendor._id,
          name: vendor.name,
          phoneNo: vendor.phoneNo,
        },
        leaves: leaves,
        stats: leaveStats[0] || { total: 0, active: 0, cancelled: 0, currentActive: 0 },
        pagination: {
          page: pageNum,
          limit: limitNum,
          total: totalLeaves,
          totalPages: Math.ceil(totalLeaves / limitNum),
        },
      },
    });
  } catch (err) {
    AdminLogger.error({ err }, "Get vendor leaves by phone failed");
    return next(err);
  }
};

/**
 * Create vendor leave by vendor phone number
 */
exports.createVendorLeaveByPhone = async (req, res, next) => {
  try {
    const { phoneNo } = req.params;
    const { from, to, reason } = req.body;

    // Find vendor by phone
    const vendor = await Vendor.findOne({ phoneNo: phoneNo }).select("_id name phoneNo").lean();

    if (!vendor) {
      return res.status(404).json({
        success: false,
        message: "Vendor not found with this phone number",
      });
    }

    // Validate dates
    if (!from || !to) {
      return res.status(400).json({
        success: false,
        message: "Both 'from' and 'to' dates are required",
      });
    }

    const fromDate = new Date(from);
    const toDate = new Date(to);

    if (fromDate > toDate) {
      return res.status(400).json({
        success: false,
        message: "'from' date must be before or equal to 'to' date",
      });
    }

    // Check for overlapping leave
    const overlapping = await VendorLeave.findOne({
      vendorId: vendor._id,
      status: "active",
      $or: [{ from: { $lte: toDate }, to: { $gte: fromDate } }],
    });

    if (overlapping) {
      return res.status(400).json({
        success: false,
        message: "Vendor already has an active leave during this period",
        overlappingLeave: overlapping,
      });
    }

    // Create leave
    const leave = await VendorLeave.create({
      vendorId: vendor._id,
      from: fromDate,
      to: toDate,
      reason: reason || "",
      status: "active",
    });

    AdminLogger.info(
      {
        event: "ADMIN_CREATED_VENDOR_LEAVE",
        adminId: req.auth?.id,
        vendorId: vendor._id,
        vendorPhone: phoneNo,
        leaveId: leave._id,
      },
      "Admin created vendor leave by phone",
    );

    return res.status(201).json({
      success: true,
      message: "Vendor leave created successfully",
      data: leave,
    });
  } catch (err) {
    AdminLogger.error({ err }, "Create vendor leave by phone failed");
    return next(err);
  }
};

/**
 * Update vendor leave status by leave ID
 */
exports.updateVendorLeaveStatus = async (req, res, next) => {
  try {
    const { leaveId } = req.params;
    const { status } = req.body;

    if (!status || !["active", "cancelled"].includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Status must be either 'active' or 'cancelled'",
      });
    }

    const leave = await VendorLeave.findByIdAndUpdate(
      leaveId,
      { status: status },
      { new: true, runValidators: true },
    ).populate("vendorId", "name phoneNo");

    if (!leave) {
      return res.status(404).json({
        success: false,
        message: "Leave not found",
      });
    }

    AdminLogger.info(
      {
        event: "ADMIN_UPDATED_VENDOR_LEAVE",
        adminId: req.auth?.id,
        leaveId: leaveId,
        newStatus: status,
      },
      "Admin updated vendor leave status",
    );

    return res.status(200).json({
      success: true,
      message: `Leave ${status === "active" ? "activated" : "cancelled"} successfully`,
      data: leave,
    });
  } catch (err) {
    AdminLogger.error({ err }, "Update vendor leave status failed");
    return next(err);
  }
};

/**
 * Delete vendor leave by ID
 */
exports.deleteVendorLeave = async (req, res, next) => {
  try {
    const { leaveId } = req.params;

    const leave = await VendorLeave.findByIdAndDelete(leaveId);

    if (!leave) {
      return res.status(404).json({
        success: false,
        message: "Leave not found",
      });
    }

    AdminLogger.info(
      {
        event: "ADMIN_DELETED_VENDOR_LEAVE",
        adminId: req.auth?.id,
        leaveId: leaveId,
      },
      "Admin deleted vendor leave",
    );

    return res.status(200).json({
      success: true,
      message: "Leave deleted successfully",
    });
  } catch (err) {
    AdminLogger.error({ err }, "Delete vendor leave failed");
    return next(err);
  }
};

/**
 * Update user by phone number
 */
exports.updateUserByPhone = async (req, res, next) => {
  try {
    const { phoneNo } = req.params;
    const updateData = req.body;

    const user = await User.findOne({ phoneNo: phoneNo });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found with this phone number",
      });
    }

    // Allowed fields to update
    const allowedFields = [
      "name",
      "email",
      "status",
      "gender",
      "pincode",
      "balance",
      "password",
      "fcmToken",
      "address",
      "verifyPhoneNo",
      "verifyEmail",
      "imgURL",
    ];

    const filteredUpdate = {};
    allowedFields.forEach((field) => {
      if (updateData[field] !== undefined) {
        filteredUpdate[field] = updateData[field];
      }
    });

    // If password is being updated, hash it
    if (filteredUpdate.password) {
      const bcrypt = require("bcrypt");
      filteredUpdate.password = await bcrypt.hash(filteredUpdate.password, ENV.BCRYPT_ROUNDS);
    }

    const updatedUser = await User.findOneAndUpdate(
      { phoneNo: phoneNo },
      { $set: filteredUpdate },
      { new: true, runValidators: true },
    ).select("-password");

    AdminLogger.info(
      {
        event: "ADMIN_UPDATED_USER",
        adminId: req.auth?.id,
        phoneNo: phoneNo,
        updates: Object.keys(filteredUpdate),
      },
      "Admin updated user by phone",
    );

    return res.status(200).json({
      success: true,
      message: "User updated successfully",
      user: updatedUser,
    });
  } catch (err) {
    AdminLogger.error({ err }, "Update user by phone failed");
    return next(err);
  }
};

/**
 * Update vendor by phone number
 */
exports.updateVendorByPhone = async (req, res, next) => {
  try {
    const { phoneNo } = req.params;
    const updateData = req.body;

    const vendor = await Vendor.findOne({ phoneNo: phoneNo });
    if (!vendor) {
      return res.status(404).json({
        success: false,
        message: "Vendor not found with this phone number",
      });
    }

    // Allowed fields to update
    const allowedFields = [
      "name",
      "email",
      "status",
      "type",
      "gender",
      "pincode",
      "balance",
      "password",
      "fcmToken",
      "address",
      "verifyPhoneNo",
      "verifyEmail",
      "imgURL",
      "isVerified",
      "wageRate",
      "wageRateType",
      "experience",
      "commission",
    ];

    const filteredUpdate = {};
    allowedFields.forEach((field) => {
      if (updateData[field] !== undefined) {
        filteredUpdate[field] = updateData[field];
      }
    });

    // If password is being updated, hash it
    if (filteredUpdate.password) {
      const bcrypt = require("bcrypt");
      filteredUpdate.password = await bcrypt.hash(filteredUpdate.password, ENV.BCRYPT_ROUNDS);
    }

    const updatedVendor = await Vendor.findOneAndUpdate(
      { phoneNo: phoneNo },
      { $set: filteredUpdate },
      { new: true, runValidators: true },
    ).select("-password");

    AdminLogger.info(
      {
        event: "ADMIN_UPDATED_VENDOR",
        adminId: req.auth?.id,
        phoneNo: phoneNo,
        updates: Object.keys(filteredUpdate),
      },
      "Admin updated vendor by phone",
    );

    return res.status(200).json({
      success: true,
      message: "Vendor updated successfully",
      vendor: updatedVendor,
    });
  } catch (err) {
    AdminLogger.error({ err }, "Update vendor by phone failed");
    return next(err);
  }
};

/**
 * Block user by phone number
 */
exports.blockUserByPhone = async (req, res, next) => {
  try {
    const { phoneNo } = req.params;

    const user = await User.findOne({ phoneNo: phoneNo });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found with this phone number",
      });
    }

    const updatedUser = await User.findOneAndUpdate(
      { phoneNo: phoneNo },
      { $set: { status: "blocked" } },
      { new: true },
    ).select("-password");

    AdminLogger.info(
      {
        event: "ADMIN_BLOCKED_USER",
        adminId: req.auth?.id,
        phoneNo: phoneNo,
      },
      "Admin blocked user by phone",
    );

    return res.status(200).json({
      success: true,
      message: "User blocked successfully",
      user: updatedUser,
    });
  } catch (err) {
    AdminLogger.error({ err }, "Block user by phone failed");
    return next(err);
  }
};

/**
 * Unblock user by phone number
 */
exports.unblockUserByPhone = async (req, res, next) => {
  try {
    const { phoneNo } = req.params;

    const user = await User.findOne({ phoneNo: phoneNo });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found with this phone number",
      });
    }

    const updatedUser = await User.findOneAndUpdate(
      { phoneNo: phoneNo },
      { $set: { status: "active" } },
      { new: true },
    ).select("-password");

    AdminLogger.info(
      {
        event: "ADMIN_UNBLOCKED_USER",
        adminId: req.auth?.id,
        phoneNo: phoneNo,
      },
      "Admin unblocked user by phone",
    );

    return res.status(200).json({
      success: true,
      message: "User unblocked successfully",
      user: updatedUser,
    });
  } catch (err) {
    AdminLogger.error({ err }, "Unblock user by phone failed");
    return next(err);
  }
};

/**
 * Block vendor by phone number
 */
exports.blockVendorByPhone = async (req, res, next) => {
  try {
    const { phoneNo } = req.params;

    const vendor = await Vendor.findOne({ phoneNo: phoneNo });
    if (!vendor) {
      return res.status(404).json({
        success: false,
        message: "Vendor not found with this phone number",
      });
    }

    const updatedVendor = await Vendor.findOneAndUpdate(
      { phoneNo: phoneNo },
      { $set: { status: "blocked" } },
      { new: true },
    ).select("-password");

    AdminLogger.info(
      {
        event: "ADMIN_BLOCKED_VENDOR",
        adminId: req.auth?.id,
        phoneNo: phoneNo,
      },
      "Admin blocked vendor by phone",
    );

    return res.status(200).json({
      success: true,
      message: "Vendor blocked successfully",
      vendor: updatedVendor,
    });
  } catch (err) {
    AdminLogger.error({ err }, "Block vendor by phone failed");
    return next(err);
  }
};

/**
 * Unblock vendor by phone number
 */
exports.unblockVendorByPhone = async (req, res, next) => {
  try {
    const { phoneNo } = req.params;

    const vendor = await Vendor.findOne({ phoneNo: phoneNo });
    if (!vendor) {
      return res.status(404).json({
        success: false,
        message: "Vendor not found with this phone number",
      });
    }

    const updatedVendor = await Vendor.findOneAndUpdate(
      { phoneNo: phoneNo },
      { $set: { status: "active" } },
      { new: true },
    ).select("-password");

    AdminLogger.info(
      {
        event: "ADMIN_UNBLOCKED_VENDOR",
        adminId: req.auth?.id,
        phoneNo: phoneNo,
      },
      "Admin unblocked vendor by phone",
    );

    return res.status(200).json({
      success: true,
      message: "Vendor unblocked successfully",
      vendor: updatedVendor,
    });
  } catch (err) {
    AdminLogger.error({ err }, "Unblock vendor by phone failed");
    return next(err);
  }
};

/**
 * Get user by phone number
 */
exports.getUserByPhone = async (req, res, next) => {
  try {
    const { phoneNo } = req.params;

    const user = await User.findOne({ phoneNo: phoneNo }).select("-password -__v").lean();

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found with this phone number",
      });
    }

    return res.status(200).json({
      success: true,
      user,
    });
  } catch (err) {
    AdminLogger.error({ err }, "Get user by phone failed");
    return next(err);
  }
};

/**
 * Get vendor by phone number
 */
exports.getVendorByPhone = async (req, res, next) => {
  try {
    const { phoneNo } = req.params;

    const vendor = await Vendor.findOne({ phoneNo: phoneNo }).select("-password -__v").lean();

    if (!vendor) {
      return res.status(404).json({
        success: false,
        message: "Vendor not found with this phone number",
      });
    }

    return res.status(200).json({
      success: true,
      vendor,
    });
  } catch (err) {
    AdminLogger.error({ err }, "Get vendor by phone failed");
    return next(err);
  }
};

/**
 * Search users by phone number (partial match)
 */
exports.searchUsersByPhone = async (req, res, next) => {
  try {
    const { phoneNo } = req.query;

    if (!phoneNo) {
      return res.status(400).json({
        success: false,
        message: "Phone number is required for search",
      });
    }

    const users = await User.find({
      phoneNo: { $regex: phoneNo, $options: "i" },
    })
      .select("-password -__v")
      .limit(20)
      .lean();

    return res.status(200).json({
      success: true,
      count: users.length,
      users,
    });
  } catch (err) {
    AdminLogger.error({ err }, "Search users by phone failed");
    return next(err);
  }
};

/**
 * Search vendors by phone number (partial match)
 */
exports.searchVendorsByPhone = async (req, res, next) => {
  try {
    const { phoneNo } = req.query;

    if (!phoneNo) {
      return res.status(400).json({
        success: false,
        message: "Phone number is required for search",
      });
    }

    const vendors = await Vendor.find({
      phoneNo: { $regex: phoneNo, $options: "i" },
    })
      .select("-password -__v")
      .limit(20)
      .lean();

    return res.status(200).json({
      success: true,
      count: vendors.length,
      vendors,
    });
  } catch (err) {
    AdminLogger.error({ err }, "Search vendors by phone failed");
    return next(err);
  }
};

// ============================================
// DASHBOARD ANALYTICS
// ============================================

/**
 * Compute main dashboard statistics
 */
async function computeDashboard() {
  const now = new Date();
  const startOfDay = getStartOfDayIST(now);
  const startOfMonth = getStartOfMonthIST(now);
  const startOfWeek = getStartOfWeekIST(now);
  const startOfYear = new Date(now.getFullYear(), 0, 1);

  const [
    totalUsers,
    totalVendors,
    totalBookings,
    bookingsToday,
    bookingsThisMonth,
    txAgg,
    txTimeline,
    shareCount,
    shareCompleted,
    activeBookings,
    vendorStats,
    recentActivities,
  ] = await Promise.all([
    safeCount(() => User.countDocuments()),
    safeCount(() => Vendor.countDocuments()),
    safeCount(() => Bookings.countDocuments()),
    safeCount(() =>
      Bookings.countDocuments({
        createdAt: { $gte: startOfDay },
        cancelOrder: false,
        orderCompleted: false,
      }),
    ),
    safeCount(() =>
      Bookings.countDocuments({
        createdAt: { $gte: startOfMonth },
        cancelOrder: false,
        orderCompleted: false,
      }),
    ),
    // Current month aggregation
    (async () => {
      try {
        const result = await Transaction.aggregate([
          {
            $match: {
              createdAt: { $gte: startOfMonth },
              status: "completed",
              deleted: { $ne: true },
            },
          },
          {
            $group: {
              _id: null,
              gmv: { $sum: "$amount" },
              count: { $sum: 1 },
              totalDiscount: { $sum: "$discount" },
              avgOrderValue: { $avg: "$finalAmount" },
            },
          },
        ]);
        return result[0] || { gmv: 0, count: 0, totalDiscount: 0, avgOrderValue: 0 };
      } catch (err) {
        AdminLogger.warn({ err }, "Transaction aggregation failed");
        return { gmv: 0, count: 0, totalDiscount: 0, avgOrderValue: 0 };
      }
    })(),
    // Revenue timeline for last 12 months
    (async () => {
      try {
        const twelveMonthsAgo = new Date(now);
        twelveMonthsAgo.setMonth(now.getMonth() - 11);
        twelveMonthsAgo.setDate(1);
        twelveMonthsAgo.setHours(0, 0, 0, 0);

        const result = await Transaction.aggregate([
          {
            $match: {
              createdAt: { $gte: twelveMonthsAgo },
              status: "completed",
              deleted: { $ne: true },
            },
          },
          {
            $group: {
              _id: {
                year: { $year: "$createdAt" },
                month: { $month: "$createdAt" },
              },
              revenue: { $sum: "$amount" },
              count: { $sum: 1 },
              discounts: { $sum: "$discount" },
            },
          },
          {
            $sort: { "_id.year": 1, "_id.month": 1 },
          },
        ]);

        const monthNames = [
          "Jan",
          "Feb",
          "Mar",
          "Apr",
          "May",
          "Jun",
          "Jul",
          "Aug",
          "Sep",
          "Oct",
          "Nov",
          "Dec",
        ];

        const dataMap = {};
        result.forEach((item) => {
          const key = `${item._id.year}-${item._id.month}`;
          dataMap[key] = {
            revenue: item.revenue || 0,
            count: item.count || 0,
            discounts: item.discounts || 0,
          };
        });

        const timeline = [];
        for (let i = 11; i >= 0; i--) {
          const date = new Date(now);
          date.setMonth(now.getMonth() - i);
          const year = date.getFullYear();
          const month = date.getMonth() + 1;
          const key = `${year}-${month}`;

          timeline.push({
            _id: monthNames[month - 1],
            year: year,
            month: month,
            revenue: dataMap[key]?.revenue || 0,
            count: dataMap[key]?.count || 0,
            discounts: dataMap[key]?.discounts || 0,
          });
        }

        return timeline;
      } catch (err) {
        AdminLogger.warn({ err }, "Revenue timeline aggregation failed");
        const monthNames = [
          "Jan",
          "Feb",
          "Mar",
          "Apr",
          "May",
          "Jun",
          "Jul",
          "Aug",
          "Sep",
          "Oct",
          "Nov",
          "Dec",
        ];
        const timeline = [];
        for (let i = 11; i >= 0; i--) {
          const date = new Date(now);
          date.setMonth(now.getMonth() - i);
          const month = date.getMonth();
          timeline.push({
            _id: monthNames[month],
            year: date.getFullYear(),
            month: month + 1,
            revenue: 0,
            count: 0,
            discounts: 0,
          });
        }
        return timeline;
      }
    })(),
    safeCount(() => Share.countDocuments({ status: "completed" })),
    safeCount(() => Share.countDocuments({ status: "completed" })),
    safeCount(() =>
      Bookings.countDocuments({
        cancelOrder: false,
        orderCompleted: false,
        bookingDate: { $gte: startOfDay },
      }),
    ),
    (async () => {
      try {
        const stats = await Vendor.aggregate([
          {
            $group: {
              _id: null,
              totalEarnings: { $sum: "$earning" },
              totalCommission: { $sum: "$commission" },
              totalBalance: { $sum: "$balance" },
              avgRating: { $avg: "$rating" },
              totalVendors: { $sum: 1 },
              activeVendors: {
                $sum: { $cond: [{ $eq: ["$status", "active"] }, 1, 0] },
              },
              blockedVendors: {
                $sum: { $cond: [{ $eq: ["$status", "blocked"] }, 1, 0] },
              },
              totalPending: { $sum: "$pendingVendor" },
              totalCompleted: { $sum: "$completedVendor" },
              totalCanceled: { $sum: "$canceledVendor" },
            },
          },
        ]);
        return (
          stats[0] || {
            totalEarnings: 0,
            totalCommission: 0,
            totalBalance: 0,
            avgRating: 0,
            totalVendors: 0,
            activeVendors: 0,
            blockedVendors: 0,
            totalPending: 0,
            totalCompleted: 0,
            totalCanceled: 0,
          }
        );
      } catch (err) {
        AdminLogger.warn({ err }, "Vendor stats aggregation failed");
        return {
          totalEarnings: 0,
          totalCommission: 0,
          totalBalance: 0,
          avgRating: 0,
          totalVendors: 0,
          activeVendors: 0,
          blockedVendors: 0,
          totalPending: 0,
          totalCompleted: 0,
          totalCanceled: 0,
        };
      }
    })(),
    // Recent Activities - Get latest events from all collections
    (async () => {
      try {
        const activities = [];
        const limit = 20; // Get more than needed to mix and sort

        // 1. Get recent users
        const recentUsers = await User.find()
          .sort({ createdAt: -1 })
          .limit(5)
          .select("name email createdAt status")
          .lean();

        recentUsers.forEach((user) => {
          activities.push({
            type: "user",
            action: "New user registered",
            user: user.name || "Unknown User",
            time: user.createdAt,
            status: user.status === "blocked" ? "blocked" : "success",
            id: user._id,
            details: user.email,
          });
        });

        // 2. Get recent bookings
        const recentBookings = await Bookings.find()
          .sort({ bookedOn: -1 })
          .limit(5)
          .populate("bookedById", "name ")
          .populate("vendorId", "name")
          .select(
            "userId vendorId orderCompleted cancelOrder bookedOn bookingDate bookedById bookingBy ",
          )
          .lean();

        recentBookings.forEach((booking) => {
          let action = "New booking created";
          let status = "active";

          if (booking.orderCompleted) {
            action = "Booking completed";
            status = "completed";
          } else if (booking.cancelOrder) {
            action = "Booking cancelled";
            status = "cancelled";
          }
          activities.push({
            type: "booking",
            action: action,
            user: booking.bookedById?.name || "Unknown User",
            time: booking.bookedOn,
            status: status,
            id: booking._id,
            details: `Vendor: ${booking.vendorId?.name || "Unknown"}`,
          });
        });

        // 3. Get recent vendors
        const recentVendors = await Vendor.find()
          .sort({ createdAt: -1 })
          .limit(3)
          .select("name email createdAt isVerified status")
          .lean();

        recentVendors.forEach((vendor) => {
          activities.push({
            type: "vendor",
            action: vendor.isVerified ? "Vendor verified" : "New vendor registered",
            user: vendor.name || "Unknown Vendor",
            time: vendor.createdAt,
            status: vendor.isVerified ? "completed" : "active",
            id: vendor._id,
            details: vendor.email,
          });
        });

        // 4. Get recent transactions
        const recentTransactions = await Transaction.find({ status: "completed" })
          .sort({ createdAt: -1 })
          .limit(3)
          .populate("userId", "name")
          .populate("vendorId", "name")
          .select("userId vendorId amount finalAmount createdAt paymentGateway")
          .lean();

        recentTransactions.forEach((tx) => {
          activities.push({
            type: "transaction",
            action: "Payment received",
            user: tx.userId?.name || tx.vendorId?.name || "Unknown User",
            time: tx.createdAt,
            status: "success",
            id: tx._id,
            details: `${tx.paymentGateway || "Gateway"} • ₹${tx.finalAmount || tx.amount || 0}`,
          });
        });

        // 5. Get recent shares/referrals
        const recentShares = await Share.find()
          .sort({ shareDate: -1 })
          .limit(3)
          .populate("userId", "name")
          .populate("vendorId", "name")
          .select("userId vendorId status shareDate")
          .lean();

        recentShares.forEach((share) => {
          activities.push({
            type: "referral",
            action: share.status === "completed" ? "Referral completed" : "New referral created",
            user: share.userId?.name || share.vendorId?.name || "Unknown User",
            time: share.shareDate,
            status: share.status === "completed" ? "success" : "active",
            id: share._id,
          });
        });

        // Sort all activities by time (newest first)
        activities.sort((a, b) => new Date(b.time) - new Date(a.time));

        // Return top 10 activities
        const topActivities = activities.slice(0, 10);

        // Format activities for frontend
        return topActivities.map((activity, index) => ({
          id: index + 1,
          type: activity.type,
          action: activity.action,
          user: activity.user,
          time: activity.time,
          status: activity.status,
          details: activity.details || null,
        }));
      } catch (err) {
        AdminLogger.warn({ err }, "Recent activities fetch failed");
        // Return empty array if fetch fails
        return [];
      }
    })(),
  ]);

  const referralConversion =
    shareCount > 0 ? Number(((shareCompleted / shareCount) * 100).toFixed(2)) : 0;

  const bookingCompletionRate =
    totalBookings > 0 ? Number(((bookingsToday / totalBookings) * 100).toFixed(2)) : 0;

  const activeBookingRate =
    totalBookings > 0 ? Number(((activeBookings / totalBookings) * 100).toFixed(2)) : 0;

  const revenueTimeline = txTimeline || [];
  const currentMonthRevenue = revenueTimeline[revenueTimeline.length - 1]?.revenue || 0;
  const previousMonthRevenue = revenueTimeline[revenueTimeline.length - 2]?.revenue || 0;
  const revenueChange =
    previousMonthRevenue > 0
      ? ((currentMonthRevenue - previousMonthRevenue) / previousMonthRevenue) * 100
      : 0;

  return {
    generatedAt: now.toISOString(),
    timezone: "IST",
    totals: {
      users: totalUsers,
      vendors: totalVendors,
      bookings: totalBookings,
      activeBookings,
    },
    bookings: {
      today: bookingsToday,
      thisMonth: bookingsThisMonth,
      completionRate: bookingCompletionRate,
      activeRate: activeBookingRate,
    },
    revenue: {
      gmvThisMonth: txAgg.gmv || 0,
      transactionsThisMonth: txAgg.count || 0,
      totalDiscounts: txAgg.totalDiscount || 0,
      avgOrderValue: txAgg.avgOrderValue || 0,
      currency: DEFAULT_CURRENCY,
      timeline: revenueTimeline,
      monthlyChange: Number(revenueChange.toFixed(2)),
    },
    referrals: {
      totalShares: shareCount,
      completed: shareCompleted,
      conversionPct: referralConversion,
    },
    vendors: {
      total: vendorStats.totalVendors || 0,
      active: vendorStats.activeVendors || 0,
      blocked: vendorStats.blockedVendors || 0,
      earnings: vendorStats.totalEarnings || 0,
      commission: vendorStats.totalCommission || 0,
      balance: vendorStats.totalBalance || 0,
      avgRating: Number((vendorStats.avgRating || 0).toFixed(2)),
      bookings: {
        pending: vendorStats.totalPending || 0,
        completed: vendorStats.totalCompleted || 0,
        canceled: vendorStats.totalCanceled || 0,
      },
    },
    recentActivities: recentActivities, // Add recent activities to response
  };
}

// ============================================
// CONTROLLER METHODS
// ============================================

/**
 * GET /api/admin/dashboard
 * Main dashboard data with caching
 */
exports.get_dashboard = async (req, res, next) => {
  try {
    // Check cache
    if (isCacheValid("dashboard")) {
      AdminLogger.debug("Dashboard served from cache");
      return res.status(200).json({
        success: true,
        cached: true,
        data: cache.dashboard.data,
      });
    }

    const data = await computeDashboard();
    setCache("dashboard", data);

    AdminLogger.info({ totals: data.totals }, "Dashboard computed successfully");

    return res.status(200).json({
      success: true,
      cached: false,
      data,
    });
  } catch (err) {
    AdminLogger.error({ err }, "Dashboard failed");
    return next(err);
  }
};

/**
 * POST /api/admin/dashboard/refresh
 * Force refresh dashboard cache
 */
exports.refresh_dashboard = async (req, res, next) => {
  try {
    const data = await computeDashboard();
    setCache("dashboard", data);

    AdminLogger.info("Dashboard cache force refreshed");

    return res.status(200).json({
      success: true,
      message: "Cache refreshed successfully",
      data,
    });
  } catch (err) {
    AdminLogger.error({ err }, "Dashboard refresh failed");
    return next(err);
  }
};

/**
 * DELETE /api/admin/dashboard/cache
 * Clear dashboard cache
 */
exports.clear_dashboard_cache = async (req, res, next) => {
  try {
    cache.dashboard = { at: 0, data: null };
    AdminLogger.info("Dashboard cache cleared");
    return res.status(200).json({
      success: true,
      message: "Cache cleared successfully",
    });
  } catch (err) {
    AdminLogger.error({ err }, "Cache clear failed");
    return next(err);
  }
};

// ============================================
// USER ANALYTICS
// ============================================

/**
 * GET /api/admin/analytics/users
 * Detailed user analytics with pagination and search
 */
exports.getUserAnalytics = async (req, res, next) => {
  try {
    const {
      period = "month",
      from,
      to,
      status = "all",
      page = 1,
      limit = 10,
      search = "",
    } = req.query;

    // Parse pagination values
    const pageNum = parseInt(page, 10) || 1;
    const limitNum = parseInt(limit, 10) || 10;
    const skip = (pageNum - 1) * limitNum;

    // Build date filter
    const dateFilter = {};
    if (from) dateFilter.$gte = new Date(from);
    if (to) dateFilter.$lte = new Date(to);

    // Build status filter
    const statusFilter = status !== "all" ? { status } : {};

    // Build search filter
    const searchFilter = search
      ? {
          $or: [
            { name: { $regex: search, $options: "i" } },
            { email: { $regex: search, $options: "i" } },
            { phoneNo: { $regex: search, $options: "i" } },
          ],
        }
      : {};

    // Combine all filters
    const matchFilter = {
      ...statusFilter,
      ...searchFilter,
      ...(dateFilter.$gte || dateFilter.$lte ? { accountCreatedOn: dateFilter } : {}),
    };

    // Get total counts with filters
    const [totalUsers, activeUsers, blockedUsers, users] = await Promise.all([
      User.countDocuments(matchFilter),
      User.countDocuments({ ...matchFilter, status: "active" }),
      User.countDocuments({ ...matchFilter, status: "blocked" }),
      User.find(matchFilter)
        .sort({ accountCreatedOn: -1 })
        .skip(skip)
        .limit(limitNum)
        .select(
          "name email phoneNo status accountCreatedOn bookingCount shareCount transactionCount " +
            "balance gender pincode pending completed canceled earning " +
            "pendingShareBy completedShareBy canceledShareBy",
        )
        .lean(),
    ]);

    // Get growth over time (for chart data)
    const growth = await User.aggregate([
      {
        $match: {
          ...statusFilter,
          ...searchFilter,
          ...(dateFilter.$gte || dateFilter.$lte ? { accountCreatedOn: dateFilter } : {}),
        },
      },
      {
        $group: {
          _id: {
            $dateTrunc: {
              date: "$accountCreatedOn",
              unit:
                period === "day"
                  ? "day"
                  : period === "week"
                    ? "week"
                    : period === "month"
                      ? "month"
                      : "year",
            },
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    // Get user engagement metrics
    const engagement = await User.aggregate([
      {
        $match: {
          ...statusFilter,
          ...searchFilter,
        },
      },
      {
        $group: {
          _id: null,
          avgBookings: { $avg: "$bookingCount" },
          avgTransactions: { $avg: "$transactionCount" },
          avgShares: { $avg: "$shareCount" },
          avgBalance: { $avg: "$balance" },
          totalBalance: { $sum: "$balance" },
          avgPending: { $avg: "$pending" },
          avgCompleted: { $avg: "$completed" },
          avgCanceled: { $avg: "$canceled" },
          avgEarning: { $avg: "$earning" },
          totalEarnings: { $sum: "$earning" },
          // Share stats
          avgPendingShareBy: { $avg: "$pendingShareBy" },
          avgCompletedShareBy: { $avg: "$completedShareBy" },
          avgCanceledShareBy: { $avg: "$canceledShareBy" },
          totalPendingShareBy: { $sum: "$pendingShareBy" },
          totalCompletedShareBy: { $sum: "$completedShareBy" },
          totalCanceledShareBy: { $sum: "$canceledShareBy" },
        },
      },
    ]);

    // Get user type distribution (by gender)
    const genderDistribution = await User.aggregate([
      {
        $match: {
          ...statusFilter,
          ...searchFilter,
        },
      },
      {
        $group: {
          _id: "$gender",
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 } },
    ]);

    // Format growth data for chart
    const formattedGrowth = growth.map((item) => ({
      date: item._id,
      count: item.count,
    }));

    const engagementData = engagement[0] || {
      avgBookings: 0,
      avgTransactions: 0,
      avgShares: 0,
      avgBalance: 0,
      totalBalance: 0,
      avgPending: 0,
      avgCompleted: 0,
      avgCanceled: 0,
      avgEarning: 0,
      totalEarnings: 0,
      avgPendingShareBy: 0,
      avgCompletedShareBy: 0,
      avgCanceledShareBy: 0,
      totalPendingShareBy: 0,
      totalCompletedShareBy: 0,
      totalCanceledShareBy: 0,
    };

    return res.status(200).json({
      success: true,
      data: {
        users: users,
        totals: {
          total: totalUsers,
          active: activeUsers,
          blocked: blockedUsers,
        },
        growth: formattedGrowth,
        engagement: {
          avgBookings: Number(engagementData.avgBookings?.toFixed(2) || 0),
          avgTransactions: Number(engagementData.avgTransactions?.toFixed(2) || 0),
          avgShares: Number(engagementData.avgShares?.toFixed(2) || 0),
          avgBalance: Number(engagementData.avgBalance?.toFixed(2) || 0),
          totalBalance: engagementData.totalBalance || 0,
          avgEarning: Number(engagementData.avgEarning?.toFixed(2) || 0),
          totalEarnings: engagementData.totalEarnings || 0,
          bookingStats: {
            avgPending: Number(engagementData.avgPending?.toFixed(2) || 0),
            avgCompleted: Number(engagementData.avgCompleted?.toFixed(2) || 0),
            avgCanceled: Number(engagementData.avgCanceled?.toFixed(2) || 0),
          },
          shareStats: {
            avgPendingShareBy: Number(engagementData.avgPendingShareBy?.toFixed(2) || 0),
            avgCompletedShareBy: Number(engagementData.avgCompletedShareBy?.toFixed(2) || 0),
            avgCanceledShareBy: Number(engagementData.avgCanceledShareBy?.toFixed(2) || 0),
            totalPendingShareBy: engagementData.totalPendingShareBy || 0,
            totalCompletedShareBy: engagementData.totalCompletedShareBy || 0,
            totalCanceledShareBy: engagementData.totalCanceledShareBy || 0,
          },
        },
        genderDistribution: genderDistribution,
        pagination: {
          page: pageNum,
          limit: limitNum,
          total: totalUsers,
          totalPages: Math.ceil(totalUsers / limitNum),
        },
        period,
        from: from || null,
        to: to || null,
        status,
        search: search || null,
      },
    });
  } catch (err) {
    AdminLogger.error({ err }, "User analytics failed");
    return next(err);
  }
};

/**
 * GET /api/admin/analytics/users/:userId
 * Get detailed analytics for a specific user
 */
exports.getUserDetailAnalytics = async (req, res, next) => {
  try {
    const { userId } = req.params;
    const { from, to } = req.query;

    const user = await User.findById(userId)
      .select(
        "name email phoneNo gender pincode balance status accountCreatedOn " +
          "bookingCount shareCount transactionCount earning " +
          "pending completed canceled " +
          "pendingShareBy completedShareBy canceledShareBy",
      )
      .lean();

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    const dateFilter = {};
    if (from) dateFilter.$gte = new Date(from);
    if (to) dateFilter.$lte = new Date(to);

    // Get booking details for this user
    const bookings = await Bookings.aggregate([
      {
        $match: {
          userId: user._id,
          ...(from ? { createdAt: { $gte: new Date(from) } } : {}),
          ...(to ? { createdAt: { $lte: new Date(to) } } : {}),
        },
      },
      {
        $facet: {
          total: [{ $count: "count" }],
          completed: [{ $match: { orderCompleted: true } }, { $count: "count" }],
          cancelled: [{ $match: { cancelOrder: true } }, { $count: "count" }],
          active: [{ $match: { cancelOrder: false, orderCompleted: false } }, { $count: "count" }],
          timeline: [
            {
              $group: {
                _id: {
                  $dateToString: { format: "%Y-%m-%d", date: "$createdAt" },
                },
                count: { $sum: 1 },
                completed: {
                  $sum: { $cond: [{ $eq: ["$orderCompleted", true] }, 1, 0] },
                },
                cancelled: {
                  $sum: { $cond: [{ $eq: ["$cancelOrder", true] }, 1, 0] },
                },
              },
            },
            { $sort: { _id: 1 } },
          ],
          byVendor: [
            {
              $group: {
                _id: "$vendorId",
                count: { $sum: 1 },
                completed: {
                  $sum: { $cond: [{ $eq: ["$orderCompleted", true] }, 1, 0] },
                },
                totalSpent: { $sum: "$expenseUser" },
              },
            },
            {
              $lookup: {
                from: "vendors",
                localField: "_id",
                foreignField: "_id",
                as: "vendor",
              },
            },
            { $unwind: { path: "$vendor", preserveNullAndEmptyArrays: true } },
            {
              $project: {
                vendorName: "$vendor.name",
                vendorId: "$_id",
                count: 1,
                completed: 1,
                totalSpent: 1,
              },
            },
            { $sort: { count: -1 } },
            { $limit: 5 },
          ],
          ratingDistribution: [
            {
              $group: {
                _id: "$rating",
                count: { $sum: 1 },
              },
            },
            { $sort: { _id: -1 } },
          ],
        },
      },
    ]);

    // Get transaction details for this user
    const transactions = await Transaction.aggregate([
      {
        $match: {
          userId: user._id,
          status: "completed",
          ...(from ? { createdAt: { $gte: new Date(from) } } : {}),
          ...(to ? { createdAt: { $lte: new Date(to) } } : {}),
        },
      },
      {
        $group: {
          _id: null,
          totalSpent: { $sum: "$finalAmount" },
          totalDiscounts: { $sum: "$discount" },
          count: { $sum: 1 },
          avgOrderValue: { $avg: "$finalAmount" },
        },
      },
    ]);

    // Get share/referral details for this user
    const shares = await Share.aggregate([
      {
        $match: {
          userId: user._id,
          ...(from ? { shareDate: { $gte: new Date(from) } } : {}),
          ...(to ? { shareDate: { $lte: new Date(to) } } : {}),
        },
      },
      {
        $group: {
          _id: "$status",
          count: { $sum: 1 },
        },
      },
    ]);

    // Get booking patterns by day of week
    const patterns = await Bookings.aggregate([
      {
        $match: {
          userId: user._id,
          ...(from ? { createdAt: { $gte: new Date(from) } } : {}),
          ...(to ? { createdAt: { $lte: new Date(to) } } : {}),
        },
      },
      {
        $group: {
          _id: {
            dayOfWeek: { $dayOfWeek: "$createdAt" },
            hour: { $hour: "$createdAt" },
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { "_id.dayOfWeek": 1, "_id.hour": 1 } },
    ]);

    // Get booking by type
    const bookingByType = await Bookings.aggregate([
      {
        $match: {
          userId: user._id,
          ...(from ? { createdAt: { $gte: new Date(from) } } : {}),
          ...(to ? { createdAt: { $lte: new Date(to) } } : {}),
        },
      },
      {
        $group: {
          _id: "$type",
          count: { $sum: 1 },
          completed: {
            $sum: { $cond: [{ $eq: ["$orderCompleted", true] }, 1, 0] },
          },
        },
      },
      { $sort: { count: -1 } },
    ]);

    const bookingStats = bookings[0] || {
      total: [{ count: 0 }],
      completed: [{ count: 0 }],
      cancelled: [{ count: 0 }],
      active: [{ count: 0 }],
      timeline: [],
      byVendor: [],
      ratingDistribution: [],
    };

    const shareMap = {
      pending: 0,
      accepted: 0,
      rejected: 0,
      completed: 0,
    };
    shares.forEach((s) => {
      shareMap[s._id] = s.count;
    });

    return res.status(200).json({
      success: true,
      data: {
        user: {
          id: user._id,
          name: user.name,
          email: user.email,
          phoneNo: user.phoneNo,
          gender: user.gender,
          pincode: user.pincode,
          balance: user.balance,
          status: user.status,
          accountCreatedOn: user.accountCreatedOn,
          bookingCount: user.bookingCount,
          shareCount: user.shareCount,
          transactionCount: user.transactionCount,
          earning: user.earning,
          bookingStats: {
            pending: user.pending || 0,
            completed: user.completed || 0,
            canceled: user.canceled || 0,
          },
          shareStats: {
            pendingShareBy: user.pendingShareBy || 0,
            completedShareBy: user.completedShareBy || 0,
            canceledShareBy: user.canceledShareBy || 0,
          },
        },
        bookings: {
          total: bookingStats.total[0]?.count || 0,
          completed: bookingStats.completed[0]?.count || 0,
          cancelled: bookingStats.cancelled[0]?.count || 0,
          active: bookingStats.active[0]?.count || 0,
          timeline: bookingStats.timeline || [],
          byVendor: bookingStats.byVendor || [],
          ratingDistribution: bookingStats.ratingDistribution || [],
        },
        bookingByType: bookingByType,
        transactions: {
          totalSpent: transactions[0]?.totalSpent || 0,
          totalDiscounts: transactions[0]?.totalDiscounts || 0,
          transactionCount: transactions[0]?.count || 0,
          avgOrderValue: transactions[0]?.avgOrderValue || 0,
        },
        referrals: {
          pending: shareMap.pending || 0,
          accepted: shareMap.accepted || 0,
          rejected: shareMap.rejected || 0,
          completed: shareMap.completed || 0,
          total: Object.values(shareMap).reduce((a, b) => a + b, 0),
        },
        patterns,
        from: from || null,
        to: to || null,
      },
    });
  } catch (err) {
    AdminLogger.error({ err }, "User detail analytics failed");
    return next(err);
  }
};
// ============================================
// VENDOR ANALYTICS
// ============================================

/**
 * GET /api/admin/analytics/vendors
 * Get paginated vendor list with filters, summary stats, and leave information
 * This is optimized for the main vendors table view
 */

exports.getVendorAnalytics = async (req, res, next) => {
  try {
    const {
      period = "month",
      from,
      to,
      status = "all",
      sortBy = "rating",
      type = "all",
      page = 1,
      limit = 10,
      search = "",
    } = req.query;

    // ============================================================
    // PAGINATION
    // ============================================================

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);

    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 100);

    const skip = (pageNum - 1) * limitNum;

    // ============================================================
    // DATE FILTER
    // ============================================================

    const dateFilter = {};

    if (from) {
      const fromDate = new Date(from);

      if (!Number.isNaN(fromDate.getTime())) {
        dateFilter.$gte = fromDate;
      }
    }

    if (to) {
      const toDate = new Date(to);

      if (!Number.isNaN(toDate.getTime())) {
        dateFilter.$lte = toDate;
      }
    }

    // ============================================================
    // STATUS FILTER
    // ============================================================

    const statusFilter =
      status && status !== "all"
        ? {
            status,
          }
        : {};

    // ============================================================
    // TYPE FILTER
    //
    // Vendor.type is an ARRAY.
    //
    // Example:
    //
    // type: [
    //   "mason",
    //   "contractor"
    // ]
    // ============================================================

    const typeFilter =
      type && type !== "all"
        ? {
            type: {
              $in: [type],
            },
          }
        : {};

    // ============================================================
    // SEARCH FILTER
    // ============================================================

    const searchFilter =
      search && String(search).trim()
        ? {
            $or: [
              {
                name: {
                  $regex: String(search).trim(),
                  $options: "i",
                },
              },
              {
                email: {
                  $regex: String(search).trim(),
                  $options: "i",
                },
              },
              {
                phoneNo: {
                  $regex: String(search).trim(),
                  $options: "i",
                },
              },
              {
                pincode: {
                  $regex: String(search).trim(),
                  $options: "i",
                },
              },
            ],
          }
        : {};

    // ============================================================
    // COMBINED FILTER
    // ============================================================

    const matchFilter = {
      ...statusFilter,
      ...typeFilter,
      ...searchFilter,

      ...(dateFilter.$gte || dateFilter.$lte
        ? {
            accountCreatedOn: dateFilter,
          }
        : {}),
    };

    // ============================================================
    // VENDOR DATA
    // ============================================================

    const [totalVendors, activeVendors, blockedVendors, verifiedVendors, rawVendors] =
      await Promise.all([
        // Total
        Vendor.countDocuments(matchFilter),

        // Active
        Vendor.countDocuments({
          ...matchFilter,
          status: "active",
        }),

        // Blocked
        Vendor.countDocuments({
          ...matchFilter,
          status: "blocked",
        }),

        // Verified
        Vendor.countDocuments({
          ...matchFilter,
          isVerified: true,
        }),

        // Vendors
        Vendor.find(matchFilter)
          .sort({
            [sortBy]: -1,
          })
          .skip(skip)
          .limit(limitNum)
          .select(
            "name email phoneNo type rating ratingCount earning commission balance " +
              "bookingCount bookingCountVendor pending completed canceled " +
              "pendingVendor completedVendor canceledVendor " +
              "pendingShareBy completedShareBy canceledShareBy " +
              "isVerified status accountCreatedOn shareCount pincode address experience gender " +
              "wageRate wageRateType totalDiscount totalOriginalAmount transactionCount",
          )
          .lean(),
      ]);

    // ============================================================
    // NORMALIZE VENDOR DATA
    //
    // IMPORTANT:
    //
    // MongoDB:
    //
    // type         = ["mason", "contractor"]
    // wageRate     = [700, 350]
    // wageRateType = ["Day", "Per square feet"]
    //
    // becomes:
    //
    // jobs = [
    //   {
    //     type: "mason",
    //     wageRate: 700,
    //     wageRateType: "Day"
    //   },
    //   {
    //     type: "contractor",
    //     wageRate: 350,
    //     wageRateType: "Per square feet"
    //   }
    // ]
    // ============================================================

    const vendors = rawVendors.map((vendor) => {
      const types = Array.isArray(vendor.type) ? vendor.type : vendor.type ? [vendor.type] : [];

      const wageRates = Array.isArray(vendor.wageRate)
        ? vendor.wageRate
        : vendor.wageRate !== undefined && vendor.wageRate !== null
          ? [vendor.wageRate]
          : [];

      const wageRateTypes = Array.isArray(vendor.wageRateType)
        ? vendor.wageRateType
        : vendor.wageRateType
          ? [vendor.wageRateType]
          : [];

      // Use the largest array length
      // so no data is lost.
      const jobCount = Math.max(types.length, wageRates.length, wageRateTypes.length);

      const jobs = Array.from(
        {
          length: jobCount,
        },
        (_, index) => ({
          type: types[index] || "",

          wageRate: wageRates[index] !== undefined ? Number(wageRates[index]) : 0,

          wageRateType: wageRateTypes[index] || "",
        }),
      ).filter((job) => job.type || job.wageRate || job.wageRateType);

      return {
        ...vendor,

        // ALWAYS ARRAYS
        type: types,

        wageRate: wageRates,

        wageRateType: wageRateTypes,

        // NORMALIZED JOBS
        jobs,
      };
    });

    // ============================================================
    // VENDOR IDS
    // ============================================================

    const vendorIds = vendors.map((vendor) => vendor._id);

    // ============================================================
    // LEAVE DATA
    // ============================================================

    let leaveStats = [];

    const leaveMap = {};

    if (vendorIds.length > 0) {
      leaveStats = await VendorLeave.aggregate([
        {
          $match: {
            vendorId: {
              $in: vendorIds,
            },

            status: "active",
          },
        },

        {
          $group: {
            _id: "$vendorId",

            activeLeaveCount: {
              $sum: 1,
            },

            leaves: {
              $push: {
                from: "$from",
                to: "$to",
                reason: "$reason",
                status: "$status",
              },
            },
          },
        },
      ]);

      leaveStats.forEach((stat) => {
        leaveMap[stat._id.toString()] = {
          activeLeaveCount: stat.activeLeaveCount,

          leaves: stat.leaves,
        };
      });
    }

    // ============================================================
    // ATTACH LEAVE INFORMATION
    // ============================================================

    const vendorsWithLeaves = vendors.map((vendor) => {
      const vendorId = vendor._id.toString();

      return {
        ...vendor,

        leaveInfo: leaveMap[vendorId] || {
          activeLeaveCount: 0,
          leaves: [],
        },
      };
    });

    // ============================================================
    // VENDOR GROWTH
    // ============================================================

    const growth = await Vendor.aggregate([
      {
        $match: matchFilter,
      },

      {
        $group: {
          _id: {
            $dateTrunc: {
              date: "$accountCreatedOn",

              unit:
                period === "day"
                  ? "day"
                  : period === "week"
                    ? "week"
                    : period === "year"
                      ? "year"
                      : "month",
            },
          },

          count: {
            $sum: 1,
          },
        },
      },

      {
        $sort: {
          _id: 1,
        },
      },
    ]);

    // ============================================================
    // PERFORMANCE
    // ============================================================

    const performance = await Vendor.aggregate([
      {
        $match: matchFilter,
      },

      {
        $group: {
          _id: null,

          avgRating: {
            $avg: "$rating",
          },

          avgEarnings: {
            $avg: "$earning",
          },

          avgCommission: {
            $avg: "$commission",
          },

          avgBalance: {
            $avg: "$balance",
          },

          totalEarnings: {
            $sum: {
              $ifNull: ["$earning", 0],
            },
          },

          totalCommission: {
            $sum: {
              $ifNull: ["$commission", 0],
            },
          },

          totalBalance: {
            $sum: {
              $ifNull: ["$balance", 0],
            },
          },

          // USER BOOKING STATS

          totalPending: {
            $sum: {
              $ifNull: ["$pending", 0],
            },
          },

          totalCompleted: {
            $sum: {
              $ifNull: ["$completed", 0],
            },
          },

          totalCanceled: {
            $sum: {
              $ifNull: ["$canceled", 0],
            },
          },

          // VENDOR BOOKING STATS

          totalPendingVendor: {
            $sum: {
              $ifNull: ["$pendingVendor", 0],
            },
          },

          totalCompletedVendor: {
            $sum: {
              $ifNull: ["$completedVendor", 0],
            },
          },

          totalCanceledVendor: {
            $sum: {
              $ifNull: ["$canceledVendor", 0],
            },
          },

          // SHARE STATS

          totalPendingShareBy: {
            $sum: {
              $ifNull: ["$pendingShareBy", 0],
            },
          },

          totalCompletedShareBy: {
            $sum: {
              $ifNull: ["$completedShareBy", 0],
            },
          },

          totalCanceledShareBy: {
            $sum: {
              $ifNull: ["$canceledShareBy", 0],
            },
          },

          // BOOKINGS

          totalBookings: {
            $sum: {
              $ifNull: ["$bookingCount", 0],
            },
          },

          totalBookingCountVendor: {
            $sum: {
              $ifNull: ["$bookingCountVendor", 0],
            },
          },

          totalShareCount: {
            $sum: {
              $ifNull: ["$shareCount", 0],
            },
          },

          avgPending: {
            $avg: "$pending",
          },

          avgCompleted: {
            $avg: "$completed",
          },

          avgCanceled: {
            $avg: "$canceled",
          },

          totalTransactionCount: {
            $sum: {
              $ifNull: ["$transactionCount", 0],
            },
          },

          totalDiscount: {
            $sum: {
              $ifNull: ["$totalDiscount", 0],
            },
          },

          totalOriginalAmount: {
            $sum: {
              $ifNull: ["$totalOriginalAmount", 0],
            },
          },
        },
      },
    ]);

    // ============================================================
    // OVERALL LEAVE STATS
    // ============================================================

    const overallLeaveStats = vendorIds.length
      ? await VendorLeave.aggregate([
          {
            $match: {
              vendorId: {
                $in: vendorIds,
              },
            },
          },

          {
            $group: {
              _id: null,

              totalLeaves: {
                $sum: 1,
              },

              activeLeaves: {
                $sum: {
                  $cond: [
                    {
                      $eq: ["$status", "active"],
                    },
                    1,
                    0,
                  ],
                },
              },

              cancelledLeaves: {
                $sum: {
                  $cond: [
                    {
                      $eq: ["$status", "cancelled"],
                    },
                    1,
                    0,
                  ],
                },
              },

              currentActiveLeaves: {
                $sum: {
                  $cond: [
                    {
                      $and: [
                        {
                          $eq: ["$status", "active"],
                        },

                        {
                          $lte: ["$from", new Date()],
                        },

                        {
                          $gte: ["$to", new Date()],
                        },
                      ],
                    },

                    1,

                    0,
                  ],
                },
              },
            },
          },
        ])
      : [];

    // ============================================================
    // VENDOR TYPE DISTRIBUTION
    //
    // IMPORTANT:
    //
    // If one vendor has:
    //
    // ["mason", "contractor"]
    //
    // this counts:
    //
    // mason      +1 vendor
    // contractor +1 vendor
    //
    // ============================================================

    const typeDistribution = await Vendor.aggregate([
      {
        $match: matchFilter,
      },

      {
        $unwind: {
          path: "$type",

          preserveNullAndEmptyArrays: false,
        },
      },

      {
        $group: {
          _id: "$type",

          vendorCount: {
            $sum: 1,
          },

          avgRating: {
            $avg: {
              $ifNull: ["$rating", 0],
            },
          },

          totalEarnings: {
            $sum: {
              $ifNull: ["$earning", 0],
            },
          },

          totalBookings: {
            $sum: {
              $ifNull: ["$bookingCount", 0],
            },
          },

          completedBookings: {
            $sum: {
              $ifNull: ["$completed", 0],
            },
          },

          cancelledBookings: {
            $sum: {
              $ifNull: ["$canceled", 0],
            },
          },

          activeBookings: {
            $sum: {
              $ifNull: ["$pending", 0],
            },
          },
        },
      },

      {
        $project: {
          _id: 0,

          type: "$_id",

          vendorCount: 1,

          avgRating: {
            $round: [
              {
                $ifNull: ["$avgRating", 0],
              },
              2,
            ],
          },

          totalEarnings: 1,

          totalBookings: 1,

          completedBookings: 1,

          cancelledBookings: 1,

          activeBookings: 1,

          completionRate: {
            $cond: [
              {
                $eq: ["$totalBookings", 0],
              },

              0,

              {
                $round: [
                  {
                    $multiply: [
                      {
                        $divide: ["$completedBookings", "$totalBookings"],
                      },

                      100,
                    ],
                  },

                  2,
                ],
              },
            ],
          },
        },
      },

      {
        $sort: {
          vendorCount: -1,
        },
      },
    ]);

    // ============================================================
    // BOOKING TRENDS
    // ============================================================

    const bookingTrends = await Bookings.aggregate([
      {
        $match: {
          ...(from
            ? {
                createdAt: {
                  $gte: new Date(from),
                },
              }
            : {}),

          ...(to
            ? {
                createdAt: {
                  $lte: new Date(to),
                },
              }
            : {}),

          vendorId: {
            $exists: true,
            $ne: null,
          },
        },
      },

      {
        $group: {
          _id: "$vendorId",

          totalBookings: {
            $sum: 1,
          },

          completedBookings: {
            $sum: {
              $cond: [
                {
                  $eq: ["$orderCompleted", true],
                },
                1,
                0,
              ],
            },
          },

          cancelledBookings: {
            $sum: {
              $cond: [
                {
                  $eq: ["$cancelOrder", true],
                },
                1,
                0,
              ],
            },
          },
        },
      },

      {
        $lookup: {
          from: "vendors",

          localField: "_id",

          foreignField: "_id",

          as: "vendor",
        },
      },

      {
        $unwind: {
          path: "$vendor",

          preserveNullAndEmptyArrays: true,
        },
      },

      {
        $project: {
          _id: 0,

          vendorId: "$_id",

          vendorName: "$vendor.name",

          // COMPLETE ARRAY
          vendorType: "$vendor.type",

          // COMPLETE ARRAY
          wageRate: "$vendor.wageRate",

          // COMPLETE ARRAY
          wageRateType: "$vendor.wageRateType",

          totalBookings: 1,

          completedBookings: 1,

          cancelledBookings: 1,

          completionRate: {
            $cond: [
              {
                $eq: ["$totalBookings", 0],
              },

              0,

              {
                $round: [
                  {
                    $multiply: [
                      {
                        $divide: ["$completedBookings", "$totalBookings"],
                      },

                      100,
                    ],
                  },

                  2,
                ],
              },
            ],
          },
        },
      },

      {
        $sort: {
          totalBookings: -1,
        },
      },

      {
        $limit: 10,
      },
    ]);

    // ============================================================
    // PINCODE DISTRIBUTION
    // ============================================================

    const pincodeDistribution = await Vendor.aggregate([
      {
        $match: {
          ...matchFilter,

          pincode: {
            $exists: true,

            $ne: null,

            $ne: "",
          },
        },
      },

      {
        $group: {
          _id: "$pincode",

          count: {
            $sum: 1,
          },
        },
      },

      {
        $sort: {
          count: -1,
        },
      },

      {
        $limit: 10,
      },

      {
        $project: {
          _id: 0,

          pincode: "$_id",

          count: 1,
        },
      },
    ]);

    // ============================================================
    // DEFAULT PERFORMANCE
    // ============================================================

    const perf = performance[0] || {
      avgRating: 0,
      avgEarnings: 0,
      avgCommission: 0,
      avgBalance: 0,

      totalEarnings: 0,
      totalCommission: 0,
      totalBalance: 0,

      totalPending: 0,
      totalCompleted: 0,
      totalCanceled: 0,

      totalPendingVendor: 0,
      totalCompletedVendor: 0,
      totalCanceledVendor: 0,

      totalPendingShareBy: 0,
      totalCompletedShareBy: 0,
      totalCanceledShareBy: 0,

      totalBookings: 0,
      totalBookingCountVendor: 0,

      totalShareCount: 0,

      avgPending: 0,
      avgCompleted: 0,
      avgCanceled: 0,

      totalTransactionCount: 0,
      totalDiscount: 0,
      totalOriginalAmount: 0,
    };

    // ============================================================
    // DEFAULT LEAVE DATA
    // ============================================================

    const leaveOverall = overallLeaveStats[0] || {
      totalLeaves: 0,
      activeLeaves: 0,
      cancelledLeaves: 0,
      currentActiveLeaves: 0,
    };

    // ============================================================
    // RESPONSE
    // ============================================================

    return res.status(200).json({
      success: true,

      data: {
        // ========================================================
        // VENDORS
        // ========================================================

        vendors: vendorsWithLeaves,

        // ========================================================
        // TOTAL COUNTS
        // ========================================================

        totals: {
          total: totalVendors,

          active: activeVendors,

          blocked: blockedVendors,

          verified: verifiedVendors,
        },

        // ========================================================
        // GROWTH
        // ========================================================

        growth,

        // ========================================================
        // PERFORMANCE
        // ========================================================

        performance: {
          avgRating: Number((perf.avgRating || 0).toFixed(2)),

          avgEarnings: perf.avgEarnings || 0,

          avgCommission: perf.avgCommission || 0,

          avgBalance: perf.avgBalance || 0,

          totalEarnings: perf.totalEarnings || 0,

          totalCommission: perf.totalCommission || 0,

          totalBalance: perf.totalBalance || 0,

          bookingStats: {
            total: perf.totalBookings || 0,

            pending: perf.totalPending || 0,

            completed: perf.totalCompleted || 0,

            canceled: perf.totalCanceled || 0,

            avgPending: Number((perf.avgPending || 0).toFixed(2)),

            avgCompleted: Number((perf.avgCompleted || 0).toFixed(2)),

            avgCanceled: Number((perf.avgCanceled || 0).toFixed(2)),

            pendingVendor: perf.totalPendingVendor || 0,

            completedVendor: perf.totalCompletedVendor || 0,

            canceledVendor: perf.totalCanceledVendor || 0,

            pendingShareBy: perf.totalPendingShareBy || 0,

            completedShareBy: perf.totalCompletedShareBy || 0,

            canceledShareBy: perf.totalCanceledShareBy || 0,
          },

          shareCount: perf.totalShareCount || 0,

          transactionCount: perf.totalTransactionCount || 0,

          totalDiscount: perf.totalDiscount || 0,

          totalOriginalAmount: perf.totalOriginalAmount || 0,
        },

        // ========================================================
        // LEAVES
        // ========================================================

        leaveStats: {
          totalLeaves: leaveOverall.totalLeaves || 0,

          activeLeaves: leaveOverall.activeLeaves || 0,

          cancelledLeaves: leaveOverall.cancelledLeaves || 0,

          currentActiveLeaves: leaveOverall.currentActiveLeaves || 0,
        },

        // ========================================================
        // TOP VENDORS
        //
        // These still contain COMPLETE:
        //
        // type[]
        // wageRate[]
        // wageRateType[]
        // jobs[]
        // ========================================================

        topVendors: vendorsWithLeaves.slice(0, 5),

        // ========================================================
        // TYPE DISTRIBUTION
        // ========================================================

        typeDistribution,

        // ========================================================
        // BOOKING TRENDS
        // ========================================================

        bookingTrends,

        // ========================================================
        // PINCODE DISTRIBUTION
        // ========================================================

        pincodeDistribution,

        // ========================================================
        // PAGINATION
        // ========================================================

        pagination: {
          page: pageNum,

          limit: limitNum,

          total: totalVendors,

          totalPages: Math.ceil(totalVendors / limitNum),
        },

        // ========================================================
        // FILTERS
        // ========================================================

        filters: {
          period,

          from: from || null,

          to: to || null,

          status,

          sortBy,

          type,

          search: search || null,
        },
      },
    });
  } catch (err) {
    AdminLogger.error(
      {
        err,
      },
      "Vendor analytics failed",
    );

    return next(err);
  }
};

/**
 * GET /api/admin/analytics/vendors/:vendorId
 * Get detailed analytics for a specific vendor including:
 * - Complete vendor profile with all fields
 * - Booking timeline and statistics
 * - Revenue and transaction details
 * - Referral/share stats
 * - Leave information with status tracking
 * - Top users who booked this vendor
 * - Booking patterns
 */
exports.getVendorDetailAnalytics = async (req, res, next) => {
  try {
    const { vendorId } = req.params;
    const { from, to } = req.query;

    // Get vendor with all relevant fields
    const vendor = await Vendor.findById(vendorId)
      .select(
        "name email phoneNo type rating ratingCount earning commission balance " +
          "bookingCount bookingCountVendor pending completed canceled " +
          "pendingVendor completedVendor canceledVendor " +
          "pendingShareBy completedShareBy canceledShareBy " +
          "isVerified status accountCreatedOn shareCount pincode address experience " +
          "gender wageRate wageRateType totalDiscount totalOriginalAmount transactionCount " +
          "verifyPhoneNo verifyEmail imgURL validPhoneNoId validEmailId " +
          "isSelfBooked agreedToTnCnP createdAt updatedAt",
      )
      .lean();

    if (!vendor) {
      return res.status(404).json({
        success: false,
        message: "Vendor not found",
      });
    }

    // ============================================================
    // 1. BOOKING ANALYTICS
    // ============================================================

    const bookings = await Bookings.aggregate([
      {
        $match: {
          vendorId: vendor._id,
          ...(from ? { createdAt: { $gte: new Date(from) } } : {}),
          ...(to ? { createdAt: { $lte: new Date(to) } } : {}),
        },
      },
      {
        $facet: {
          total: [{ $count: "count" }],
          completed: [{ $match: { orderCompleted: true } }, { $count: "count" }],
          cancelled: [{ $match: { cancelOrder: true } }, { $count: "count" }],
          active: [{ $match: { cancelOrder: false, orderCompleted: false } }, { $count: "count" }],
          byUser: [{ $match: { bookingBy: "User" } }, { $count: "count" }],
          byVendor: [{ $match: { bookingBy: "Vendor" } }, { $count: "count" }],
          timeline: [
            {
              $group: {
                _id: {
                  $dateToString: { format: "%Y-%m-%d", date: "$createdAt" },
                },
                count: { $sum: 1 },
                completed: {
                  $sum: { $cond: [{ $eq: ["$orderCompleted", true] }, 1, 0] },
                },
                cancelled: {
                  $sum: { $cond: [{ $eq: ["$cancelOrder", true] }, 1, 0] },
                },
              },
            },
            { $sort: { _id: 1 } },
          ],
          ratingDistribution: [
            {
              $group: {
                _id: "$rating",
                count: { $sum: 1 },
              },
            },
            { $sort: { _id: -1 } },
          ],
          byStatus: [
            {
              $group: {
                _id: {
                  $cond: [
                    { $eq: ["$orderCompleted", true] },
                    "completed",
                    {
                      $cond: [{ $eq: ["$cancelOrder", true] }, "cancelled", "active"],
                    },
                  ],
                },
                count: { $sum: 1 },
              },
            },
          ],
        },
      },
    ]);

    // ============================================================
    // 2. TRANSACTION ANALYTICS
    // ============================================================

    const transactions = await Transaction.aggregate([
      {
        $match: {
          vendorId: vendor._id,
          status: "completed",
          ...(from ? { createdAt: { $gte: new Date(from) } } : {}),
          ...(to ? { createdAt: { $lte: new Date(to) } } : {}),
        },
      },
      {
        $group: {
          _id: null,
          totalRevenue: { $sum: "$amount" },
          totalDiscounts: { $sum: "$discount" },
          count: { $sum: 1 },
          avgOrderValue: { $avg: "$finalAmount" },
          minOrderValue: { $min: "$finalAmount" },
          maxOrderValue: { $max: "$finalAmount" },
        },
      },
    ]);

    // Transaction timeline for charts
    const transactionTimeline = await Transaction.aggregate([
      {
        $match: {
          vendorId: vendor._id,
          status: "completed",
          ...(from ? { createdAt: { $gte: new Date(from) } } : {}),
          ...(to ? { createdAt: { $lte: new Date(to) } } : {}),
        },
      },
      {
        $group: {
          _id: {
            $dateToString: { format: "%Y-%m-%d", date: "$createdAt" },
          },
          totalAmount: { $sum: "$amount" },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    // ============================================================
    // 3. REFERRAL/SHARE ANALYTICS
    // ============================================================

    const shares = await Share.aggregate([
      {
        $match: {
          vendorId: vendor._id,
          ...(from ? { shareDate: { $gte: new Date(from) } } : {}),
          ...(to ? { shareDate: { $lte: new Date(to) } } : {}),
        },
      },
      {
        $group: {
          _id: "$status",
          count: { $sum: 1 },
        },
      },
    ]);

    // Share timeline
    const shareTimeline = await Share.aggregate([
      {
        $match: {
          vendorId: vendor._id,
          ...(from ? { shareDate: { $gte: new Date(from) } } : {}),
          ...(to ? { shareDate: { $lte: new Date(to) } } : {}),
        },
      },
      {
        $group: {
          _id: {
            $dateToString: { format: "%Y-%m-%d", date: "$shareDate" },
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    // ============================================================
    // 4. LEAVE ANALYTICS
    // ============================================================

    const leaves = await VendorLeave.find({ vendorId: vendor._id }).sort({ from: -1 }).lean();

    // Get leave stats
    const leaveStats = await VendorLeave.aggregate([
      { $match: { vendorId: vendor._id } },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          active: {
            $sum: { $cond: [{ $eq: ["$status", "active"] }, 1, 0] },
          },
          cancelled: {
            $sum: { $cond: [{ $eq: ["$status", "cancelled"] }, 1, 0] },
          },
          currentActive: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ["$status", "active"] },
                    { $lte: ["$from", new Date()] },
                    { $gte: ["$to", new Date()] },
                  ],
                },
                1,
                0,
              ],
            },
          },
          totalDays: {
            $sum: {
              $divide: [{ $subtract: ["$to", "$from"] }, 1000 * 60 * 60 * 24],
            },
          },
        },
      },
    ]);

    // Get upcoming leaves
    const upcomingLeaves = leaves.filter((l) => {
      return l.status === "active" && new Date(l.from) > new Date();
    });

    // Get current active leaves
    const currentActiveLeaves = leaves.filter((l) => {
      const now = new Date();
      const from = new Date(l.from);
      const to = new Date(l.to);
      return l.status === "active" && from <= now && to >= now;
    });

    // ============================================================
    // 5. BOOKING PATTERNS
    // ============================================================

    const patterns = await Bookings.aggregate([
      {
        $match: {
          vendorId: vendor._id,
          ...(from ? { createdAt: { $gte: new Date(from) } } : {}),
          ...(to ? { createdAt: { $lte: new Date(to) } } : {}),
        },
      },
      {
        $group: {
          _id: {
            dayOfWeek: { $dayOfWeek: "$createdAt" },
            hour: { $hour: "$createdAt" },
          },
          count: { $sum: 1 },
          completed: {
            $sum: { $cond: [{ $eq: ["$orderCompleted", true] }, 1, 0] },
          },
        },
      },
      { $sort: { "_id.dayOfWeek": 1, "_id.hour": 1 } },
    ]);

    // ============================================================
    // 6. TOP USERS
    // ============================================================

    const topUsers = await Bookings.aggregate([
      {
        $match: {
          vendorId: vendor._id,
          ...(from ? { createdAt: { $gte: new Date(from) } } : {}),
          ...(to ? { createdAt: { $lte: new Date(to) } } : {}),
        },
      },
      {
        $group: {
          _id: "$userId",
          count: { $sum: 1 },
          completed: {
            $sum: { $cond: [{ $eq: ["$orderCompleted", true] }, 1, 0] },
          },
          totalSpent: { $sum: "$expenseUser" },
          lastBooking: { $max: "$createdAt" },
        },
      },
      { $sort: { count: -1 } },
      { $limit: 10 },
      {
        $lookup: {
          from: "users",
          localField: "_id",
          foreignField: "_id",
          as: "user",
        },
      },
      { $unwind: { path: "$user", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          userName: "$user.name",
          userEmail: "$user.email",
          userPhone: "$user.phoneNo",
          userId: "$_id",
          count: 1,
          completed: 1,
          totalSpent: 1,
          lastBooking: 1,
        },
      },
    ]);

    // ============================================================
    // 7. RATING ANALYSIS
    // ============================================================

    const ratingAnalysis = await Bookings.aggregate([
      {
        $match: {
          vendorId: vendor._id,
          rating: { $exists: true, $ne: null },
          ...(from ? { createdAt: { $gte: new Date(from) } } : {}),
          ...(to ? { createdAt: { $lte: new Date(to) } } : {}),
        },
      },
      {
        $group: {
          _id: "$rating",
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: -1 } },
    ]);

    // ============================================================
    // 8. PREPARE RESPONSE
    // ============================================================

    const bookingStats = bookings[0] || {
      total: [{ count: 0 }],
      completed: [{ count: 0 }],
      cancelled: [{ count: 0 }],
      active: [{ count: 0 }],
      byUser: [{ count: 0 }],
      byVendor: [{ count: 0 }],
      timeline: [],
      ratingDistribution: [],
      byStatus: [],
    };

    const shareMap = {};
    shares.forEach((s) => {
      shareMap[s._id] = s.count;
    });

    const leaveStatsData = leaveStats[0] || {
      total: 0,
      active: 0,
      cancelled: 0,
      currentActive: 0,
      totalDays: 0,
    };

    const transactionData = transactions[0] || {
      totalRevenue: 0,
      totalDiscounts: 0,
      count: 0,
      avgOrderValue: 0,
      minOrderValue: 0,
      maxOrderValue: 0,
    };

    return res.status(200).json({
      success: true,
      data: {
        // ===== VENDOR PROFILE =====
        vendor: {
          id: vendor._id,
          name: vendor.name,
          email: vendor.email,
          phoneNo: vendor.phoneNo,
          type: vendor.type,
          rating: vendor.rating,
          ratingCount: vendor.ratingCount,
          isVerified: vendor.isVerified,
          status: vendor.status,
          accountCreatedOn: vendor.accountCreatedOn,
          pincode: vendor.pincode,
          experience: vendor.experience,
          shareCount: vendor.shareCount,
          balance: vendor.balance,
          earning: vendor.earning,
          commission: vendor.commission,
          gender: vendor.gender,
          wageRate: vendor.wageRate,
          wageRateType: vendor.wageRateType,
          totalDiscount: vendor.totalDiscount,
          totalOriginalAmount: vendor.totalOriginalAmount,
          transactionCount: vendor.transactionCount,
          verifyPhoneNo: vendor.verifyPhoneNo,
          verifyEmail: vendor.verifyEmail,
          isSelfBooked: vendor.isSelfBooked,
          address: vendor.address,
          bookingStats: {
            bookingCount: vendor.bookingCount,
            bookingCountVendor: vendor.bookingCountVendor,
            pending: vendor.pending,
            completed: vendor.completed,
            canceled: vendor.canceled,
            pendingVendor: vendor.pendingVendor,
            completedVendor: vendor.completedVendor,
            canceledVendor: vendor.canceledVendor,
            pendingShareBy: vendor.pendingShareBy,
            completedShareBy: vendor.completedShareBy,
            canceledShareBy: vendor.canceledShareBy,
          },
        },

        // ===== BOOKING ANALYTICS =====
        bookings: {
          total: bookingStats.total[0]?.count || 0,
          completed: bookingStats.completed[0]?.count || 0,
          cancelled: bookingStats.cancelled[0]?.count || 0,
          active: bookingStats.active[0]?.count || 0,
          byUser: bookingStats.byUser[0]?.count || 0,
          byVendor: bookingStats.byVendor[0]?.count || 0,
          byStatus: bookingStats.byStatus || [],
          timeline: bookingStats.timeline || [],
          ratingDistribution: bookingStats.ratingDistribution || [],
        },

        // ===== REVENUE ANALYTICS =====
        revenue: {
          totalRevenue: transactionData.totalRevenue || 0,
          totalDiscounts: transactionData.totalDiscounts || 0,
          transactionCount: transactionData.count || 0,
          avgOrderValue: transactionData.avgOrderValue || 0,
          minOrderValue: transactionData.minOrderValue || 0,
          maxOrderValue: transactionData.maxOrderValue || 0,
          timeline: transactionTimeline || [],
        },

        // ===== REFERRAL ANALYTICS =====
        referrals: {
          pending: shareMap.pending || 0,
          accepted: shareMap.accepted || 0,
          rejected: shareMap.rejected || 0,
          completed: shareMap.completed || 0,
          total:
            (shareMap.pending || 0) +
            (shareMap.accepted || 0) +
            (shareMap.rejected || 0) +
            (shareMap.completed || 0),
          timeline: shareTimeline || [],
        },

        // ===== LEAVE ANALYTICS =====
        leaves: {
          data: leaves,
          stats: {
            total: leaveStatsData.total || 0,
            active: leaveStatsData.active || 0,
            cancelled: leaveStatsData.cancelled || 0,
            currentActive: leaveStatsData.currentActive || 0,
            totalDays: Math.round(leaveStatsData.totalDays || 0),
          },
          upcoming: upcomingLeaves,
          currentActive: currentActiveLeaves,
        },

        // ===== PATTERNS =====
        patterns,

        // ===== TOP USERS =====
        topUsers: topUsers || [],

        // ===== RATING ANALYSIS =====
        ratingAnalysis: ratingAnalysis || [],

        // ===== DATE RANGE =====
        from: from || null,
        to: to || null,
      },
    });
  } catch (err) {
    console.error("Error in getVendorDetailAnalytics:", err);
    AdminLogger.error({ err }, "Vendor detail analytics failed");
    return res.status(500).json({
      success: false,
      message: "Failed to get vendor details",
      error: process.env.NODE_ENV === "development" ? err.message : undefined,
    });
  }
};

// ============================================
// BOOKING ANALYTICS
// ============================================

/**
 * GET /api/admin/analytics/bookings
 * Detailed booking analytics with pagination and search
 */
exports.getBookingAnalytics = async (req, res, next) => {
  try {
    const {
      status = "all",
      from,
      to,
      vendorId,
      userId,
      groupBy = "day",
      page = 1,
      limit = 10,
      search = "",
    } = req.query;

    // Parse pagination values
    const pageNum = parseInt(page, 10) || 1;
    const limitNum = parseInt(limit, 10) || 10;
    const skip = (pageNum - 1) * limitNum;

    // Build query
    const query = {};
    if (from) query.bookedOn = { $gte: new Date(from) };
    if (to) query.bookedOn = { ...query.bookedOn, $lte: new Date(to) };
    if (vendorId) query.vendorId = vendorId;
    if (userId) query.userId = userId;

    // Status filter
    if (status !== "all") {
      if (status === "completed") query.orderCompleted = true;
      else if (status === "cancelled") query.cancelOrder = true;
      else if (status === "active") {
        query.cancelOrder = false;
        query.orderCompleted = false;
      }
    }

    // Build search filter - search on booking fields
    const searchFilter = search
      ? {
          $or: [
            { name: { $regex: search, $options: "i" } },
            { vill: { $regex: search, $options: "i" } },
            { post: { $regex: search, $options: "i" } },
            { dist: { $regex: search, $options: "i" } },
            { pincode: { $regex: search, $options: "i" } },
            { type: { $regex: search, $options: "i" } },
          ],
        }
      : {};

    // Get counts with filters
    const [total, completed, cancelled, active, bookings] = await Promise.all([
      Bookings.countDocuments({ ...query, ...searchFilter }),
      Bookings.countDocuments({ ...query, ...searchFilter, orderCompleted: true }),
      Bookings.countDocuments({ ...query, ...searchFilter, cancelOrder: true }),
      Bookings.countDocuments({
        ...query,
        ...searchFilter,
        cancelOrder: false,
        orderCompleted: false,
      }),
      Bookings.find({ ...query, ...searchFilter })
        .sort({ bookedOn: -1 })
        .skip(skip)
        .limit(limitNum)
        .populate("bookedById", "name phoneNo ")
        .populate("vendorId", "name email phoneNo type")
        .select(
          "bookingDate bookingTime bookedOn cancelOrder orderCompleted rating review reviewedOn isServed isBooked name phoneNo vill post dist pincode type expenseUser expenseVendor previousBalanceUser previousBalanceVendor bookingBy bookedById",
        )
        .lean(),
    ]);

    // Get timeline data - using bookedOn for timeline
    const timeline = await Bookings.aggregate([
      {
        $match: {
          ...query,
          ...searchFilter,
        },
      },

      {
        $group: {
          _id: {
            $dateTrunc: {
              date: "$bookedOn",
              unit:
                groupBy === "day"
                  ? "day"
                  : groupBy === "week"
                    ? "week"
                    : groupBy === "month"
                      ? "month"
                      : "year",
              timezone: "Asia/Kolkata",
            },
          },

          total: {
            $sum: 1,
          },

          completed: {
            $sum: {
              $cond: [{ $eq: ["$orderCompleted", true] }, 1, 0],
            },
          },

          cancelled: {
            $sum: {
              $cond: [{ $eq: ["$cancelOrder", true] }, 1, 0],
            },
          },
        },
      },

      {
        $sort: {
          _id: 1,
        },
      },

      {
        $project: {
          _id: {
            $dateToString: {
              format: "%Y-%m-%d",
              date: "$_id",
              timezone: "Asia/Kolkata",
            },
          },

          total: 1,
          completed: 1,
          cancelled: 1,
        },
      },
    ]);

    // Get booking by type distribution
    const typeDistribution = await Bookings.aggregate([
      { $match: { ...query, ...searchFilter } },
      {
        $group: {
          _id: "$type",
          count: { $sum: 1 },
          completed: {
            $sum: { $cond: [{ $eq: ["$orderCompleted", true] }, 1, 0] },
          },
          cancelled: {
            $sum: { $cond: [{ $eq: ["$cancelOrder", true] }, 1, 0] },
          },
        },
      },
      { $sort: { count: -1 } },
    ]);

    // Top vendors by bookings
    const topVendors = await Bookings.aggregate([
      { $match: { ...query, ...searchFilter } },
      {
        $group: {
          _id: "$vendorId",
          count: { $sum: 1 },
          completed: {
            $sum: { $cond: [{ $eq: ["$orderCompleted", true] }, 1, 0] },
          },
          cancelled: {
            $sum: { $cond: [{ $eq: ["$cancelOrder", true] }, 1, 0] },
          },
          totalExpenseVendor: { $sum: "$expenseVendor" },
        },
      },
      { $sort: { count: -1 } },
      { $limit: 10 },
      {
        $lookup: {
          from: "vendors",
          localField: "_id",
          foreignField: "_id",
          as: "vendor",
        },
      },
      { $unwind: "$vendor" },
      {
        $project: {
          vendorName: "$vendor.name",
          vendorId: "$_id",
          count: 1,
          completed: 1,
          cancelled: 1,
          totalExpenseVendor: 1,
        },
      },
    ]);

    // Top users by bookings
    const topUsers = await Bookings.aggregate([
      { $match: { ...query, ...searchFilter } },
      {
        $group: {
          _id: "$userId",
          count: { $sum: 1 },
          completed: {
            $sum: { $cond: [{ $eq: ["$orderCompleted", true] }, 1, 0] },
          },
          cancelled: {
            $sum: { $cond: [{ $eq: ["$cancelOrder", true] }, 1, 0] },
          },
          totalExpenseUser: { $sum: "$expenseUser" },
        },
      },
      { $sort: { count: -1 } },
      { $limit: 10 },
      {
        $lookup: {
          from: "users",
          localField: "_id",
          foreignField: "_id",
          as: "user",
        },
      },
      { $unwind: "$user" },
      {
        $project: {
          userName: "$user.name",
          userId: "$_id",
          count: 1,
          completed: 1,
          cancelled: 1,
          totalExpenseUser: 1,
        },
      },
    ]);

    // Booking by bookingBy (User/Vendor)
    const bookingByDistribution = await Bookings.aggregate([
      { $match: { ...query, ...searchFilter } },
      {
        $group: {
          _id: "$bookingBy",
          count: { $sum: 1 },
          completed: {
            $sum: { $cond: [{ $eq: ["$orderCompleted", true] }, 1, 0] },
          },
          cancelled: {
            $sum: { $cond: [{ $eq: ["$cancelOrder", true] }, 1, 0] },
          },
        },
      },
      { $sort: { count: -1 } },
    ]);

    // Daily booking patterns
    const dailyPatterns = await Bookings.aggregate([
      { $match: { ...query, ...searchFilter } },
      {
        $group: {
          _id: {
            dayOfWeek: { $dayOfWeek: "$bookingDate" },
            hour: { $hour: "$bookedOn" },
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { "_id.dayOfWeek": 1, "_id.hour": 1 } },
    ]);

    // Average rating by vendor
    const avgRatingByVendor = await Bookings.aggregate([
      { $match: { ...query, ...searchFilter, rating: { $gt: 0 } } },
      {
        $group: {
          _id: "$vendorId",
          avgRating: { $avg: "$rating" },
          count: { $sum: 1 },
        },
      },
      { $sort: { avgRating: -1 } },
      { $limit: 10 },
      {
        $lookup: {
          from: "vendors",
          localField: "_id",
          foreignField: "_id",
          as: "vendor",
        },
      },
      { $unwind: "$vendor" },
      {
        $project: {
          vendorName: "$vendor.name",
          vendorId: "$_id",
          avgRating: 1,
          count: 1,
        },
      },
    ]);

    // Pincode distribution
    const pincodeDistribution = await Bookings.aggregate([
      { $match: { ...query, ...searchFilter, pincode: { $exists: true, $ne: null } } },
      {
        $group: {
          _id: "$pincode",
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 } },
      { $limit: 10 },
    ]);

    return res.status(200).json({
      success: true,
      data: {
        bookings: bookings,
        totals: {
          total,
          completed,
          cancelled,
          active,
        },
        completionRate: total > 0 ? Number(((completed / total) * 100).toFixed(2)) : 0,
        timeline,
        typeDistribution,
        topVendors,
        topUsers,
        bookingByDistribution,
        dailyPatterns,
        avgRatingByVendor,
        pincodeDistribution,
        pagination: {
          page: pageNum,
          limit: limitNum,
          total: total,
          totalPages: Math.ceil(total / limitNum),
        },
        filters: {
          from: from || null,
          to: to || null,
          vendorId: vendorId || null,
          userId: userId || null,
          groupBy,
          status,
          search: search || null,
        },
      },
    });
  } catch (err) {
    AdminLogger.error({ err }, "Booking analytics failed");
    return next(err);
  }
};

/**
 * GET /api/admin/analytics/bookings/:bookingId
 * Get detailed analytics for a specific booking
 */
exports.getBookingDetailAnalytics = async (req, res, next) => {
  try {
    const { bookingId } = req.params;

    const booking = await Bookings.findById(bookingId)
      .populate("bookedById", "name phoneNo ")
      .populate("vendorId", "name email phoneNo type rating earning balance")
      .lean();

    if (!booking) {
      return res.status(404).json({
        success: false,
        message: "Booking not found",
      });
    }

    // Get similar bookings (same vendor or user)
    const similarBookings = await Bookings.aggregate([
      {
        $match: {
          $or: [
            { vendorId: booking.vendorId?._id || booking.vendorId },
            { userId: booking.userId?._id || booking.userId },
          ],
          _id: { $ne: booking._id },
          ...(booking.bookingDate ? { bookingDate: booking.bookingDate } : {}),
        },
      },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          completed: {
            $sum: { $cond: [{ $eq: ["$orderCompleted", true] }, 1, 0] },
          },
          cancelled: {
            $sum: { $cond: [{ $eq: ["$cancelOrder", true] }, 1, 0] },
          },
          avgRating: { $avg: "$rating" },
          totalExpenseUser: { $sum: "$expenseUser" },
          totalExpenseVendor: { $sum: "$expenseVendor" },
        },
      },
    ]);

    // Get vendor's other bookings on same date
    const sameDateBookings = await Bookings.find({
      vendorId: booking.vendorId?._id || booking.vendorId,
      bookingDate: booking.bookingDate,
      _id: { $ne: booking._id },
    })
      .select("userId orderCompleted cancelOrder rating expenseUser expenseVendor")
      .populate("userId", "name")
      .limit(10)
      .lean();

    // Get user's booking history
    const userHistory = await Bookings.find({
      userId: booking.userId?._id || booking.userId,
      _id: { $ne: booking._id },
    })
      .sort({ bookedOn: -1 })
      .select("bookingDate vendorId orderCompleted cancelOrder rating expenseUser")
      .populate("vendorId", "name")
      .limit(10)
      .lean();

    const similar = similarBookings[0] || {
      total: 0,
      completed: 0,
      cancelled: 0,
      avgRating: 0,
      totalExpenseUser: 0,
      totalExpenseVendor: 0,
    };

    return res.status(200).json({
      success: true,
      data: {
        booking: {
          id: booking._id,
          bookingDate: booking.bookingDate,
          bookingTime: booking.bookingTime,
          bookedOn: booking.bookedOn,
          cancelOrder: booking.cancelOrder,
          cancelTime: booking.cancelTime,
          orderCompleted: booking.orderCompleted,
          rating: booking.rating,
          review: booking.review,
          reviewedOn: booking.reviewedOn,
          isServed: booking.isServed,
          isBooked: booking.isBooked,
          bookingBy: booking.bookingBy,
          bookedById: booking.bookedById,
          name: booking.name,
          phoneNo: booking.phoneNo,
          vill: booking.vill,
          post: booking.post,
          dist: booking.dist,
          pincode: booking.pincode,
          type: booking.type,
          expenseUser: booking.expenseUser,
          expenseVendor: booking.expenseVendor,
          previousBalanceUser: booking.previousBalanceUser,
          previousBalanceVendor: booking.previousBalanceVendor,
          createdAt: booking.createdAt,
          updatedAt: booking.updatedAt,
        },
        user: booking.userId || null,
        vendor: booking.vendorId || null,
        similarBookings: similar,
        sameDateBookings: sameDateBookings,
        userHistory: userHistory,
        status: {
          isActive: !booking.cancelOrder && !booking.orderCompleted,
          isCompleted: booking.orderCompleted,
          isCancelled: booking.cancelOrder,
          isServed: booking.isServed,
          isBooked: booking.isBooked,
        },
        metrics: {
          totalExpenseUser: booking.expenseUser || 0,
          totalExpenseVendor: booking.expenseVendor || 0,
          totalExpense: (booking.expenseUser || 0) + (booking.expenseVendor || 0),
        },
      },
    });
  } catch (err) {
    AdminLogger.error({ err }, "Booking detail analytics failed");
    return next(err);
  }
};
// ============================================
// REVENUE ANALYTICS
// ============================================

/**
 * GET /api/admin/analytics/revenue
 * Detailed revenue analytics with enhanced features
 */
exports.getRevenueAnalytics = async (req, res, next) => {
  try {
    const {
      period = "month",
      from,
      to,
      gateway = "all",
      vendorId,
      userId,
      groupBy = "day",
    } = req.query;

    // Parse dates
    const startDate = from ? new Date(from) : null;
    const endDate = to ? new Date(to) : null;

    // Build match filter
    const match = { status: "completed", deleted: { $ne: true } };
    if (startDate) match.createdAt = { $gte: startDate };
    if (endDate) match.createdAt = { ...match.createdAt, $lte: endDate };
    if (gateway !== "all") match.paymentGateway = gateway;
    if (vendorId) match.vendorId = vendorId;
    if (userId) match.userId = userId;

    // Determine group by unit
    const unit =
      period === "day" ? "day" : period === "week" ? "week" : period === "month" ? "month" : "year";

    // Revenue timeline
    const timeline = await Transaction.aggregate([
      {
        $match: match,
      },

      {
        $group: {
          _id: {
            $dateTrunc: {
              date: "$createdAt",
              unit: unit,
              timezone: "Asia/Kolkata",
            },
          },

          revenue: {
            $sum: "$finalAmount",
          },

          discounts: {
            $sum: "$discount",
          },

          count: {
            $sum: 1,
          },

          avgOrderValue: {
            $avg: "$finalAmount",
          },
        },
      },

      {
        $sort: {
          _id: 1,
        },
      },

      {
        $project: {
          _id: {
            $dateToString: {
              format: "%Y-%m-%d",
              date: "$_id",
              timezone: "Asia/Kolkata",
            },
          },

          revenue: 1,
          discounts: 1,
          count: 1,
          avgOrderValue: 1,
        },
      },
    ]);

    // Totals
    const totals = await Transaction.aggregate([
      { $match: match },
      {
        $group: {
          _id: null,
          totalRevenue: { $sum: "$finalAmount" },
          totalDiscounts: { $sum: "$discount" },
          count: { $sum: 1 },
          avgOrderValue: { $avg: "$finalAmount" },
          totalAmount: { $sum: "$amount" },
          maxOrderValue: { $max: "$finalAmount" },
          minOrderValue: { $min: "$finalAmount" },
        },
      },
    ]);

    // Payment gateway breakdown
    const gatewayBreakdown = await Transaction.aggregate([
      { $match: match },
      {
        $group: {
          _id: "$paymentGateway",
          revenue: { $sum: "$finalAmount" },
          count: { $sum: 1 },
          discounts: { $sum: "$discount" },
          avgOrderValue: { $avg: "$finalAmount" },
        },
      },
      { $sort: { revenue: -1 } },
    ]);

    // Revenue by vendor
    const vendorRevenue = await Transaction.aggregate([
      { $match: match },
      {
        $group: {
          _id: "$vendorId",
          revenue: { $sum: "$finalAmount" },
          count: { $sum: 1 },
          avgOrderValue: { $avg: "$finalAmount" },
        },
      },
      { $sort: { revenue: -1 } },
      { $limit: 20 },
      {
        $lookup: {
          from: "vendors",
          localField: "_id",
          foreignField: "_id",
          as: "vendor",
        },
      },
      { $unwind: { path: "$vendor", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          vendorName: "$vendor.name",
          vendorId: "$_id",
          revenue: 1,
          count: 1,
          avgOrderValue: 1,
        },
      },
    ]);

    // Revenue by user
    const userRevenue = await Transaction.aggregate([
      { $match: match },
      {
        $group: {
          _id: "$userId",
          revenue: { $sum: "$finalAmount" },
          count: { $sum: 1 },
          avgOrderValue: { $avg: "$finalAmount" },
        },
      },
      { $sort: { revenue: -1 } },
      { $limit: 20 },
      {
        $lookup: {
          from: "users",
          localField: "_id",
          foreignField: "_id",
          as: "user",
        },
      },
      { $unwind: { path: "$user", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          userName: "$user.name",
          userId: "$_id",
          revenue: 1,
          count: 1,
          avgOrderValue: 1,
        },
      },
    ]);

    // Revenue by booking type
    const bookingTypeRevenue = await Transaction.aggregate([
      { $match: match },
      {
        $lookup: {
          from: "bookings",
          localField: "bookingId",
          foreignField: "_id",
          as: "booking",
        },
      },
      { $unwind: { path: "$booking", preserveNullAndEmptyArrays: true } },
      {
        $group: {
          _id: "$booking.type",
          revenue: { $sum: "$finalAmount" },
          count: { $sum: 1 },
          discounts: { $sum: "$discount" },
        },
      },
      { $sort: { revenue: -1 } },
    ]);

    // Weekly/Monthly patterns
    const patterns = await Transaction.aggregate([
      { $match: match },
      {
        $group: {
          _id: {
            dayOfWeek: { $dayOfWeek: "$createdAt" },
            hour: { $hour: "$createdAt" },
          },
          revenue: { $sum: "$finalAmount" },
          count: { $sum: 1 },
        },
      },
      { $sort: { "_id.dayOfWeek": 1, "_id.hour": 1 } },
    ]);

    // Calculate revenue changes
    const timelineData = timeline || [];
    let monthlyChange = 0;
    let weeklyChange = 0;
    let dailyChange = 0;

    if (timelineData.length >= 2) {
      const current = timelineData[timelineData.length - 1];
      const previous = timelineData[timelineData.length - 2];
      if (previous && previous.revenue > 0) {
        monthlyChange = ((current.revenue - previous.revenue) / previous.revenue) * 100;
      }
    }

    const totalsData = totals[0] || {
      totalRevenue: 0,
      totalDiscounts: 0,
      count: 0,
      avgOrderValue: 0,
      totalAmount: 0,
      maxOrderValue: 0,
      minOrderValue: 0,
    };

    return res.status(200).json({
      success: true,
      data: {
        timeline: timelineData,
        totals: {
          totalRevenue: totalsData.totalRevenue || 0,
          totalDiscounts: totalsData.totalDiscounts || 0,
          count: totalsData.count || 0,
          avgOrderValue: totalsData.avgOrderValue || 0,
          totalAmount: totalsData.totalAmount || 0,
          maxOrderValue: totalsData.maxOrderValue || 0,
          minOrderValue: totalsData.minOrderValue || 0,
        },
        gatewayBreakdown,
        vendorRevenue,
        userRevenue,
        bookingTypeRevenue,
        patterns,
        metrics: {
          monthlyChange: Number(monthlyChange.toFixed(2)),
          weeklyChange: Number(weeklyChange.toFixed(2)),
          dailyChange: Number(dailyChange.toFixed(2)),
        },
        filters: {
          period,
          from: from || null,
          to: to || null,
          gateway: gateway || "all",
          vendorId: vendorId || null,
          userId: userId || null,
          groupBy,
        },
      },
    });
  } catch (err) {
    AdminLogger.error({ err }, "Revenue analytics failed");
    return next(err);
  }
};

// ============================================
// REFERRAL ANALYTICS
// ============================================

/**
 * GET /api/admin/analytics/referrals
 * Detailed referral analytics based on Share schema
 * Share model: userId, vendorId, phoneNo, status, shareDate
 */
exports.getReferralAnalytics = async (req, res, next) => {
  try {
    const {
      period = "month",
      from,
      to,
      status = "all",
      type = "all",
      userId,
      vendorId,
      page = 1,
      limit = 10,
      search = "",
    } = req.query;

    // Parse pagination values
    const pageNum = parseInt(page, 10) || 1;
    const limitNum = parseInt(limit, 10) || 10;
    const skip = (pageNum - 1) * limitNum;

    // Build match filter
    const match = {};
    if (from) match.shareDate = { $gte: new Date(from) };
    if (to) match.shareDate = { ...match.shareDate, $lte: new Date(to) };
    if (status !== "all") match.status = status;
    if (userId) match.userId = userId;
    if (vendorId) match.vendorId = vendorId;

    // Build search filter - search on phoneNo
    const searchFilter = search
      ? {
          $or: [{ phoneNo: { $regex: search, $options: "i" } }],
        }
      : {};

    // Determine group by unit
    const unit =
      period === "day" ? "day" : period === "week" ? "week" : period === "month" ? "month" : "year";

    // Referral timeline
    const timeline = await Share.aggregate([
      {
        $match: {
          ...match,
          ...searchFilter,
        },
      },

      {
        $group: {
          _id: {
            $dateTrunc: {
              date: "$shareDate",
              unit: unit,
              timezone: "Asia/Kolkata",
            },
          },

          total: {
            $sum: 1,
          },

          completed: {
            $sum: {
              $cond: [{ $eq: ["$status", "completed"] }, 1, 0],
            },
          },

          pending: {
            $sum: {
              $cond: [{ $eq: ["$status", "pending"] }, 1, 0],
            },
          },

          accepted: {
            $sum: {
              $cond: [{ $eq: ["$status", "accepted"] }, 1, 0],
            },
          },

          rejected: {
            $sum: {
              $cond: [{ $eq: ["$status", "rejected"] }, 1, 0],
            },
          },
        },
      },

      {
        $sort: {
          _id: 1,
        },
      },

      {
        $project: {
          _id: {
            $dateToString: {
              format: "%Y-%m-%d",
              date: "$_id",
              timezone: "Asia/Kolkata",
            },
          },

          total: 1,
          completed: 1,
          pending: 1,
          accepted: 1,
          rejected: 1,
        },
      },
    ]);

    // Totals
    const totals = await Share.aggregate([
      { $match: { ...match, ...searchFilter } },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          completed: {
            $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] },
          },
          pending: {
            $sum: { $cond: [{ $eq: ["$status", "pending"] }, 1, 0] },
          },
          accepted: {
            $sum: { $cond: [{ $eq: ["$status", "accepted"] }, 1, 0] },
          },
          rejected: {
            $sum: { $cond: [{ $eq: ["$status", "rejected"] }, 1, 0] },
          },
        },
      },
    ]);

    // Determine referrer type (User/Vendor) based on which ID exists
    const typeDistribution = await Share.aggregate([
      { $match: { ...match, ...searchFilter } },
      {
        $facet: {
          users: [{ $match: { userId: { $exists: true, $ne: null } } }, { $count: "count" }],
          vendors: [{ $match: { vendorId: { $exists: true, $ne: null } } }, { $count: "count" }],
          unknown: [
            {
              $match: {
                userId: { $exists: false },
                vendorId: { $exists: false },
              },
            },
            { $count: "count" },
          ],
        },
      },
      {
        $project: {
          types: {
            $concatArrays: [
              [{ type: "User", count: { $arrayElemAt: ["$users.count", 0] } }],
              [{ type: "Vendor", count: { $arrayElemAt: ["$vendors.count", 0] } }],
              [{ type: "Unknown", count: { $arrayElemAt: ["$unknown.count", 0] } }],
            ],
          },
        },
      },
      { $unwind: "$types" },
      { $replaceRoot: { newRoot: "$types" } },
      { $match: { count: { $gt: 0 } } },
      { $sort: { count: -1 } },
    ]);

    // Top referrers (Users)
    const topUserReferrers = await Share.aggregate([
      { $match: { ...match, ...searchFilter, userId: { $exists: true, $ne: null } } },
      {
        $group: {
          _id: "$userId",
          total: { $sum: 1 },
          completed: {
            $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] },
          },
          pending: {
            $sum: { $cond: [{ $eq: ["$status", "pending"] }, 1, 0] },
          },
          accepted: {
            $sum: { $cond: [{ $eq: ["$status", "accepted"] }, 1, 0] },
          },
          rejected: {
            $sum: { $cond: [{ $eq: ["$status", "rejected"] }, 1, 0] },
          },
        },
      },
      { $sort: { total: -1 } },
      { $limit: 20 },
      {
        $lookup: {
          from: "users",
          localField: "_id",
          foreignField: "_id",
          as: "user",
        },
      },
      { $unwind: { path: "$user", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          referrerName: "$user.name",
          referrerId: "$_id",
          referrerPhone: "$user.phoneNo",
          total: 1,
          completed: 1,
          pending: 1,
          accepted: 1,
          rejected: 1,
        },
      },
    ]);

    // Top referrers (Vendors)
    const topVendorReferrers = await Share.aggregate([
      { $match: { ...match, ...searchFilter, vendorId: { $exists: true, $ne: null } } },
      {
        $group: {
          _id: "$vendorId",
          total: { $sum: 1 },
          completed: {
            $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] },
          },
          pending: {
            $sum: { $cond: [{ $eq: ["$status", "pending"] }, 1, 0] },
          },
          accepted: {
            $sum: { $cond: [{ $eq: ["$status", "accepted"] }, 1, 0] },
          },
          rejected: {
            $sum: { $cond: [{ $eq: ["$status", "rejected"] }, 1, 0] },
          },
        },
      },
      { $sort: { total: -1 } },
      { $limit: 20 },
      {
        $lookup: {
          from: "vendors",
          localField: "_id",
          foreignField: "_id",
          as: "vendor",
        },
      },
      { $unwind: { path: "$vendor", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          referrerName: "$vendor.name",
          referrerId: "$_id",
          referrerPhone: "$vendor.phoneNo",
          total: 1,
          completed: 1,
          pending: 1,
          accepted: 1,
          rejected: 1,
        },
      },
    ]);

    // Get list of referrals with pagination
    const referrals = await Share.find({ ...match, ...searchFilter })
      .sort({ shareDate: -1 })
      .skip(skip)
      .limit(limitNum)
      .populate("userId", "name email phoneNo")
      .populate("vendorId", "name email phoneNo type")
      .select("userId vendorId phoneNo status shareDate createdAt")
      .lean();

    // Referral by status distribution
    const statusDistribution = await Share.aggregate([
      { $match: { ...match, ...searchFilter } },
      {
        $group: {
          _id: "$status",
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 } },
    ]);

    // Weekly patterns
    const weeklyPatterns = await Share.aggregate([
      { $match: { ...match, ...searchFilter } },
      {
        $group: {
          _id: {
            dayOfWeek: { $dayOfWeek: "$shareDate" },
            hour: { $hour: "$shareDate" },
          },
          count: { $sum: 1 },
          completed: {
            $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] },
          },
        },
      },
      { $sort: { "_id.dayOfWeek": 1, "_id.hour": 1 } },
    ]);

    // Calculate conversion trends
    const conversionTrends = await Share.aggregate([
      { $match: { ...match, ...searchFilter } },
      {
        $group: {
          _id: {
            $dateTrunc: {
              date: "$shareDate",
              unit: unit,
            },
          },
          total: { $sum: 1 },
          completed: {
            $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] },
          },
          pending: {
            $sum: { $cond: [{ $eq: ["$status", "pending"] }, 1, 0] },
          },
          accepted: {
            $sum: { $cond: [{ $eq: ["$status", "accepted"] }, 1, 0] },
          },
          rejected: {
            $sum: { $cond: [{ $eq: ["$status", "rejected"] }, 1, 0] },
          },
        },
      },
      {
        $project: {
          _id: 1,
          total: 1,
          completed: 1,
          pending: 1,
          accepted: 1,
          rejected: 1,
          conversionRate: {
            $cond: [
              { $eq: ["$total", 0] },
              0,
              { $multiply: [{ $divide: ["$completed", "$total"] }, 100] },
            ],
          },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    // Phone number trends (referred users)
    const phoneTrends = await Share.aggregate([
      { $match: { ...match, ...searchFilter, phoneNo: { $exists: true, $ne: null } } },
      {
        $group: {
          _id: "$phoneNo",
          count: { $sum: 1 },
          firstShare: { $min: "$shareDate" },
          lastShare: { $max: "$shareDate" },
          status: { $first: "$status" },
          referrerTypes: {
            $addToSet: {
              $cond: [
                { $ifNull: ["$userId", false] },
                "User",
                { $cond: [{ $ifNull: ["$vendorId", false] }, "Vendor", "Unknown"] },
              ],
            },
          },
        },
      },
      { $sort: { count: -1 } },
      { $limit: 20 },
    ]);

    const totalsObj = totals[0] || {
      total: 0,
      completed: 0,
      pending: 0,
      accepted: 0,
      rejected: 0,
    };

    // Calculate completion rate
    const completedRate =
      totalsObj.total > 0 ? Number(((totalsObj.completed / totalsObj.total) * 100).toFixed(2)) : 0;

    return res.status(200).json({
      success: true,
      data: {
        referrals: referrals.map((ref) => ({
          ...ref,
          referrerType: ref.userId ? "User" : ref.vendorId ? "Vendor" : "Unknown",
          referrerName: ref.userId?.name || ref.vendorId?.name || "Unknown",
        })),
        timeline,
        totals: {
          total: totalsObj.total,
          completed: totalsObj.completed,
          pending: totalsObj.pending,
          accepted: totalsObj.accepted,
          rejected: totalsObj.rejected,
          completionRate: completedRate,
        },
        typeDistribution,
        topUserReferrers: topUserReferrers.map((r) => ({ ...r, type: "User" })),
        topVendorReferrers: topVendorReferrers.map((r) => ({ ...r, type: "Vendor" })),
        statusDistribution,
        weeklyPatterns,
        conversionTrends,
        phoneTrends,
        pagination: {
          page: pageNum,
          limit: limitNum,
          total: totalsObj.total,
          totalPages: Math.ceil(totalsObj.total / limitNum),
        },
        filters: {
          period,
          from: from || null,
          to: to || null,
          status: status || "all",
          type: type || "all",
          userId: userId || null,
          vendorId: vendorId || null,
          search: search || null,
        },
      },
    });
  } catch (err) {
    AdminLogger.error({ err }, "Referral analytics failed");
    return next(err);
  }
};

// ============================================
// EXPORT ANALYTICS
// ============================================

/**
 * GET /api/admin/analytics/export
 * Export analytics data
 */
exports.exportAnalytics = async (req, res, next) => {
  try {
    const { format = "json", type, from, to } = req.query;

    // Build query
    const query = {};
    if (from) query.createdAt = { $gte: new Date(from) };
    if (to) query.createdAt = { ...query.createdAt, $lte: new Date(to) };

    let data = [];
    let filename = "";

    switch (type) {
      case "users":
        data = await User.find(query)
          .select("name email phoneNo status createdAt bookingCount shareCount")
          .limit(MAX_EXPORT_ROWS)
          .lean();
        filename = "users_export";
        break;
      case "vendors":
        data = await Vendor.find(query)
          .select(
            "name email phoneNo type status rating earning commission balance bookingCount accountCreatedOn",
          )
          .limit(MAX_EXPORT_ROWS)
          .lean();
        filename = "vendors_export";
        break;
      case "bookings":
        data = await Bookings.find(query)
          .populate("userId", "name email")
          .populate("vendorId", "name")
          .select("bookingDate bookingBy status orderCompleted cancelOrder createdAt")
          .limit(MAX_EXPORT_ROWS)
          .lean();
        filename = "bookings_export";
        break;
      case "revenue":
        data = await Transaction.find(query)
          .select("amount finalAmount discount status paymentGateway createdAt")
          .limit(MAX_EXPORT_ROWS)
          .lean();
        filename = "revenue_export";
        break;
      case "referrals":
        data = await Share.find(query)
          .populate("userId", "name email")
          .select("status createdAt")
          .limit(MAX_EXPORT_ROWS)
          .lean();
        filename = "referrals_export";
        break;
      default:
        return res.status(400).json({
          success: false,
          message:
            "Invalid export type. Supported types: users, vendors, bookings, revenue, referrals",
        });
    }

    if (format === "csv") {
      // Convert to CSV (simplified - use a library like csv-writer in production)
      const headers = Object.keys(data[0] || {});
      let csv = headers.join(",") + "\n";
      data.forEach((row) => {
        csv += headers.map((h) => JSON.stringify(row[h] || "")).join(",") + "\n";
      });

      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename=${filename}.csv`);
      return res.send(csv);
    }

    // Default: JSON
    return res.status(200).json({
      success: true,
      data,
      format: "json",
      count: data.length,
    });
  } catch (err) {
    AdminLogger.error({ err }, "Export analytics failed");
    return next(err);
  }
};

// ============================================
// HEALTH CHECK
// ============================================

/**
 * GET /api/admin/analytics/health
 * Health check
 */
exports.healthCheck = async (req, res, next) => {
  try {
    const now = Date.now();
    const cacheStatus = {};

    Object.keys(cache).forEach((key) => {
      const cached = cache[key];
      cacheStatus[key] = {
        active: !!cached.data,
        age: cached.at > 0 ? Math.floor((now - cached.at) / 1000) : -1,
        ttl: Math.floor(CACHE_TTL_MS / 1000),
      };
    });

    // Check database connectivity
    const dbStatus = mongoose.connection.readyState === 1 ? "connected" : "disconnected";

    return res.status(200).json({
      success: true,
      status: "healthy",
      database: dbStatus,
      cache: cacheStatus,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    AdminLogger.error({ err }, "Health check failed");
    return next(err);
  }
};

// ============================================
// EXPORTED FOR TESTS
// ============================================

exports._computeDashboard = computeDashboard;
exports._resetCache = () => {
  cache = {
    dashboard: { at: 0, data: null },
    users: { at: 0, data: null },
    vendors: { at: 0, data: null },
    bookings: { at: 0, data: null },
    revenue: { at: 0, data: null },
    referrals: { at: 0, data: null },
  };
};
exports._getCache = () => ({ ...cache });
