/**
const OtpAuthorizationService = require("./OtpAuthorizationService");
 * UserService - Core business logic for all user operations
 * Follows Single Responsibility Principle
 */
const User = require("../../models/user");
const Vendor = require("../../models/vendor");
const Share = require("../../models/share");
const Bookings = require("../../models/bookings");
const Attendance = require("../../models/attendance");
const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");
const { default: axios } = require("axios");
const ApiError = require("../utils/ApiError");

const OtpAuth = require("../../models/otpAuth");
const OtpAuthorizationService = require("./OtpAuthorizationService");
const { normalizeDateIST } = require("../utils/dateUtils");
const { UserLogger } = require("../logger/index");
class UserService {
  /**
   * ============================================
   * OTP & VERIFICATION METHODS
   * ============================================
   */

  /**
   * Generate OTP
   */
  static generateOTP() {
    const otp = Math.floor(Math.random() * (999999 - 100000 + 1)) + 100000;
    UserLogger.debug(`Generated OTP: ${otp}`);
    return otp;
  }

  /**
   * Send phone OTP via SMS
   */
  static async sendPhoneOTP(phoneNo) {
    if (!phoneNo) {
      throw ApiError.badRequest("Phone number is required");
    }

    const normalizedPhone = String(phoneNo).trim().replace(/\s+/g, "");

    if (!normalizedPhone) {
      throw ApiError.badRequest("Phone number is required");
    }

    // Signup OTP: phone must not already belong to any account.
    const [existingUser, existingVendor] = await Promise.all([
      User.exists({ phoneNo: normalizedPhone }),
      Vendor.exists({ phoneNo: normalizedPhone }),
    ]);

    if (existingUser || existingVendor) {
      throw ApiError.conflict("Mobile number already exists!");
    }

    const otpM = String(this.generateOTP());

    const otpRecord = await OtpAuth.create({
      otp: otpM,

      purpose: "verify_phone",
      accountType: "user",
      accountId: null,
      target: normalizedPhone,

      verified: false,
      consumedAt: null,
    });
    try {
      await axios.get(
        `${process.env.FAST2SMS}variables_values=${otpM}&flash=0&numbers=${normalizedPhone}&schedule_time=`,
      );
    } catch (error) {
      // Do not leave an authorization record behind when SMS
      // delivery itself failed.
      await OtpAuth.deleteOne({
        _id: otpRecord._id,
        verified: false,
        consumedAt: null,
      }).catch(() => {});

      UserLogger.error(
        {
          err: error,
          phoneNo: normalizedPhone,
          otpId: otpRecord._id,
        },
        "Failed to send signup OTP",
      );

      throw ApiError.internal("Unable to send verification code");
    }

    UserLogger.info(
      {
        phoneNo: normalizedPhone,
        otpId: otpRecord._id,
        purpose: "verify_phone",
      },
      "Signup phone OTP sent",
    );

    return {
      otpId: otpRecord._id,
    };
  }

  /**
   * Verify OTP
   */
  static async verifyOTP(otpId, userOtp) {
    if (!otpId || !userOtp) {
      throw ApiError.badRequest("OTP and OTP ID are required");
    }

    if (!mongoose.Types.ObjectId.isValid(otpId)) {
      throw ApiError.badRequest("Invalid OTP ID");
    }

    const result = await OtpAuth.findById(otpId)
      .select("otp purpose accountType target verified consumedAt createdAt")
      .lean();
    if (!result) {
      throw ApiError.notFound("Invalid OTP request");
    }

    // This service must only verify User signup OTPs.
    if (result.accountType !== "user" || result.purpose !== "verify_phone") {
      throw ApiError.forbidden("OTP is not valid for this operation");
    }

    if (result.consumedAt) {
      throw ApiError.forbidden("OTP has already been used");
    }

    if (result.verified) {
      throw ApiError.forbidden("OTP has already been verified");
    }

    const isExpired = Date.now() - new Date(result.createdAt).getTime() > 10 * 60 * 1000;

    if (isExpired) {
      await OtpAuth.deleteOne({
        _id: otpId,
        consumedAt: null,
      });

      throw ApiError.gone("OTP has expired");
    }

    if (String(result.otp) !== String(userOtp)) {
      throw ApiError.badRequest("Invalid OTP");
    }

    const verifiedOtp = await OtpAuth.findOneAndUpdate(
      {
        _id: otpId,
        accountType: "user",
        purpose: "verify_phone",
        verified: false,
        consumedAt: null,
      },
      {
        $set: {
          verified: true,
        },
      },
      {
        new: true,
      },
    );
    if (!verifiedOtp) {
      throw ApiError.forbidden("OTP cannot be verified");
    }

    return {
      verified: true,
      otpId: verifiedOtp._id,
    };
  }

