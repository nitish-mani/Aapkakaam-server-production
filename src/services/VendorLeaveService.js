const mongoose = require("mongoose");
const Vendor = require("../../models/vendor");
const VendorLeave = require("../../models/VendorLeave");
const Booking = require("../../models/bookings");
const { normalizeDateIST, validateDateRange, classifyLeave } = require("../utils/dateUtils");

const ApiError = require("../utils/ApiError");
const CacheService = require("./CacheService");
const { VendorLogger } = require("../logger/index");

class VendorLeaveService {
  /**
   * Private helper: Validate and normalize a business date
   * @param {string} date - Date to validate
   * @returns {string} Normalized business date
   * @throws {Error} If date is invalid
   */
  static validateBusinessDate(date) {
    const targetDate = normalizeDateIST(date);
    if (!targetDate) {
      throw ApiError.badRequest("Invalid booking date format");
    }
    return targetDate;
  }

  /**
   * Create a new leave period with atomic operations
   * @param {string} vendorId - Vendor ID
   * @param {string} from - Start date (business format or parseable)
   * @param {string} to - End date (business format or parseable)
   * @param {string} reason - Optional reason for leave
   * @returns {Promise<Object>} Created leave document
   */
  static async createLeave(vendorId, from, to, reason = "") {
    // Validate and normalize dates
    const validation = validateDateRange(from, to);
    if (!validation.valid) {
      throw ApiError.badRequest(validation.message);
    }

    const { from: fromDate, to: toDate } = validation;

    // Sanitize reason
    const sanitizedReason = reason ? reason.trim().slice(0, 200) : "";

    // Use transaction for atomic operations
    const session = await mongoose.startSession();

    try {
      let leave;

      await session.withTransaction(async () => {
        // 1. Verify vendor exists (using exists for efficiency)
        const vendorExists = await Vendor.exists({ _id: vendorId }).session(session);
        if (!vendorExists) {
          throw ApiError.notFound("Vendor not found");
        }

        // 2. Check for overlapping leave (atomic query)
        const hasOverlap = await VendorLeave.hasOverlappingLeave(
          vendorId,
          fromDate,
          toDate,
          session,
        );

        if (hasOverlap) {
          throw ApiError.conflict("Leave period overlaps with existing leave");
        }

        // 3. Check for existing bookings in this period (only need count)
        const bookingCount = await Booking.countDocuments({
          vendorId,
          cancelOrder: false,
          orderCompleted: false,
          bookingDate: {
            $gte: fromDate,
            $lte: toDate,
          },
        }).session(session);

        if (bookingCount > 0) {
          throw ApiError.conflict(
            `Cannot create leave: ${bookingCount} booking(s) exist in this period`,
            {
              existingBookings: bookingCount,
            },
          );
        }

        // 4. Create leave
        leave = new VendorLeave({
          vendorId: vendorId,
          from: fromDate,
          to: toDate,
          reason: sanitizedReason,
          status: "active",
        });

        await leave.save({ session });
      });

      // Log success (outside transaction)
      VendorLogger.info(
        {
          event: "VENDOR_LEAVE_CREATED",
          vendorId,
          leaveId: leave._id,
          from: fromDate,
          to: toDate,
          requestId: VendorLogger.requestId,
        },
        "Vendor leave created successfully",
      );

      try {
        await Promise.all([
          CacheService.invalidateTag("vendors"),
          CacheService.invalidateTag("availability"),
        ]);
      } catch (error) {
        VendorLogger.warn(
          {
            event: "CACHE_INVALIDATION_FAILED",
            vendorId,
            from: fromDate,
            to: toDate,
            err: error,
          },
          "Failed to invalidate vendor availability cache",
        );
      }

      return leave;
    } catch (error) {
      // Re-throw with original error
      throw error;
    } finally {
      await session.endSession();
    }
  }