  static async sendPasswordResetOTP(phoneNo) {
    if (!phoneNo) {
      throw ApiError.badRequest("Phone number is required");
    }

    const normalizedPhone = String(phoneNo).trim().replace(/\s+/g, "");

    const user = await User.findOne({
      phoneNo: normalizedPhone,
    })
      .select("_id phoneNo")
      .lean();

    if (!user) {
      throw ApiError.notFound("User with this phone number not found");
    }

    const otpM = String(this.generateOTP());

    const otpRecord = await OtpAuth.create({
      otp: otpM,
      purpose: "reset_password",
      accountType: "user",
      accountId: user._id,
      target: normalizedPhone,
      verified: false,
      consumedAt: null,
    });

    try {
      await axios.get(
        `${process.env.FAST2SMS}variables_values=${otpM}&flash=0&numbers=${normalizedPhone}&schedule_time=`,
      );
    } catch (error) {
      await OtpAuth.deleteOne({
        _id: otpRecord._id,
        consumedAt: null,
      }).catch(() => {});

      throw ApiError.internal("Unable to send verification code");
    }

    return {
      otpId: otpRecord._id,
    };
  }

  static async verifyOTPForPasswordReset(otpId, userOtp) {
    if (!otpId || !userOtp) {
      throw ApiError.badRequest("OTP and OTP ID are required");
    }

    if (!mongoose.Types.ObjectId.isValid(otpId)) {
      throw ApiError.badRequest("Invalid OTP ID");
    }

    const result = await OtpAuth.findById(otpId)
      .select("otp purpose accountType target verified consumedAt createdAt")
      .lean();
    if (!result) {
      throw ApiError.notFound("Invalid OTP request");
    }

    // This service must only verify User signup OTPs.
    if (result.accountType !== "user" || result.purpose !== "reset_password") {
      throw ApiError.forbidden("OTP is not valid for this operation");
    }

    if (result.consumedAt) {
      throw ApiError.forbidden("OTP has already been used");
    }

    if (result.verified) {
      throw ApiError.forbidden("OTP has already been verified");
    }

    const isExpired = Date.now() - new Date(result.createdAt).getTime() > 10 * 60 * 1000;

    if (isExpired) {
      await OtpAuth.deleteOne({
        _id: otpId,
        consumedAt: null,
      });

      throw ApiError.gone("OTP has expired");
    }

    if (String(result.otp) !== String(userOtp)) {
      throw ApiError.badRequest("Invalid OTP");
    }

    const verifiedOtp = await OtpAuth.findOneAndUpdate(
      {
        _id: otpId,
        accountType: "user",
        purpose: "reset_password",
        verified: false,
        consumedAt: null,
      },
      {
        $set: {
          verified: true,
        },
      },
      {
        new: true,
      },
    );
    if (!verifiedOtp) {
      throw ApiError.forbidden("OTP cannot be verified");
    }

    return {
      verified: true,
      otpId: verifiedOtp._id,
    };
  }
  /**
   * ============================================
   * PROFILE UPDATE METHODS
   * ============================================
   */

  /**
   * Update user password
   */
  static async updatePassword(phoneNo, password, otpId) {
    if (!phoneNo || !password || !otpId) {
      throw ApiError.badRequest("Phone number, password, and OTP ID are required");
    }

    if (password.length < 6) {
      throw ApiError.badRequest("Password must be at least 6 characters long");
    }

    const normalizedPhone = String(phoneNo).trim().replace(/\s+/g, "");

    const user = await User.findOne({
      phoneNo: normalizedPhone,
    }).select("_id");

    if (!user) {
      throw ApiError.forbidden("Invalid, expired, already used, or mismatched verification");
    }

    await OtpAuthorizationService.consume({
      otpId,
      accountType: "user",
      accountId: user._id,
      purpose: "reset_password",
      target: normalizedPhone,
    });

    const hashPass = await bcrypt.hash(password, 12);

    await User.updateOne(
      { _id: user._id },
      {
        $set: {
          password: hashPass,
        },
      },
    );

    return {
      message: "Password changed successfully",
    };
  }

  /**
   * Update user address
   */
  static async updateAddress(userId, addressData) {
    UserLogger.info(`Starting updateAddress for user: ${userId}`);

    const { vill, post, dist, state, pincode } = addressData;

    if (!userId) {
      UserLogger.warn("updateAddress called with missing user ID");
      throw ApiError.badRequest("User ID is required");
    }

    const address = { vill, post, dist, state, pincode };
    const loadedUser = await User.findByIdAndUpdate(
      userId,
      { address: [address], pincode },
      { new: true },
    );

    if (!loadedUser) {
      UserLogger.warn(`User not found with ID: ${userId}`);
      throw ApiError.notFound("Could not find User.");
    }

    UserLogger.info(`Address updated successfully for user: ${userId}`);
    return {
      address: loadedUser.address,
      message: "Address Updated Successfully",
    };
  }

  /**
   * Update user name
   */
  static async updateName(userId, name) {
    UserLogger.info(`Starting updateName for user: ${userId}`);

    if (!userId) {
      UserLogger.warn("updateName called with missing user ID");
      throw ApiError.badRequest("User ID is required");
    }

    const loadedUser = await User.findByIdAndUpdate(userId, { name }, { new: true });

    if (!loadedUser) {
      UserLogger.warn(`User not found with ID: ${userId}`);
      throw ApiError.notFound("Could not find User.");
    }

    UserLogger.info(`Name updated successfully for user: ${userId}`);
    return {
      name: loadedUser.name,
      message: "Name Updated Successfully",
    };
  }

  /**
   * Update user FCM token
   */
  static async updateFcmToken(userId, fcmToken) {
    UserLogger.info(`Starting updateFcmToken for user: ${userId}`);

    if (!userId) {
      UserLogger.warn("updateFcmToken called with missing user ID");
      throw ApiError.badRequest("User ID is required");
    }

    const loadedUser = await User.findByIdAndUpdate(userId, { fcmToken }, { new: true });

    if (!loadedUser) {
      UserLogger.warn(`User not found with ID: ${userId}`);
      throw ApiError.notFound("Could not find User.");
    }

    UserLogger.info(`FCM token updated successfully for user: ${userId}`);
    return {
      fcmToken: loadedUser.fcmToken,
      message: "Token Updated Successfully",
    };
  }

  /**
   * ============================================
   * DATA RETRIEVAL METHODS
   * ============================================
   */