  /**
   * Cancel (soft delete) a leave
   * @param {string} vendorId - Vendor ID
   * @param {string} leaveId - Leave ID to cancel
   * @returns {Promise<Object>} Updated leave document
   */
  static async cancelLeave(vendorId, leaveId) {
    // Validate ObjectId
    if (!mongoose.Types.ObjectId.isValid(leaveId)) {
      throw ApiError.badRequest("Invalid leave ID");
    }

    // Find and validate the leave
    const leave = await VendorLeave.findOne({
      _id: leaveId,
      vendorId: vendorId,
      status: "active",
    });

    if (!leave) {
      throw ApiError.notFound("Leave record not found or already cancelled");
    }

    // Check if leave is in the past
    if (leave.isPast()) {
      throw ApiError.badRequest("Past leave cannot be cancelled");
    }

    // Update status to cancelled
    leave.status = "cancelled";
    await leave.save();

    // Log event
    VendorLogger.info(
      {
        event: "VENDOR_LEAVE_CANCELLED",
        vendorId,
        leaveId: leave._id,
        from: leave.from,
        to: leave.to,
        requestId: VendorLogger.requestId,
      },
      "Vendor leave cancelled successfully",
    );
    try {
      await Promise.all([
        CacheService.invalidateTag("vendors"),
        CacheService.invalidateTag("availability"),
      ]);
    } catch (error) {
      VendorLogger.warn(
        {
          event: "CACHE_INVALIDATION_FAILED",
          vendorId,
          leaveId,
          err: error,
        },
        "Failed to invalidate vendor availability cache",
      );
    }

    return leave;
  }

  /**
   * Get all leaves for a vendor with classification
   * @param {string} vendorId - Vendor ID
   * @returns {Promise<Array>} Array of leave documents with classification
   */
  static async getVendorLeaves(vendorId) {
    // Validate vendor exists (using exists for efficiency)
    const vendorExists = await Vendor.exists({ _id: vendorId });
    if (!vendorExists) {
      const error = new Error("Vendor not found");
      error.code = "VENDOR_NOT_FOUND";
      throw error;
    }

    // Get all leaves (including cancelled)
    const leaves = await VendorLeave.find({
      vendorId: vendorId,
    })
      .sort({ from: -1 })
      .lean();

    // Classify and format
    return leaves.map((leave) => ({
      ...leave,
      status: leave.status,
      classification: leave.status === "active" ? classifyLeave(leave) : "cancelled",
      fromDisplay: leave.from
        ? leave.from.toLocaleDateString("en-IN", {
            year: "numeric",
            month: "long",
            day: "numeric",
          })
        : null,
      toDisplay: leave.to
        ? leave.to.toLocaleDateString("en-IN", {
            year: "numeric",
            month: "long",
            day: "numeric",
          })
        : null,
    }));
  }

  /**
   * Check if vendor has active leave on a specific date
   * @param {string} vendorId - Vendor ID
   * @param {string} date - Date to check (business format or parseable)
   * @param {Object} session - MongoDB session (optional)
   * @returns {Promise<boolean>} True if vendor has leave on the date
   */
  static async hasLeaveOnDate(vendorId, date, session = null) {
    // Validate and normalize date using private helper
    const targetDate = this.validateBusinessDate(date);
    return VendorLeave.hasLeaveOnDate(vendorId, targetDate, session);
  }

  /**
   * Get IDs of all vendors unavailable on a date
   * @param {string} date - Date to check (business format or parseable)
   * @param {Object} session - MongoDB session (optional)
   * @returns {Promise<Array>} Array of vendor IDs
   */
  static async getUnavailableVendorIds(date, session = null) {
    // Validate and normalize date using private helper
    const targetDate = this.validateBusinessDate(date);
    return VendorLeave.getUnavailableVendorIds(targetDate, session);
  }

  /**
   * Check if a leave overlaps with existing leaves
   * @param {string} vendorId - Vendor ID
   * @param {string} from - Start date (business format or parseable)
   * @param {string} to - End date (business format or parseable)
   * @param {Object} session - MongoDB session (optional)
   * @returns {Promise<boolean>} True if overlapping leave exists
   */
  static async hasOverlappingLeave(vendorId, from, to, session = null) {
    // Validate date range using centralized validator
    const validation = validateDateRange(from, to);
    if (!validation.valid) {
      const error = new Error(validation.message);
      error.code = "INVALID_LEAVE_RANGE";
      throw error;
    }

    return VendorLeave.hasOverlappingLeave(vendorId, validation.from, validation.to, session);
  }
}

module.exports = VendorLeaveService;