  /**
   * Get user orders with pagination
   */
  static async getUserOrders(userId, pageNo) {
    UserLogger.info(`Starting getUserOrders for user: ${userId}, page: ${pageNo}`);

    if (!userId) {
      UserLogger.warn("getUserOrders called with missing user ID");
      throw ApiError.badRequest("User ID is required");
    }

    const page = parseInt(pageNo) || 1;
    const limit = 12;
    const skip = (page - 1) * limit;

    const [bookings, totalCount] = await Promise.all([
      Bookings.find({ userId })
        .populate("userId", "name phoneNo")
        .sort({ bookedOn: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),

      Bookings.countDocuments({ userId }),
    ]);

    UserLogger.info(`Found ${bookings.length} orders for user ${userId}, total: ${totalCount}`);
    return {
      orders: bookings,
      page,
      totalPages: Math.ceil(totalCount / limit),
      total: totalCount,
    };
  }

  /**
   * Get user shares with pagination
   */
  static async getUserShares(userId, skipParam) {
    UserLogger.info(`Starting getUserShares for user: ${userId}, skip: ${skipParam}`);

    if (!userId) {
      UserLogger.warn("getUserShares called with missing user ID");
      throw ApiError.badRequest("User ID is required");
    }

    let skip = parseInt(skipParam) || 0;
    const limit = 12;

    const [total, shares] = await Promise.all([
      Share.countDocuments({ userId }),
      Share.find({ userId }).sort({ shareDate: -1 }).skip(skip).limit(limit).lean(),
    ]);

    if (skip >= total) {
      skip = Math.max(0, total - limit);
    }

    UserLogger.info(`Found ${shares.length} shares for user ${userId}, total: ${total}`);
    return { share: shares, total };
  }

  /**
   * Get user details
   */
  static async getUserDetails(userId) {
    UserLogger.info(`Starting getUserDetails for user: ${userId}`);

    if (!userId) {
      UserLogger.warn("getUserDetails called with missing user ID");
      throw ApiError.badRequest("User ID is required");
    }

    const loadedUser = await User.findOne({ _id: userId }).select("balance  ").lean();

    if (!loadedUser) {
      UserLogger.warn(`User not found with ID: ${userId}`);
      throw ApiError.notFound("Could not find User.");
    }

    UserLogger.debug(`Retrieved balance for user ${userId}: ${loadedUser.balance}`);
    return {
      balance: loadedUser.balance,
    };
  }

  /**
   * Get single user
   */
  static async getUser(userId) {
    UserLogger.info(`Starting getUser for user: ${userId}`);

    if (!userId) {
      UserLogger.warn("getUser called with missing user ID");
      throw ApiError.badRequest("User ID is required");
    }

    const result = await User.findOne({ _id: userId }).lean();

    if (!result) {
      UserLogger.warn(`User not found with ID: ${userId}`);
      throw ApiError.notFound("Could not find User.");
    }

    UserLogger.debug(`Retrieved user details for: ${userId}`);
    return result;
  }

  /**
   * Get user earnings
   */
  static async getUserEarnings(userId) {
    UserLogger.info(`Starting getUserEarnings for user: ${userId}`);

    if (!userId) {
      UserLogger.warn("getUserEarnings called with missing user ID");
      throw ApiError.badRequest("User ID is required");
    }

    const result = await User.findOne({ _id: userId })
      .select("earning pendingShareBy completedShareBy canceledShareBy shareCount")
      .lean();

    if (!result) {
      UserLogger.warn(`User not found with ID: ${userId}`);
      throw ApiError.notFound("Could not find User.");
    }

    UserLogger.debug(`Retrieved earnings for user ${userId}`);
    return result;
  }

  /**
   * ============================================
   * ATTENDANCE METHODS
   * ============================================
   */

  /**
   * Get attendance records
   */
  static async getAttendance(userId, month, year) {
    UserLogger.info(`Starting getAttendance for user: ${userId}, month: ${month}, year: ${year}`);

    if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
      UserLogger.warn(`Invalid user ID format: ${userId}`);
      throw ApiError.badRequest("Valid User ID is required");
    }

    const monthNum = parseInt(month);
    const yearNum = parseInt(year);

    if (isNaN(monthNum) || monthNum < 1 || monthNum > 12) {
      UserLogger.warn(`Invalid month value: ${month}`);
      throw ApiError.badRequest("Month must be between 1 and 12");
    }

    if (isNaN(yearNum) || yearNum < 2000 || yearNum > 2100) {
      UserLogger.warn(`Invalid year value: ${year}`);
      throw ApiError.badRequest("Year must be between 2000 and 2100");
    }

    // Calculate date range
    const startDate = new Date(yearNum, monthNum - 1, 1);
    const endDate = new Date(yearNum, monthNum, 0, 23, 59, 59, 999);
    const startTimestamp = startDate.getTime();
    const endTimestamp = endDate.getTime();

    // Get user account creation date for context
    const user = await User.findById(userId).select("accountCreatedOn").lean();
    const accountCreatedOn = user?.accountCreatedOn ? new Date(user.accountCreatedOn) : null;

    if (accountCreatedOn) {
      accountCreatedOn.setHours(0, 0, 0, 0);
    }

    const currentDate = new Date();
    currentDate.setHours(0, 0, 0, 0);

    // Determine effective date range
    let effectiveStartDate = new Date(startDate);
    let effectiveEndDate = new Date(endDate);

    if (accountCreatedOn && accountCreatedOn > effectiveStartDate) {
      effectiveStartDate = new Date(accountCreatedOn);
    }
    if (currentDate < effectiveEndDate) {
      effectiveEndDate = new Date(currentDate);
    }

    effectiveStartDate.setHours(0, 0, 0, 0);
    effectiveEndDate.setHours(23, 59, 59, 999);

    const totalValidDays = this.calculateDaysBetween(effectiveStartDate, effectiveEndDate);

    // Get attendance records
    const attendanceRecords = await Attendance.find({
      userId: new mongoose.Types.ObjectId(userId),
      $or: [
        {
          presentDate: {
            $gte: startDate.toISOString().split("T")[0],
            $lte: endDate.toISOString().split("T")[0],
          },
        },
        { presentDate: { $gte: startTimestamp, $lte: endTimestamp } },
      ],
    })
      .populate("userId", "name")
      .populate("vendorId", "name")
      .sort({ presentDate: 1 })
      .lean()
      .maxTimeMS(30000);

    UserLogger.info(`Found ${attendanceRecords.length} attendance records for user ${userId}`);

    // Process records
    const processedRecords = attendanceRecords.map((record) => {
      const date = normalizeDateIST(record.presentDate);
      const status = this.determineAttendanceStatus(record);

      return {
        ...record,
        presentDate: date ? date.toISOString() : record.presentDate,
        date: date ? date.toISOString().split("T")[0] : null,
        day: date ? date.getDate() : null,
        dayOfWeek: date ? date.getDay() : null,
        status,
        markedAbsent: record.markedAbsent || false,
        isWithinValidPeriod: date
          ? this.isDateInRange(date, effectiveStartDate, effectiveEndDate)
          : false,
      };
    });

    const validRecords = processedRecords.filter((record) => record.isWithinValidPeriod);
    const presentRecords = validRecords.filter((record) => record.status === "present");
    const absentRecords = validRecords.filter((record) => record.status === "absent");

    // Calculate statistics
    const totalTime = presentRecords.reduce((total, record) => total + (record.totalTime || 0), 0);
    const pageNo1Completed = validRecords.filter((record) => record.pageNo1 === true).length;
    const pageNo2Completed = validRecords.filter((record) => record.pageNo2 === true).length;
    const pageNo3Completed = validRecords.filter((record) => record.pageNo3 === true).length;

    const recordedDates = new Set();
    validRecords.forEach((record) => {
      if (record.date) recordedDates.add(record.date);
    });
    const trueAbsentDays = Math.max(0, totalValidDays - recordedDates.size);

    // Generate monthly calendar
    const monthlyCalendar = this.generateMonthlyCalendar(
      yearNum,
      monthNum,
      processedRecords,
      accountCreatedOn || new Date(2000, 0, 1),
      currentDate,
      effectiveStartDate,
      effectiveEndDate,
    );

    // Build summary
    const averageTimePerDay =
      presentRecords.length > 0 ? Math.round(totalTime / presentRecords.length) : 0;
    const totalPagesCompleted = pageNo1Completed + pageNo2Completed + pageNo3Completed;
    const averagePagesPerDay =
      validRecords.length > 0
        ? Math.round((totalPagesCompleted / validRecords.length) * 100) / 100
        : 0;
    const attendanceRate =
      totalValidDays > 0 ? Math.round((presentRecords.length / totalValidDays) * 100) : 0;
    const absenceRate =
      totalValidDays > 0
        ? Math.round(((absentRecords.length + trueAbsentDays) / totalValidDays) * 100)
        : 0;

    const summary = this.buildSummary(
      new Date(yearNum, monthNum, 0).getDate(),
      totalValidDays,
      validRecords.length,
      presentRecords.length,
      absentRecords.length,
      trueAbsentDays,
      totalTime,
      averageTimePerDay,
      pageNo1Completed,
      pageNo2Completed,
      pageNo3Completed,
      monthNum,
      yearNum,
      averagePagesPerDay,
      attendanceRate,
      absenceRate,
      totalPagesCompleted,
      accountCreatedOn || new Date(2000, 0, 1),
      effectiveStartDate,
      effectiveEndDate,
      startDate,
      endDate,
    );

    UserLogger.info(
      `Attendance summary for user ${userId}: ${presentRecords.length} present, ${absentRecords.length} absent, ${trueAbsentDays} no-record`,
    );

    return {
      data: processedRecords,
      monthlyCalendar,
      summary,
      metadata: {
        userId,
        recordsCount: validRecords.length,
        queryPeriod: `${monthNum}/${yearNum}`,
        generatedAt: new Date().toISOString(),
        totalValidDays,
        statusBreakdown: {
          present: presentRecords.length,
          markedAbsent: absentRecords.length,
          noRecordAbsent: trueAbsentDays,
          future: monthlyCalendar.filter((day) => day.status === "future").length,
          beforeAccount: monthlyCalendar.filter((day) => day.status === "before-account").length,
        },
      },
    };
  }

  /**
   * Post attendance
   */
  static async postAttendance(userId, attendanceData) {
    UserLogger.info(`Starting postAttendance for user: ${userId}`);

    if (!userId) {
      UserLogger.warn("postAttendance called with missing user ID");
      throw ApiError.badRequest("User ID is required");
    }

    const totalTime =
      parseInt(attendanceData.time1) +
      parseInt(attendanceData.time2) +
      parseInt(attendanceData.time3);

    // Check if already marked today
    const userRecord = await User.findById(userId).select("presentDate").lean();
    const targetDate = new Date();
    const storedDate = userRecord?.presentDate ? new Date(userRecord.presentDate) : null;

    if (
      storedDate &&
      storedDate.getDate() === targetDate.getDate() &&
      storedDate.getMonth() === targetDate.getMonth() &&
      storedDate.getFullYear() === targetDate.getFullYear()
    ) {
      UserLogger.warn(`Attendance already marked today for user: ${userId}`);
      return { message: "Attendance already marked today" };
    }

    const attendance = new Attendance({
      userId,
      attendance: true,
      totalTime,
      presentDate: Date.now(),
      pageNo1: true,
      pageNo2: true,
      pageNo3: true,
      attendanceData,
    });

    await attendance.save();
    await User.findByIdAndUpdate(userId, { presentDate: Date.now() });

    UserLogger.info(`Attendance saved successfully for user: ${userId}, total time: ${totalTime}`);
    return { message: "Attendance saved successfully." };
  }

  /**
   * ============================================
   * PRIVATE HELPER METHODS
   * ============================================
   */

  /**
   * Determine attendance status
   */
  static determineAttendanceStatus(record) {
    if (record.attendance === true) return "present";
    if (record.attendance === false || record.markedAbsent === true) return "absent";
    return record.totalTime && record.totalTime > 0 ? "present" : "absent";
  }

  /**
   * Check if date is in range
   */
  static isDateInRange(date, startDate, endDate) {
    return date >= startDate && date <= endDate;
  }

  /**
   * Calculate days between dates
   */
  static calculateDaysBetween(startDate, endDate) {
    const start = new Date(startDate);
    const end = new Date(endDate);
    start.setHours(0, 0, 0, 0);
    end.setHours(0, 0, 0, 0);
    const timeDiff = end.getTime() - start.getTime();
    return Math.max(0, Math.ceil(timeDiff / (1000 * 3600 * 24)) + 1);
  }

  /**
   * Generate monthly calendar for attendance
   */
  static generateMonthlyCalendar(
    year,
    month,
    records,
    accountCreatedOn,
    currentDate,
    effectiveStartDate,
    effectiveEndDate,
  ) {
    const totalDays = new Date(year, month, 0).getDate();
    const calendar = [];

    for (let day = 1; day <= totalDays; day++) {
      const date = new Date(year, month - 1, day);
      date.setHours(0, 0, 0, 0);

      const existingRecord = records.find((record) => {
        const recordDate = normalizeDateIST(record.presentDate);
        return recordDate && recordDate.getTime() === date.getTime();
      });

      let status = "no-record";
      let category = "active";

      if (date < accountCreatedOn) {
        status = "before-account";
        category = "inactive";
      } else if (date > currentDate) {
        status = "future";
        category = "inactive";
      } else if (date < effectiveStartDate || date > effectiveEndDate) {
        status = "outside-range";
        category = "inactive";
      } else if (existingRecord) {
        status = existingRecord.status;
        category = "active";
      } else {
        status = "absent";
        category = "active";
      }

      calendar.push({
        day,
        date: date.toISOString().split("T")[0],
        dayOfWeek: date.getDay(),
        status,
        category,
        record: existingRecord || null,
        isActivePeriod: category === "active",
      });
    }

    return calendar;
  }

  /**
   * Build attendance summary
   */
  static buildSummary(
    totalDaysInMonth,
    totalValidDays,
    totalRecords,
    presentDays,
    absentDays,
    trueAbsentDays,
    totalTime,
    averageTimePerDay,
    pageNo1Completed,
    pageNo2Completed,
    pageNo3Completed,
    month,
    year,
    averagePagesPerDay,
    attendanceRate,
    absenceRate,
    totalPagesCompleted,
    accountCreatedOn,
    effectiveStartDate,
    effectiveEndDate,
    startDate,
    endDate,
  ) {
    return {
      totalDaysInMonth,
      totalValidDays,
      totalRecords,
      presentDays,
      recordedAbsentDays: absentDays,
      trueAbsentDays,
      totalAbsentDays: absentDays + trueAbsentDays,
      totalTime,
      averageTimePerDay,
      pageNo1Completed,
      pageNo2Completed,
      pageNo3Completed,
      totalPagesCompleted,
      averagePagesPerDay,
      attendanceRate,
      absenceRate,
      workingDaysRatio: `${presentDays}/${totalValidDays}`,
      month,
      year,
      period: `${year}-${month.toString().padStart(2, "0")}`,
      accountCreatedOn: accountCreatedOn.toISOString(),
      effectiveStartDate: effectiveStartDate.toISOString(),
      effectiveEndDate: effectiveEndDate.toISOString(),
      dateRange: { start: startDate.toISOString(), end: endDate.toISOString() },
      absenceBreakdown: {
        markedAbsent: absentDays,
        noRecordAbsent: trueAbsentDays,
      },
    };
  }
}

module.exports = UserService;
