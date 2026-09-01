const Bookings = require("../../models/bookings");
const Vendor = require("../../models/vendor");
const User = require("../../models/user");
const { ObjectId } = require("mongodb");
const mongoose = require("mongoose");
const ApiError = require("../utils/ApiError");
const BookingLockService = require("./BookingLockService");
const NotificationService = require("./NotificationService");
const CacheService = require("./CacheService");
const { normalizeDateIST } = require("../utils/dateUtils");
const redisKeys = require("../utils/redisKeys");
const { BookingLogger } = require("../logger/index");
const NotificationOutbox = require("../../models/notificationOutbox");
/**
 * BookingService - Core business logic for all booking operations
 * Follows Single Responsibility Principle
 * All operations are atomic using MongoDB transactions
 */
class BookingService {
  /**
   * ============================================
   * PUBLIC METHODS (Exposed to Controller)
   * ============================================
   */

  /**
   * Create a booking (User booking a vendor)
   *
   * Production Features:
   * - Redis distributed lock before MongoDB transaction
   * - MongoDB transaction with automatic retry (withTransaction)
   * - Database remains source of truth for duplicate booking protection
   * - No duplicate database reads
   * - Uses already-loaded entities
   * - Short transaction duration
   * - Structured logging with requestId
   * - Redis lock always released through BookingLockService
   * - Notification executed only after successful transaction commit
   */
  static async createUserBooking(requestData) {
    const { userId, vendorId, bookingDate, type, pincode, requestId } = requestData;

    let updatedUser;
    let vendor;
    let user;
    let createdBooking;

    const normalizedBookingDate = normalizeDateIST(bookingDate);

    try {
      /**
       * ==========================================================
       * REDIS DISTRIBUTED LOCK
       * ==========================================================
       *
       * Prevent concurrent requests from attempting to reserve
       * the same vendor for the same booking date.
       *
       * MongoDB transaction remains the final source of truth.
       */
      const result = await BookingLockService.withLock(
        {
          vendorId,
          bookingDate: normalizedBookingDate,
          requestId,
        },

        async () => {
          const session = await mongoose.startSession();

          try {
            /**
             * ==================================================
             * MONGODB TRANSACTION
             * ==================================================
             */

            await session.withTransaction(async () => {
              /**
               * ==================================================
               * LOAD REQUIRED ENTITIES
               * ==================================================
               */

              const bookingData = await this.loadEntitiesForUserBooking(
                userId,
                vendorId,
                normalizedBookingDate,
                type,
                pincode,
                session,
              );

              user = bookingData.user;
              vendor = bookingData.vendor;

              /**
               * ==================================================
               * ACCOUNT STATUS VALIDATION
               * ==================================================
               *
               * Availability filtering is NOT enough.
               *
               * The vendor may have been blocked after the
               * availability API returned the vendor.
               *
               * Therefore the actual booking transaction must
               * verify the vendor is still active.
               */

              if (!vendor) {
                throw ApiError.notFound("Vendor not found");
              }

              if (vendor.status !== "active") {
                BookingLogger.warn({
                  event: "BOOKING_BLOCKED_VENDOR_ATTEMPT",
                  userId,
                  vendorId,
                  vendorStatus: vendor.status,
                  normalizedBookingDate,
                  type,
                  pincode,
                  requestId,
                });

                if (vendor.status === "blocked") {
                  throw ApiError.forbidden(
                    "This vendor is currently blocked and cannot accept bookings",
                  );
                }

                throw ApiError.forbidden("This vendor is currently unavailable for bookings");
              }

              /**
               * ==================================================
               * USER STATUS VALIDATION
               * ==================================================
               *
               * Protect against a blocked user using an old
               * authentication/session state.
               */

              if (!user) {
                throw ApiError.notFound("User not found");
              }

              if (user.status !== "active") {
                BookingLogger.warn({
                  event: "BOOKING_BLOCKED_USER_ATTEMPT",
                  userId,
                  vendorId,
                  userStatus: user.status,
                  normalizedBookingDate,
                  requestId,
                });

                if (user.status === "blocked") {
                  throw ApiError.forbidden(
                    "Your account has been blocked and cannot create bookings",
                  );
                }

                throw ApiError.forbidden("Your account is not active");
              }

              /**
               * ==================================================
               * DUPLICATE BOOKING VALIDATION
               * ==================================================
               *
               * Redis lock reduces concurrent contention.
               *
               * MongoDB validation remains the final source
               * of truth.
               */

              if (bookingData.isVendorBooked) {
                throw ApiError.conflict("Vendor is already booked for this date");
              }

              /**
               * ==================================================
               * BALANCE VALIDATION
               * ==================================================
               */

              const { customerCharge, vendorCharge, userBalance, vendorBalance } =
                await this.validateUserBalances(user, vendor);

              /**
               * ==================================================
               * CREATE BOOKING
               * ==================================================
               */

              createdBooking = await this.createBookingDocument(
                userId,
                vendorId,
                normalizedBookingDate,
                type,
                pincode,
                "User",
                userId,
                customerCharge,
                vendorCharge,
                userBalance,
                vendorBalance,
                session,
              );

              /**
               * ==================================================
               * UPDATE ACCOUNTING
               * ==================================================
               */

              ({ updatedUser } = await this.updateAccountingForUserBooking({
                user,
                vendor,
                session,
              }));

              /**
               * ==================================================
               * UPDATE REFERRAL
               * ==================================================
               */

              await Promise.all([
                this.updateReferralForBooking({
                  entity: user,
                  entityType: "user",
                  role: "customer",
                  action: "pending",
                  session,
                }),

                this.updateReferralForBooking({
                  entity: vendor,
                  entityType: "vendor",
                  role: "serviceProvider",
                  action: "pending",
                  session,
                }),
              ]);

              await this.createNotificationOutbox({
                eventType: "BOOKING_CREATED",

                booking: createdBooking,

                userId: user._id,

                vendorId: vendor._id,

                payload: {
                  requestId,

                  type,

                  pincode,

                  bookingDate: normalizedBookingDate,
                },

                session,
              });

              /**
               * ==================================================
               * TEST-ONLY ROLLBACK INJECTION
               * ==================================================
               */

              if (
                process.env.NODE_ENV === "development" &&
                process.env.ALLOW_BOOKING_ROLLBACK_TEST === "1" &&
                process.env.BOOKING_FAILURE_POINT === "after_user_creation_mutations"
              ) {
                throw new Error("BOOKING_TEST_INJECTED_USER_CREATION_FAILURE");
              }
            });

            /**
             * ==================================================
             * TRANSACTION COMMITTED
             * ==================================================
             *
             * At this point:
             *
             * 1. Redis lock was acquired
             * 2. Vendor was verified as active
             * 3. User was verified as active
             * 4. Duplicate booking was checked
             * 5. Booking was created
             * 6. Accounting was updated
             * 7. Referral data was updated
             * 8. MongoDB transaction committed
             *
             * Notifications are intentionally sent after
             * leaving the critical transaction/lock section.
             */

            return {
              message: "Booking created successfully",

              data: {
                balance: updatedUser.balance,
              },
            };
          } finally {
            /**
             * Always close MongoDB session.
             */
            await session.endSession();
          }
        },
      );

      /**
       * ==========================================================
       * INVALIDATE VENDOR AVAILABILITY CACHE
       * ==========================================================
       */

      const cacheDate = normalizedBookingDate.toISOString().slice(0, 10);

      await Promise.all([
        CacheService.invalidateTag("vendors"),

        CacheService.invalidateTag("availability"),

        CacheService.invalidateTag(`availability:${cacheDate}`),
      ]);

      /**
       * ==========================================================
       * POST-COMMIT NOTIFICATION
       * ==========================================================
       *
       * Notification failure must NEVER roll back or fail
       * an already successful booking.
       */

      // NotificationService.bookingCreated({
      //   booking: createdBooking,
      //   user,
      //   vendor,
      //   requestId,
      // }).catch((err) => {
      //   BookingLogger.error(
      //     {
      //       event: "BOOKING_NOTIFICATION_QUEUE_FAILED",
      //       bookingId: createdBooking?._id,
      //       userId,
      //       vendorId,
      //       normalizedBookingDate,
      //       requestId,
      //       error: err.message,
      //     },
      //     "Failed to queue booking notifications",
      //   );
      // });

      /**
       * ==========================================================
       * SUCCESS LOG
       * ==========================================================
       */

      BookingLogger.info(
        {
          event: "USER_BOOKING_CREATED",

          userId,
          vendorId,
          normalizedBookingDate,
          type,
          pincode,
          requestId,
        },

        "User booking created successfully",
      );

      return result;
    } catch (error) {
      /**
       * ==========================================================
       * DUPLICATE BOOKING ERROR
       * ==========================================================
       */

      if (this.isDuplicateBookingError(error)) {
        BookingLogger.warn(
          {
            event: "DUPLICATE_USER_BOOKING_BLOCKED",

            userId,
            vendorId,
            normalizedBookingDate,
            requestId,
          },

          "Duplicate active booking prevented by MongoDB",
        );

        throw ApiError.conflict("Vendor is already booked for this date");
      }

      /**
       * ==========================================================
       * BOOKING FAILURE
       * ==========================================================
       */

      BookingLogger.error(
        {
          event: "USER_BOOKING_FAILED",

          userId,
          vendorId,
          normalizedBookingDate,
          type,
          pincode,
          requestId,

          error: error.message,
          code: error.code,
          stack: error.stack,
        },

        "User booking failed",
      );

      throw error;
    }
  }

  /**
   * Create a booking
   * (Vendor booking another vendor or self-booking)
   *
   * Production Features:
   * - Redis distributed lock
   * - MongoDB withTransaction()
   * - MongoDB remains final source of truth
   * - No duplicate DB reads
   * - Automatic transaction retry
   * - Self-booking support
   * - Structured logging
   * - Notification outside transaction
   * - Notification outside Redis critical section
   */
  static async createVendorBooking(requestData) {
    const {
      userId,
      vendorId,
      bookingDate,
      type,
      pincode,

      isSelfBooking,

      name,
      phoneNo,
      vill,
      post,
      dist,

      requestId,
    } = requestData;

    let vendor;
    let vendorUser;
    let updatedVendorUser;
    let createdBooking;

    let selfBooking = false;
    let selfBookingId = null;

    const normalizedBookingDate = normalizeDateIST(bookingDate);

    try {
      /**
       * ==========================================================
       * VALIDATE SELF-BOOKING REQUEST
       * ==========================================================
       *
       * For self-booking:
       *
       * userId === vendorId
       *
       * If the request claims to be a self-booking but the IDs
       * don't match, reject it immediately.
       */

      if (isSelfBooking === true && userId?.toString() !== vendorId?.toString()) {
        throw ApiError.badRequest("Invalid self-booking request");
      }

      /**
       * ==========================================================
       * REDIS DISTRIBUTED LOCK
       * ==========================================================
       *
       * vendorId represents the vendor whose availability is
       * being reserved.
       *
       * Vendor A books Vendor B:
       *
       * lock:booking:VendorB:bookingDate
       */

      const result = await BookingLockService.withLock(
        {
          vendorId,
          bookingDate: normalizedBookingDate,
          requestId,
        },

        async () => {
          const session = await mongoose.startSession();

          try {
            /**
             * ==================================================
             * MONGODB TRANSACTION
             * ==================================================
             */

            await session.withTransaction(async () => {
              /**
               * ==================================================
               * SELF BOOKING
               * ==================================================
               *
               * Vendor books themselves.
               */

              if (isSelfBooking === true && userId?.toString() === vendorId?.toString()) {
                /**
                 * ------------------------------------------------
                 * Load the vendor inside the transaction.
                 * ------------------------------------------------
                 */

                vendor = await Vendor.findById(vendorId).session(session).select("-password");

                if (!vendor) {
                  throw ApiError.notFound("Vendor not found");
                }

                /**
                 * ------------------------------------------------
                 * Vendor status check
                 * ------------------------------------------------
                 *
                 * A blocked vendor must not be able to create
                 * a self-booking.
                 */

                if (vendor.status !== "active") {
                  BookingLogger.warn({
                    event: "SELF_BOOKING_BLOCKED_VENDOR",
                    userId,
                    vendorId,
                    vendorStatus: vendor.status,
                    normalizedBookingDate,
                    requestId,
                  });

                  if (vendor.status === "blocked") {
                    throw ApiError.forbidden(
                      "Your vendor account has been blocked and cannot create bookings",
                    );
                  }

                  throw ApiError.forbidden("Your vendor account is not active");
                }

                /**
                 * ------------------------------------------------
                 * Check existing booking
                 * ------------------------------------------------
                 */

                const existingBooking = await Bookings.exists({
                  vendorId,
                  bookingDate: normalizedBookingDate,
                  cancelOrder: false,
                  orderCompleted: false,
                }).session(session);

                if (existingBooking) {
                  throw ApiError.conflict("Vendor is already booked for this date");
                }

                /**
                 * ------------------------------------------------
                 * Create self-booking
                 * ------------------------------------------------
                 */

                const booking = await this.createSelfBooking(
                  userId,
                  vendorId,
                  normalizedBookingDate,
                  type,
                  pincode,
                  name,
                  phoneNo,
                  vill,
                  post,
                  dist,
                  "Vendor",
                  vendorId,
                  session,
                );

                selfBooking = true;
                selfBookingId = booking._id;

                return;
              }

              /**
               * ==================================================
               * NORMAL VENDOR → VENDOR BOOKING
               * ==================================================
               */

              const bookingData = await this.loadEntitiesForVendorBooking(
                userId,
                vendorId,
                normalizedBookingDate,
                type,
                pincode,
                session,
              );

              vendor = bookingData.vendor;

              vendorUser = bookingData.vendorUser;

              /**
               * ==================================================
               * TARGET VENDOR STATUS
               * ==================================================
               *
               * The vendor being booked must still be active.
               *
               * This protects against:
               *
               * Vendor shown as active
               *        ↓
               * Admin blocks vendor
               *        ↓
               * Old vendorId is submitted
               *        ↓
               * Booking API
               */

              if (!vendor) {
                throw ApiError.notFound("Vendor not found");
              }

              if (vendor.status !== "active") {
                BookingLogger.warn({
                  event: "VENDOR_BOOKING_BLOCKED_TARGET_VENDOR",
                  userId,
                  vendorId,
                  vendorStatus: vendor.status,
                  normalizedBookingDate,
                  type,
                  pincode,
                  requestId,
                });

                if (vendor.status === "blocked") {
                  throw ApiError.forbidden(
                    "This vendor is currently blocked and cannot accept bookings",
                  );
                }

                throw ApiError.forbidden("This vendor is currently unavailable for bookings");
              }

              /**
               * ==================================================
               * BOOKING VENDOR ACCOUNT STATUS
               * ==================================================
               *
               * vendorUser is the vendor who is creating the
               * booking.
               *
               * That account must also be active.
               */

              if (!vendorUser) {
                throw ApiError.notFound("Vendor account not found");
              }

              if (vendorUser.status !== "active") {
                BookingLogger.warn({
                  event: "VENDOR_BOOKING_BLOCKED_BOOKING_VENDOR",
                  userId,
                  vendorId,
                  vendorUserStatus: vendorUser.status,
                  normalizedBookingDate,
                  requestId,
                });

                if (vendorUser.status === "blocked") {
                  throw ApiError.forbidden(
                    "Your vendor account has been blocked and cannot create bookings",
                  );
                }

                throw ApiError.forbidden("Your vendor account is not active");
              }

              /**
               * ==================================================
               * MONGODB FINAL AVAILABILITY CHECK
               * ==================================================
               *
               * Redis lock only reduces concurrent contention.
               *
               * MongoDB remains the final source of truth.
               */

              if (bookingData.isVendorBooked) {
                throw ApiError.conflict("Vendor is already booked for this date");
              }

              /**
               * ==================================================
               * VALIDATE BALANCES
               * ==================================================
               */

              const { customerCharge, vendorCharge, userBalance, vendorBalance } =
                await this.validateVendorBalances(vendorUser, vendor);

              /**
               * ==================================================
               * CREATE BOOKING
               * ==================================================
               */

              createdBooking = await this.createBookingDocument(
                userId,
                vendorId,
                normalizedBookingDate,
                type,
                pincode,
                "Vendor",
                userId,
                customerCharge,
                vendorCharge,
                userBalance,
                vendorBalance,
                session,
              );

              /**
               * ==================================================
               * UPDATE ACCOUNTING
               * ==================================================
               */

              ({ updatedVendorUser } = await this.updateAccountingForVendorBooking({
                vendorUser,
                vendor,
                session,
              }));

              /**
               * ==================================================
               * UPDATE REFERRAL
               * ==================================================
               */

              await Promise.all([
                this.updateReferralForBooking({
                  entity: vendorUser,
                  entityType: "vendor",
                  role: "customer",
                  action: "pending",
                  session,
                }),

                this.updateReferralForBooking({
                  entity: vendor,
                  entityType: "vendor",
                  role: "serviceProvider",
                  action: "pending",
                  session,
                }),
              ]);

              await this.createNotificationOutbox({
                eventType: "BOOKING_CREATED",

                booking: createdBooking,

                userId: vendorUser._id,

                vendorId: vendor._id,

                payload: {
                  requestId,

                  type,

                  pincode,

                  bookingDate: normalizedBookingDate,
                },

                session,
              });
              /**
               * ==================================================
               * TEST-ONLY ROLLBACK INJECTION
               * ==================================================
               */

              if (
                process.env.NODE_ENV === "development" &&
                process.env.ALLOW_BOOKING_ROLLBACK_TEST === "1" &&
                process.env.BOOKING_FAILURE_POINT === "after_vendor_creation_mutations"
              ) {
                throw new Error("BOOKING_TEST_INJECTED_VENDOR_CREATION_FAILURE");
              }
            });

            /**
             * ==================================================
             * TRANSACTION SUCCESS
             * ==================================================
             */

            if (selfBooking) {
              return {
                message: "Self-booking created successfully",

                data: {
                  bookingId: selfBookingId,
                },
              };
            }

            return {
              message: "Booking created successfully",

              data: {
                balance: updatedVendorUser.balance,
              },
            };
          } finally {
            /**
             * Always close MongoDB session.
             */
            await session.endSession();
          }
        },
      );

      /**
       * ==========================================================
       * INVALIDATE AVAILABILITY CACHE
       * ==========================================================
       */

      const cacheDate = normalizedBookingDate.toISOString().slice(0, 10);

      await Promise.all([
        CacheService.invalidateTag("vendors"),

        CacheService.invalidateTag("availability"),

        CacheService.invalidateTag(`availability:${cacheDate}`),
      ]);

      /**
       * ==========================================================
       * SELF BOOKING
       * ==========================================================
       *
       * Do not send normal vendor-booking notifications unless
       * explicitly required by the business rules.
       */

      if (selfBooking) {
        BookingLogger.info(
          {
            event: "SELF_BOOKING_CREATED",

            userId,
            vendorId,

            bookingId: selfBookingId,

            normalizedBookingDate,

            type,
            pincode,

            requestId,
          },

          "Self-booking created successfully",
        );

        return result;
      }

      /**
       * ==========================================================
       * POST-COMMIT NOTIFICATION
       * ==========================================================
       *
       * MongoDB transaction has committed and the Redis lock has
       * already been released.
       *
       * Notification failure must NEVER roll back or fail an
       * already successful booking.
       */

      // NotificationService.bookingCreated({
      //   booking: createdBooking,
      //   user: vendorUser,
      //   vendor,
      //   requestId,
      // }).catch((err) => {
      //   BookingLogger.error(
      //     {
      //       event: "VENDOR_BOOKING_NOTIFICATION_QUEUE_FAILED",

      //       bookingId: createdBooking?._id,

      //       userId,
      //       vendorId,

      //       normalizedBookingDate,

      //       requestId,

      //       error: err.message,
      //     },

      //     "Failed to queue vendor booking notifications",
      //   );
      // });

      /**
       * ==========================================================
       * SUCCESS LOG
       * ==========================================================
       */

      BookingLogger.info(
        {
          event: "VENDOR_BOOKING_CREATED",

          userId,
          vendorId,

          normalizedBookingDate,

          type,
          pincode,

          requestId,
        },

        "Vendor booking created successfully",
      );

      return result;
    } catch (error) {
      /**
       * ==========================================================
       * DUPLICATE BOOKING ERROR
       * ==========================================================
       */

      if (this.isDuplicateBookingError(error)) {
        BookingLogger.warn(
          {
            event: "DUPLICATE_VENDOR_BOOKING_BLOCKED",

            userId,
            vendorId,

            normalizedBookingDate,

            requestId,
          },

          "Duplicate active booking prevented by MongoDB",
        );

        throw ApiError.conflict("Vendor is already booked for this date");
      }

      /**
       * ==========================================================
       * BOOKING FAILURE
       * ==========================================================
       */

      BookingLogger.error(
        {
          event: "VENDOR_BOOKING_FAILED",

          userId,
          vendorId,

          normalizedBookingDate,

          type,
          pincode,

          requestId,

          error: error.message,
          code: error.code,
          stack: error.stack,
        },

        "Vendor booking failed",
      );

      throw error;
    }
  }

  static async cancelUserBooking(bookingId, authenticatedUserId, requestId = null) {
    return this.cancelBooking(bookingId, "user", authenticatedUserId, requestId);
  }

  static async cancelVendorBooking(bookingId, authenticatedVendorId, requestId = null) {
    return this.cancelBooking(bookingId, "vendor", authenticatedVendorId, requestId);
  }
  static isDuplicateBookingError(error) {
    return error?.code === 11000;
  }
  /**
   * Mark booking as complete (User)
   */
  static async completeUserBooking(bookingId, authenticatedUserId, requestId = null) {
    return this.completeBooking(bookingId, "user", authenticatedUserId, requestId);
  }

  static async completeVendorBooking(bookingId, authenticatedVendorId, requestId = null) {
    return this.completeBooking(bookingId, "vendor", authenticatedVendorId, requestId);
  }

  /**
   * Give rating to a booking
   */
  static async giveRating(bookingId, rating, review, authenticatedRole, authenticatedId) {
    const numericRating = Number(rating);
    let booking;
    if (!Number.isInteger(numericRating) || numericRating < 1 || numericRating > 5) {
      throw ApiError.badRequest("Rating must be an integer between 1 and 5");
    }

    const session = await mongoose.startSession();

    try {
      await session.withTransaction(async () => {
        booking = await Bookings.findById(bookingId).session(session).lean();

        /*
         * IMPORTANT:
         * Check existence BEFORE accessing booking.userId,
         * booking.vendorId, booking.orderCompleted, etc.
         */
        if (!booking) {
          throw ApiError.notFound("Booking not found");
        }

        /*
         * Authentication must exist.
         */
        if (!authenticatedId || !authenticatedRole) {
          throw ApiError.unauthorized("Authentication required");
        }

        /*
         * Only supported customer roles may rate.
         */
        if (authenticatedRole !== "user" && authenticatedRole !== "vendor") {
          throw ApiError.forbidden("You are not authorized to rate this booking");
        }

        /*
         * Customer ownership check.
         *
         * booking.userId is the customer.
         * booking.vendorId is the service provider.
         */
        if (String(booking.userId) !== String(authenticatedId)) {
          throw ApiError.forbidden("You are not authorized to rate this booking");
        }

        /*
         * Booking state checks.
         */
        if (booking.cancelOrder) {
          throw ApiError.badRequest("Cancelled booking cannot be rated");
        }

        if (!booking.orderCompleted) {
          throw ApiError.badRequest("Booking must be completed before rating");
        }

        if (Number(booking.rating) !== 0) {
          throw ApiError.conflict("Booking has already been rated");
        }

        this.validateRatingPermission(booking);

        const result = await Bookings.updateOne(
          {
            _id: bookingId,

            // Defense-in-depth ownership condition
            userId: authenticatedId,

            cancelOrder: false,
            orderCompleted: true,
            rating: 0,
          },
          {
            $set: {
              rating: numericRating,
              review: review || "",
              reviewedOn: new Date(),
            },
          },
          {
            session,
          },
        );

        if (result.modifiedCount !== 1) {
          throw ApiError.conflict("Booking has already been rated or booking state changed");
        }

        await this.updateVendorRating(booking.vendorId, session);
      });

      try {
        await Promise.all([
          CacheService.invalidateTag("reviews"),
          CacheService.invalidateTag(`reviews:${booking?.vendorId}`),
          CacheService.delete(redisKeys.VENDOR_CACHE(booking.vendorId)),
        ]);
      } catch (error) {
        BookingLogger.warn(
          {
            event: "REVIEW_CACHE_INVALIDATION_FAILED",
            bookingId,
            vendorId: booking.vendorId,
            err: error,
          },
          "Failed to invalidate review cache",
        );
      }

      return {
        message: "Thanks for your rating!",
      };
    } finally {
      await session.endSession();
    }
  }

  /**
   * Get bookings for a user with pagination
   */
  static async getUserBookings(userId, page, pageSize = 12) {
    const skip = (page - 1) * pageSize;

    const [bookings, totalCount] = await Promise.all([
      Bookings.find({ userId: new ObjectId(userId) })
        .populate("vendorId", "name phoneNo type")
        .sort({ bookedOn: -1 })
        .skip(skip)
        .limit(pageSize)
        .lean(),

      Bookings.countDocuments({ userId: new ObjectId(userId) }),
    ]);

    const currentTime = Date.now();
    const formattedBookings = bookings.map((booking) => {
      const isPastBooking = new Date(booking.bookingDate).getTime() < currentTime;
      const showFullPhone = isPastBooking && !booking.cancelOrder && booking.rating === 0;

      let phoneNo = booking.vendorId?.phoneNo?.toString() || "";
      // if (!showFullPhone && phoneNo) {
      //   phoneNo = phoneNo.replace(/(\d{2})\d{6}(\d{2})/, "$1******$2");
      // }

      return {
        bookingId: booking._id,
        name: booking.vendorId?.name || "Unknown",
        phoneNo: phoneNo,
        type: booking.type,
        date: booking.bookingDate,
        cancelOrder: booking.cancelOrder,
        orderCompleted: booking.orderCompleted,
        rating: booking.rating,
        review: booking.review,
        isSelfBooked: booking.isSelfBooked,
        userId: booking.userId,
        vendorId: booking.vendorId._id,
      };
    });

    return {
      page,
      pageSize,
      total: totalCount,
      totalPages: Math.ceil(totalCount / pageSize),
      orders: formattedBookings,
    };
  }

  static async getVendorReviews(vendorId, page, pageSize = 12) {
    if (!mongoose.Types.ObjectId.isValid(vendorId)) {
      throw ApiError.badRequest("Invalid vendor id");
    }

    page = Math.max(1, Number(page) || 1);
    pageSize = Math.max(1, Math.min(50, Number(pageSize) || 12));

    const skip = (page - 1) * pageSize;

    const cacheKey = redisKeys.VENDOR_REVIEWS_CACHE(vendorId, page, pageSize);

    return CacheService.remember(
      cacheKey,
      60, // Cache for 1 minute
      async () => {
        const query = {
          vendorId: new ObjectId(vendorId),
          rating: {
            $gt: 0,
            $exists: true,
            $ne: null,
          },
        };

        const [reviews, totalCount] = await Promise.all([
          Bookings.find(query)
            .populate("bookedById", "name")
            .select("bookingDate rating review reviewedOn bookedById bookingBy")
            .sort({ reviewedOn: -1 })
            .skip(skip)
            .limit(pageSize)
            .lean(),

          CacheService.remember(
            redisKeys.VENDOR_REVIEW_COUNT(vendorId),
            60,
            () => Bookings.countDocuments(query),
            {
              tags: ["reviews"],
            },
          ),
        ]);

        return {
          page,
          pageSize,
          total: totalCount,
          totalPages: Math.ceil(totalCount / pageSize),
          reviews,
        };
      },
      {
        tags: ["reviews", `reviews:${vendorId}`],
      },
    );
  }

  /**
   * ============================================
   * PRIVATE METHODS (Internal Logic)
   * ============================================
   */

  static async loadEntitiesForUserBooking(userId, vendorId, bookingDate, type, pincode, session) {
    const queryOptions = { session };

    const [isVendorBooked, vendor, user] = await Promise.all([
      // ==========================================================
      // CHECK EXISTING BOOKING
      // ==========================================================

      Bookings.exists({
        vendorId,
        bookingDate,
        cancelOrder: false,
        orderCompleted: false,
      }).session(session),

      // ==========================================================
      // LOAD TARGET VENDOR
      // ==========================================================

      Vendor.findById(vendorId)
        .select(
          [
            "balance",
            "commission",
            "phoneNo",
            "totalDiscount",
            "transactionCount",
            "totalOriginalAmount",
            "cd",
            "shareBy",
            "completedVendor",
            "status",
            "fcmToken",
          ].join(" "),
        )
        .lean()
        .setOptions(queryOptions),

      // ==========================================================
      // LOAD USER
      // ==========================================================

      User.findById(userId)
        .select(
          [
            "balance",
            "name",
            "phoneNo",
            "totalDiscount",
            "transactionCount",
            "totalOriginalAmount",
            "cd",
            "shareBy",
            "completed",
            "status",
            "fcmToken",
          ].join(" "),
        )
        .lean()
        .setOptions(queryOptions),
    ]);

    // ==========================================================
    // USER EXISTENCE
    // ==========================================================

    if (!user) {
      throw ApiError.notFound("User not found");
    }

    // ==========================================================
    // USER STATUS
    // ==========================================================

    if (user.status !== "active") {
      if (user.status === "blocked") {
        throw ApiError.forbidden("Your account has been blocked and cannot create bookings");
      }

      throw ApiError.forbidden("Your account is not active");
    }

    // ==========================================================
    // VENDOR EXISTENCE
    // ==========================================================

    if (!vendor) {
      throw ApiError.notFound("Vendor not found");
    }

    // ==========================================================
    // VENDOR STATUS
    // ==========================================================

    if (vendor.status !== "active") {
      if (vendor.status === "blocked") {
        throw ApiError.forbidden("This vendor is currently blocked and cannot accept bookings");
      }

      throw ApiError.forbidden("This vendor is currently unavailable for bookings");
    }

    return {
      isVendorBooked: Boolean(isVendorBooked),

      user,

      vendor,
    };
  }

  static async loadEntitiesForVendorBooking(userId, vendorId, bookingDate, type, pincode, session) {
    const queryOptions = { session };

    const [isVendorBooked, vendor, vendorUser] = await Promise.all([
      // ==========================================================
      // CHECK EXISTING BOOKING
      // ==========================================================

      Bookings.exists({
        vendorId,
        bookingDate,
        cancelOrder: false,
        orderCompleted: false,
      }).session(session),

      // ==========================================================
      // LOAD TARGET VENDOR
      // ==========================================================

      Vendor.findById(vendorId)
        .select(
          [
            "balance",
            "commission",
            "phoneNo",
            "totalDiscount",
            "totalOriginalAmount",
            "transactionCount",
            "cd",
            "shareBy",
            "completedVendor",
            "status",
            "fcmToken",
          ].join(" "),
        )
        .lean()
        .setOptions(queryOptions),

      // ==========================================================
      // LOAD VENDOR MAKING THE BOOKING
      // ==========================================================

      Vendor.findById(userId)
        .select(
          [
            "balance",
            "name",
            "phoneNo",
            "totalDiscount",
            "transactionCount",
            "totalOriginalAmount",
            "cd",
            "shareBy",
            "completed",
            "status",
            "fcmToken",
          ].join(" "),
        )
        .lean()
        .setOptions(queryOptions),
    ]);

    // ==========================================================
    // BOOKING VENDOR EXISTENCE
    // ==========================================================

    if (!vendorUser) {
      throw ApiError.notFound("Vendor user not found");
    }

    // ==========================================================
    // BOOKING VENDOR STATUS
    // ==========================================================
    //
    // vendorUser = vendor who is making the booking
    //

    if (vendorUser.status !== "active") {
      if (vendorUser.status === "blocked") {
        throw ApiError.forbidden("Your vendor account has been blocked and cannot create bookings");
      }

      throw ApiError.forbidden("Your vendor account is not active");
    }

    // ==========================================================
    // TARGET VENDOR EXISTENCE
    // ==========================================================

    if (!vendor) {
      throw ApiError.notFound("Vendor not found");
    }

    // ==========================================================
    // TARGET VENDOR STATUS
    // ==========================================================

    if (vendor.status !== "active") {
      if (vendor.status === "blocked") {
        throw ApiError.forbidden("This vendor is currently blocked and cannot accept bookings");
      }

      throw ApiError.forbidden("This vendor is currently unavailable for bookings");
    }

    return {
      isVendorBooked: Boolean(isVendorBooked),

      vendor,

      vendorUser,
    };
  }

  static async createNotificationOutbox({
    eventType,
    booking,
    userId = null,
    vendorId = null,
    payload = {},
    session,
  }) {
    if (!booking?._id) {
      throw new Error("Notification outbox requires bookingId");
    }

    if (!session) {
      throw new Error("Notification outbox requires MongoDB session");
    }

    const [outbox] = await NotificationOutbox.create(
      [
        {
          eventType,

          bookingId: booking._id,

          userId,
          vendorId,

          payload,

          status: "PENDING",

          attempts: 0,

          availableAt: new Date(),
        },
      ],
      {
        session,
      },
    );

    BookingLogger.debug(
      {
        event: "NOTIFICATION_OUTBOX_CREATED",
        outboxId: outbox._id,
        eventType,
        bookingId: booking._id,
        userId,
        vendorId,
      },
      "Notification outbox entry created",
    );

    return outbox;
  }

  /**
   * Safely calculate discount ratio.
   *
   * Existing business rule preserved:
   * average discount percentage = totalDiscount / transactionCount
   * multiplier = 1 - percentage / 100
   */
  static calculateDiscountMultiplier(totalDiscount, totalOriginalAmount) {
    const discount = Number(totalDiscount) || 0;
    const amount = Number(totalOriginalAmount) || 0;

    // If no discount, return 1 (full charge)
    if (amount <= 0 || discount <= 0) {
      return 1;
    }

    // ✅ CORRECT: Calculate discount rate (0 to 1)
    const discountRate = discount / amount; // 0.4684 (46.84%)

    // ✅ CORRECT: Calculate multiplier (0 to 1)
    // If discount is 0%, multiplier = 1 (pay full)
    // If discount is 100%, multiplier = 0 (pay nothing)
    const multiplier = 1 - discountRate; // 0.5316

    // Defensive protection against corrupted historical data.
    return Math.max(0, Math.min(1, multiplier));
  }

  /**
   * Calculate booking charges from already-loaded entities.
   *
   * IMPORTANT:
   * Use this method for BOTH validation and actual deduction so
   * the two paths can never drift apart.
   */
  static calculateBookingCharges(customer, vendor) {
    const customerMultiplier = this.calculateDiscountMultiplier(
      customer.totalDiscount,
      customer.totalOriginalAmount,
    );

    const vendorMultiplier = this.calculateDiscountMultiplier(
      vendor.totalDiscount,
      vendor.totalOriginalAmount,
    );

    const customerCharge = 10 * customerMultiplier;

    const vendorCommission = Number(vendor.commission) || 0;
    const vendorCharge = vendorCommission * vendorMultiplier;

    return {
      customerCharge,
      vendorCharge,
      customerMultiplier,
      vendorMultiplier,
    };
  }

  static validateUserBalances(user, vendor) {
    const { customerCharge, vendorCharge } = this.calculateBookingCharges(user, vendor);

    if (Number(user.balance || 0) < customerCharge || Number(vendor.balance || 0) < vendorCharge) {
      throw ApiError.paymentRequired("Insufficient balance for booking");
    }

    const userBalance = user.balance;
    const vendorBalance = vendor.balance;

    return {
      customerCharge,
      vendorCharge,
      userBalance,
      vendorBalance,
    };
  }

  static validateVendorBalances(vendorUser, vendor) {
    const { customerCharge, vendorCharge } = this.calculateBookingCharges(vendorUser, vendor);

    if (
      Number(vendorUser.balance || 0) < customerCharge ||
      Number(vendor.balance || 0) < vendorCharge
    ) {
      throw ApiError.paymentRequired("Insufficient balance for booking");
    }
    const userBalance = vendorUser.balance;
    const vendorBalance = vendor.balance;

    return {
      customerCharge,
      vendorCharge,
      userBalance,
      vendorBalance,
    };
  }

  /**
   * Create booking document
   */
  static async createBookingDocument(
    userId,
    vendorId,
    bookingDate,
    type,
    pincode,
    bookingBy,
    bookedById,
    expenseUserCharge = 0,
    expenseVendorCharge = 0,
    userBalance = 0,
    vendorBalance = 0,
    session,
  ) {
    const now = new Date();

    const [booking] = await Bookings.create(
      [
        {
          userId,
          vendorId,
          bookingDate,
          type,
          pincode,
          bookingBy,
          bookedById,
          bookedOn: now,
          bookingTime: now.getTime(),
          cancelOrder: false,
          orderCompleted: false,
          rating: 0,
          expenseUser: expenseUserCharge,
          expenseVendor: expenseVendorCharge,
          previousBalanceUser: userBalance,
          previousBalanceVendor: vendorBalance,
        },
      ],
      { session },
    );

    return booking;
  }

  /**
   * Create self-booking document
   */
  static async createSelfBooking(
    userId,
    vendorId,
    bookingDate,
    type,
    pincode,
    name,
    phoneNo,
    vill,
    post,
    dist,
    bookingBy,
    bookedById,
    session,
  ) {
    const bookedOn = new Date();
    const bookingTime = Date.now();

    const booking = new Bookings({
      userId,
      vendorId,
      bookingDate,
      type,
      pincode,
      bookedOn,
      bookingTime,
      cancelOrder: false,
      orderCompleted: false,
      rating: 0,
      ratingPermission: false,
      name,
      phoneNo,
      vill,
      post,
      dist,
      bookingBy,
      bookedById,
    });

    const result = await booking.save({ session });

    await Vendor.findByIdAndUpdate(vendorId, { $inc: { bookingCount: 1 } }, { new: true, session });

    return result;
  }

  /**
   * Update accounting for user booking.
   *
   * Caller must pass the already loaded user & vendor.
   * This avoids 2 unnecessary database reads.
   */
  static async updateAccountingForUserBooking({ user, vendor, session }) {
    const { customerCharge, vendorCharge } = this.calculateBookingCharges(user, vendor);
    const [updatedUser, updatedVendor] = await Promise.all([
      User.findOneAndUpdate(
        {
          _id: user._id,
          balance: { $gte: customerCharge },
        },
        {
          $inc: {
            balance: -customerCharge,
            bookingCount: 1,
            pending: 1,
          },
        },
        {
          new: true,
          session,
        },
      ),

      Vendor.findOneAndUpdate(
        {
          _id: vendor._id,
          balance: { $gte: vendorCharge },
        },
        {
          $inc: {
            balance: -vendorCharge,
            pendingVendor: 1,
            bookingCountVendor: 1,
          },
        },
        {
          new: true,
          session,
        },
      ),
    ]);

    if (!updatedUser || !updatedVendor) {
      throw ApiError.paymentRequired("Insufficient balance for booking");
    }

    return {
      updatedUser,
      updatedVendor,
      customerCharge,
      vendorCharge,
    };
  }

  static async updateAccountingForVendorBooking({ vendorUser, vendor, session }) {
    const { customerCharge, vendorCharge } = this.calculateBookingCharges(vendorUser, vendor);

    const [updatedVendorUser, updatedVendor] = await Promise.all([
      Vendor.findOneAndUpdate(
        {
          _id: vendorUser._id,
          balance: { $gte: customerCharge },
        },
        {
          $inc: {
            balance: -customerCharge,
            bookingCount: 1,
            pending: 1,
          },
        },
        {
          new: true,
          session,
        },
      ),

      Vendor.findOneAndUpdate(
        {
          _id: vendor._id,
          balance: { $gte: vendorCharge },
        },
        {
          $inc: {
            balance: -vendorCharge,
            pendingVendor: 1,
            bookingCountVendor: 1,
          },
        },
        {
          new: true,
          session,
        },
      ),
    ]);

    if (!updatedVendorUser || !updatedVendor) {
      throw ApiError.paymentRequired("Insufficient balance for booking");
    }

    return {
      updatedVendorUser,
      updatedVendor,
      customerCharge,
      vendorCharge,
    };
  }

  /**
   * Cancel a booking (Unified logic for User & Vendor)
   *
   * Production Features:
   * - MongoDB withTransaction()
   * - Automatic retry on transient transaction errors
   * - Parallel database updates
   * - Structured logging
   * - Notification outside transaction
   */
  static async cancelBooking(bookingId, entityType, authenticatedCustomerId, requestId = null) {
    const session = await mongoose.startSession();

    let booking;
    let formattedDate;
    let userName;

    try {
      await session.withTransaction(async () => {
        // ========================================================
        // LOAD BOOKING
        // ========================================================

        booking = await this.loadBookingForCancel(bookingId, entityType, session);

        this.assertBookingCustomerOwnership(booking, authenticatedCustomerId);

        // ========================================================
        // VALIDATION
        // ========================================================

        if (booking.orderCompleted) {
          throw ApiError.badRequest("You can't cancel this order. This is already completed");
        }

        if (booking.cancelOrder) {
          throw ApiError.badRequest("This booking is already cancelled");
        }

        // ========================================================
        // PREPARE NOTIFICATION DATA
        // ========================================================

        const bookingDateObj = new Date(booking.bookingDate);

        formattedDate =
          `${bookingDateObj.getDate()}/` +
          `${bookingDateObj.getMonth() + 1}/` +
          `${bookingDateObj.getFullYear()}`;

        userName = booking.userId?.name || "User";

        // ========================================================
        // MARK BOOKING CANCELLED
        // ========================================================

        await this.markBookingCancelled(bookingId, session);

        // ========================================================
        // ACCOUNTING + REFERRAL
        // ========================================================

        const tasks = [];

        if (entityType === "user") {
          tasks.push(this.updateUserCancel(booking, session));
        } else {
          tasks.push(this.updateVendorCancel(booking, session));
        }

        tasks.push(
          this.updateReferralForBooking({
            entity: booking.userId,

            entityType: entityType === "user" ? "user" : "vendor",

            role: "customer",

            action: "cancel",

            session,
          }),
        );

        tasks.push(
          this.updateReferralForBooking({
            entity: booking.vendorId,

            entityType: "vendor",

            role: "serviceProvider",

            action: "cancel",

            session,
          }),
        );

        await Promise.all(tasks);

        // ========================================================
        // NOTIFICATION OUTBOX
        // ========================================================

        await NotificationOutbox.create(
          [
            {
              eventType: "BOOKING_CANCELLED",

              bookingId: booking._id,

              userId: booking.userId,

              vendorId: booking.vendorId,

              payload: {
                formattedDate,

                requestId: requestId || null,
              },
            },
          ],
          {
            session,
          },
        );

        // ========================================================
        // TEST-ONLY ROLLBACK
        // ========================================================

        if (
          process.env.NODE_ENV === "development" &&
          process.env.ALLOW_BOOKING_ROLLBACK_TEST === "1" &&
          process.env.BOOKING_FAILURE_POINT === "after_cancellation_mutations"
        ) {
          throw new Error("BOOKING_TEST_INJECTED_CANCELLATION_FAILURE");
        }
      });

      // ==========================================================
      // CACHE INVALIDATION
      // ==========================================================

      const bookingDate = normalizeDateIST(booking.bookingDate);

      const cacheDate = bookingDate.toISOString().slice(0, 10);
      console.log("========== CACHE INVALIDATION ==========");
      console.log("Booking ID:", bookingId);
      console.log("Original bookingDate:", booking.bookingDate);
      console.log("Normalized bookingDate:", bookingDate);
      console.log("Cache date:", cacheDate);
      console.log("=========================================");
      try {
        await Promise.all([
          CacheService.invalidateTag("vendors"),

          CacheService.invalidateTag("availability"),

          CacheService.invalidateTag(`availability:${cacheDate}`),
        ]);
      } catch (error) {
        BookingLogger.error(
          {
            event: "CACHE_INVALIDATION_FAILED",

            bookingId,

            bookingDate: cacheDate,

            err: error,
          },

          "Failed to invalidate availability cache",
        );
      }

      // ==========================================================
      // RESPONSE
      // ==========================================================

      return {
        message: "Order Cancelled successfully",
      };
    } catch (error) {
      BookingLogger.error(
        {
          event: "BOOKING_CANCEL_FAILED",

          bookingId,

          entityType,

          bookingDate: booking?.bookingDate,

          userId: booking?.userId?._id,

          vendorId: booking?.vendorId?._id,

          error: error.message,

          stack: error.stack,
        },

        "Booking cancellation failed",
      );

      throw error;
    } finally {
      await session.endSession();
    }
  }

  static async markBookingCancelled(bookingId, session) {
    const result = await Bookings.updateOne(
      {
        _id: bookingId,
        cancelOrder: false,
        orderCompleted: false,
      },
      {
        $set: {
          cancelOrder: true,
          cancelTime: Date.now(),
        },
      },
      {
        session,
      },
    );

    if (result.modifiedCount !== 1) {
      throw ApiError.conflict("Booking was already cancelled or completed");
    }

    return true;
  }

  /**
   * Load booking for cancellation
   */
  static async loadBookingForCancel(bookingId, entityType, session) {
    let populateConfig;

    if (entityType === "user") {
      populateConfig = [
        { path: "userId", select: "name phoneNo cd shareBy" },
        {
          path: "vendorId",
          select: "name phoneNo cd shareBy commission fcmToken",
        },
      ];
    } else {
      populateConfig = [
        {
          path: "userId",
          model: "Vendor",
          select: "_id cd shareBy name phoneNo",
        },
        {
          path: "vendorId",
          select: "_id cd shareBy commission fcmToken phoneNo",
        },
      ];
    }

    const booking = await Bookings.findById(bookingId)
      .populate(populateConfig)
      .session(session)
      .lean();

    if (!booking) {
      throw ApiError.notFound("Booking not found");
    }

    return booking;
  }

  /**
   * Update accounting after user cancels booking
   *
   * Improvements:
   * - Parallel MongoDB updates
   * - Returns updated user
   * - No business logic changes
   */
  static async updateUserCancel(booking, session) {
    if (!booking.userId?._id || !booking.vendorId?._id) {
      throw ApiError.badRequest("Booking contains invalid user or vendor reference");
    }

    const [updatedUser, updatedVendor] = await Promise.all([
      User.findByIdAndUpdate(
        booking.userId._id,
        [
          {
            $set: {
              pending: {
                $max: [
                  0,
                  {
                    $subtract: [{ $ifNull: ["$pending", 0] }, 1],
                  },
                ],
              },

              canceled: {
                $add: [{ $ifNull: ["$canceled", 0] }, 1],
              },
            },
          },
        ],
        {
          new: true,
          session,
        },
      ),

      Vendor.findByIdAndUpdate(
        booking.vendorId._id,
        [
          {
            $set: {
              pendingVendor: {
                $max: [
                  0,
                  {
                    $subtract: [{ $ifNull: ["$pendingVendor", 0] }, 1],
                  },
                ],
              },

              canceledVendor: {
                $add: [{ $ifNull: ["$canceledVendor", 0] }, 1],
              },
            },
          },
        ],
        {
          new: true,
          session,
        },
      ),
    ]);

    if (!updatedUser || !updatedVendor) {
      throw ApiError.notFound("User or vendor not found while cancelling booking");
    }

    return updatedUser;
  }

  /**
   * Update accounting after vendor cancels booking
   *
   * Improvements:
   * - Parallel MongoDB updates
   * - Returns updated vendor user
   * - No business logic changes
   */
  static async updateVendorCancel(booking, session) {
    if (!booking.userId?._id || !booking.vendorId?._id) {
      throw ApiError.badRequest("Booking contains invalid vendor reference");
    }

    const [updatedVendorUser, updatedVendor] = await Promise.all([
      Vendor.findByIdAndUpdate(
        booking.userId._id,
        [
          {
            $set: {
              pending: {
                $max: [
                  0,
                  {
                    $subtract: [{ $ifNull: ["$pending", 0] }, 1],
                  },
                ],
              },

              canceled: {
                $add: [{ $ifNull: ["$canceled", 0] }, 1],
              },
            },
          },
        ],
        {
          new: true,
          session,
        },
      ),

      Vendor.findByIdAndUpdate(
        booking.vendorId._id,
        [
          {
            $set: {
              pendingVendor: {
                $max: [
                  0,
                  {
                    $subtract: [{ $ifNull: ["$pendingVendor", 0] }, 1],
                  },
                ],
              },

              canceledVendor: {
                $add: [{ $ifNull: ["$canceledVendor", 0] }, 1],
              },
            },
          },
        ],
        {
          new: true,
          session,
        },
      ),
    ]);

    if (!updatedVendorUser || !updatedVendor) {
      throw ApiError.notFound("Vendor not found while cancelling booking");
    }

    return updatedVendorUser;
  }

  static assertBookingCustomerOwnership(booking, authenticatedCustomerId) {
    if (!authenticatedCustomerId) {
      throw ApiError.unauthorized("Authentication required.");
    }

    const bookingCustomerId = booking?.userId?._id?.toString() || booking?.userId?.toString();

    if (!bookingCustomerId || bookingCustomerId !== String(authenticatedCustomerId)) {
      throw ApiError.forbidden("You are not authorized to access or modify this booking.");
    }
  }

  /**
   * Complete a booking (unified logic)
   *
   * Production Improvements:
   * - Uses withTransaction()
   * - No duplicate vendor query
   * - Parallel independent updates
   * - Structured logging
   * - Automatic transaction cleanup
   */
  static async completeBooking(bookingId, entityType, authenticatedCustomerId, requestId = null) {
    const session = await mongoose.startSession();

    let booking;
    let isSelfBooking = false;

    try {
      await session.withTransaction(async () => {
        booking = await this.loadBookingForComplete(bookingId, entityType, session);
        this.assertBookingCustomerOwnership(booking, authenticatedCustomerId);
        if (booking.cancelOrder) {
          throw ApiError.badRequest(
            "You can't mark this order as completed because it is cancelled",
          );
        }

        if (booking.orderCompleted) {
          throw ApiError.badRequest("This booking is already completed");
        }

        const bookingTime = new Date(booking.bookingDate).getTime();

        if (!Number.isFinite(bookingTime)) {
          throw ApiError.badRequest("Invalid booking date");
        }

        // if (Date.now() <= bookingTime) {
        //   throw ApiError.badRequest(
        //     `You can't mark this order as completed before ${booking.bookingDate}`,
        //   );
        // }

        isSelfBooking =
          entityType === "vendor" &&
          booking.userId?._id?.toString() === booking.vendorId?._id?.toString();

        /**
         * IMPORTANT:
         * Even self-bookings must transition to completed.
         */
        await this.markBookingCompleted(bookingId, session);

        /**
         * Self-booking has no normal accounting/referral completion.
         */
        if (isSelfBooking) {
          return;
        }

        const discountMultiplier = this.calculateDiscountMultiplier(
          booking.vendorId.totalDiscount,
          booking.vendorId.totalOriginalAmount,
        );

        const commission = Number(booking.vendorId.commission) || 0;

        await Promise.all([
          this.updateCompleteStats(booking, entityType, session),

          this.updateReferralForBooking({
            entity: booking.userId,
            entityType: entityType === "user" ? "user" : "vendor",
            role: "customer",
            action: "complete",
            commission,
            discountMultiplier,
            session,
          }),

          this.updateReferralForBooking({
            entity: booking.vendorId,
            entityType: "vendor",
            role: "serviceProvider",
            action: "complete",
            commission,
            discountMultiplier,
            session,
          }),
        ]);

        // TEST-ONLY failure injection.
        if (
          process.env.NODE_ENV === "development" &&
          process.env.ALLOW_BOOKING_ROLLBACK_TEST === "1" &&
          process.env.BOOKING_FAILURE_POINT === "after_completion_mutations"
        ) {
          throw new Error("BOOKING_TEST_INJECTED_COMPLETION_FAILURE");
        }
      });

      if (isSelfBooking) {
        return {
          message: "Self booking completed successfully",
        };
      }

      return {
        message: "Booking marked as completed successfully",
      };
    } catch (error) {
      BookingLogger.error(
        {
          event: "BOOKING_COMPLETE_FAILED",
          bookingId,
          entityType,
          userId: booking?.userId?._id,
          vendorId: booking?.vendorId?._id,
          error: error.message,
          code: error.code,
          stack: error.stack,
          requestId,
        },
        "Booking completion failed",
      );

      throw error;
    } finally {
      await session.endSession();
    }
  }

  static async markBookingCompleted(bookingId, session) {
    const result = await Bookings.updateOne(
      {
        _id: bookingId,
        cancelOrder: false,
        orderCompleted: false,
      },
      {
        $set: {
          orderCompleted: true,
        },
      },
      {
        session,
      },
    );

    if (result.modifiedCount !== 1) {
      throw ApiError.conflict("Booking was already completed or cancelled");
    }

    return true;
  }

  /**
   * Load booking for completion
   */
  static async loadBookingForComplete(bookingId, entityType, session) {
    const populateConfig =
      entityType === "user"
        ? [
            {
              path: "userId",
              select: "_id cd shareBy completed",
            },
            {
              path: "vendorId",
              select:
                "_id cd shareBy commission totalDiscount transactionCount totalOriginalAmount completedVendor",
            },
          ]
        : [
            {
              path: "userId",
              model: "Vendor",
              select: "_id cd shareBy completed",
            },
            {
              path: "vendorId",
              select: "_id cd shareBy commission totalDiscount transactionCount  completedVendor",
            },
          ];

    const booking = await Bookings.findById(bookingId)
      .populate(populateConfig)
      .session(session)
      .lean();

    if (!booking) {
      throw ApiError.notFound("Booking not found");
    }

    return booking;
  }

  /**
   * Update completion statistics
   */
  static async updateCompleteStats(booking, entityType, session) {
    const CustomerModel = entityType === "user" ? User : Vendor;

    const [updatedCustomer, updatedVendor] = await Promise.all([
      CustomerModel.findByIdAndUpdate(
        booking.userId._id,
        [
          {
            $set: {
              pending: {
                $max: [
                  0,
                  {
                    $subtract: [{ $ifNull: ["$pending", 0] }, 1],
                  },
                ],
              },

              completed: {
                $add: [{ $ifNull: ["$completed", 0] }, 1],
              },
            },
          },
        ],
        {
          new: true,
          session,
        },
      ),

      Vendor.findByIdAndUpdate(
        booking.vendorId._id,
        [
          {
            $set: {
              pendingVendor: {
                $max: [
                  0,
                  {
                    $subtract: [
                      {
                        $ifNull: ["$pendingVendor", 0],
                      },
                      1,
                    ],
                  },
                ],
              },

              completedVendor: {
                $add: [
                  {
                    $ifNull: ["$completedVendor", 0],
                  },
                  1,
                ],
              },
            },
          },
        ],
        {
          new: true,
          session,
        },
      ),
    ]);

    if (!updatedCustomer || !updatedVendor) {
      throw ApiError.notFound("Booking participant not found during completion");
    }
  }
  /**
   * Update referral statistics.
   *
   * entity MUST already be loaded by caller.
   *
   * Referral updates participate in the booking transaction.
   * If a referral update fails, the error is rethrown so the
   * transaction rolls back and partially inconsistent booking /
   * accounting / referral state cannot be committed.
   */
  /**
   * Update referral counters/reward for a booking lifecycle event.
   *
   * Business rules:
   *
   * 1. entity.shareBy
   *    = ID of the account that referred/shared to this entity.
   *
   * 2. entity.cd
   *    = account type of entity.shareBy:
   *        "user"   -> referrer exists in User collection
   *        "vendor" -> referrer exists in Vendor collection
   *
   * 3. role
   *    = role played by `entity` in THIS booking:
   *
   *        "customer"
   *          Uses:
   *            pending
   *            completed
   *            canceled
   *
   *        "serviceProvider"
   *          Uses:
   *            pendingVendor
   *            completedVendor
   *            canceledVendor
   *
   * 4. Referral reward starts after the configured completed-order
   *    threshold.
   *
   * 5. Reward:
   *        booked vendor commission × 5% × discountMultiplier
   *
   * 6. Reward goes to referrer's `earning`, NOT `balance`.
   */
  static async updateReferralForBooking({
    entity,
    entityType,
    role,
    action,
    commission = 0,
    discountMultiplier = 1,
    session = null,
  }) {
    /**
     * No referrer -> nothing to update.
     */
    if (!entity?.shareBy) {
      return {
        updated: false,
        rewarded: false,
        reason: "NO_REFERRER",
      };
    }

    /**
     * Validate entity type.
     *
     * entityType describes WHAT the referred account is.
     */
    if (!["user", "vendor"].includes(entityType)) {
      throw ApiError.badRequest(`Invalid referral entityType: ${entityType}`);
    }

    /**
     * Validate booking role.
     *
     * role describes HOW the referred account participated
     * in this particular booking.
     */
    if (!["customer", "serviceProvider"].includes(role)) {
      throw ApiError.badRequest(`Invalid referral role: ${role}`);
    }

    /**
     * Only Vendor accounts can be service providers.
     */
    if (role === "serviceProvider" && entityType !== "vendor") {
      throw ApiError.badRequest("Only a vendor can have the serviceProvider referral role");
    }

    /**
     * Validate action.
     */
    if (!["pending", "cancel", "complete"].includes(action)) {
      throw ApiError.badRequest(`Invalid referral action: ${action}`);
    }

    /**
     * entity.cd tells us WHICH MODEL contains the referrer.
     *
     * IMPORTANT:
     * This is NOT the type of `entity`.
     * It is the type of entity.shareBy.
     */
    let referrerModel;

    if (entity.cd === "user") {
      referrerModel = User;
    } else if (entity.cd === "vendor") {
      referrerModel = Vendor;
    } else {
      BookingLogger.warn(
        {
          event: "BOOKING_REFERRAL_INVALID_REFERRER_TYPE",

          entityId: entity?._id?.toString(),
          entityType,
          role,

          shareBy: entity?.shareBy?.toString(),
          cd: entity?.cd,

          action,
        },
        "Referral skipped because referrer account type is invalid",
      );

      return {
        updated: false,
        rewarded: false,
        reason: "INVALID_REFERRER_TYPE",
      };
    }

    /**
     * Determine which counters belong to this booking role.
     *
     * Customer:
     *   pending
     *   completed
     *   canceled
     *
     * Service Provider:
     *   pendingVendor
     *   completedVendor
     *   canceledVendor
     */
    const counters =
      role === "customer"
        ? {
            pending: "pending",
            completed: "completed",
            canceled: "canceled",
          }
        : {
            pending: "pendingVendor",
            completed: "completedVendor",
            canceled: "canceledVendor",
          };

    const updateOptions = session ? { session } : {};

    try {
      /**
       * ============================================================
       * PENDING
       * ============================================================
       *
       * A new booking has been created involving the referred
       * account in the supplied role.
       *
       * The referrer's pendingShareBy increases once.
       */
      if (action === "pending") {
        const result = await referrerModel.updateOne(
          {
            _id: entity.shareBy,
          },
          {
            $inc: {
              pendingShareBy: 1,
            },
          },
          updateOptions,
        );

        if (result.matchedCount !== 1) {
          throw ApiError.notFound(`Referral referrer not found: ${entity.shareBy}`);
        }

        BookingLogger.debug(
          {
            event: "BOOKING_REFERRAL_PENDING_UPDATED",

            entityId: entity?._id?.toString(),
            entityType,
            role,

            referrerId: entity.shareBy?.toString(),
            referrerType: entity.cd,

            counter: counters.pending,
          },
          "Referral pending counter updated",
        );

        return {
          updated: true,
          rewarded: false,
          action,
          role,
        };
      }

      /**
       * ============================================================
       * CANCEL
       * ============================================================
       *
       * Referrer:
       *
       * pendingShareBy  -1 (floor 0)
       * canceledShareBy +1
       *
       * No earning is credited.
       */
      if (action === "cancel") {
        const result = await referrerModel.updateOne(
          {
            _id: entity.shareBy,
          },
          [
            {
              $set: {
                pendingShareBy: {
                  $max: [
                    0,
                    {
                      $subtract: [
                        {
                          $ifNull: ["$pendingShareBy", 0],
                        },
                        1,
                      ],
                    },
                  ],
                },

                canceledShareBy: {
                  $add: [
                    {
                      $ifNull: ["$canceledShareBy", 0],
                    },
                    1,
                  ],
                },
              },
            },
          ],
          updateOptions,
        );

        if (result.matchedCount !== 1) {
          throw ApiError.notFound(`Referral referrer not found: ${entity.shareBy}`);
        }

        BookingLogger.debug(
          {
            event: "BOOKING_REFERRAL_CANCEL_UPDATED",

            entityId: entity?._id?.toString(),
            entityType,
            role,

            referrerId: entity.shareBy?.toString(),
            referrerType: entity.cd,

            counter: counters.canceled,
          },
          "Referral cancellation counter updated",
        );

        return {
          updated: true,
          rewarded: false,
          action,
          role,
        };
      }

      /**
       * ============================================================
       * COMPLETE
       * ============================================================
       */

      /**
       * Select completed counter according to ROLE.
       *
       * Customer:
       *     entity.completed
       *
       * Service provider:
       *     entity.completedVendor
       */
      const completedBefore = Number(entity[counters.completed] || 0);

      /**
       * BUSINESS RULE
       *
       * With >= 5:
       *
       * entity already completed 5 qualifying orders before this
       * completion -> this completion receives referral reward.
       *
       * In other words, reward begins on the NEXT order after
       * five completed orders.
       *
       * If you want the 5th completion itself to earn the reward,
       * this threshold calculation needs to be changed.
       */
      const shouldReward = completedBefore >= 5;

      const normalizedCommission = Number(commission) || 0;

      const normalizedMultiplier = Number(discountMultiplier) || 0;

      const referralEarning = shouldReward ? normalizedCommission * 0.05 * normalizedMultiplier : 0;

      /**
       * Protect against invalid/negative monetary calculations.
       */
      if (!Number.isFinite(referralEarning) || referralEarning < 0) {
        throw ApiError.internal("Invalid referral earning calculation", {
          commission,
          discountMultiplier,
          referralEarning,
        });
      }

      /**
       * Update referrer atomically.
       *
       * pendingShareBy:
       *      -1, but never below zero
       *
       * completedShareBy:
       *      +1
       *
       * earning:
       *      +5% commission when eligible
       *
       * IMPORTANT:
       * balance is intentionally NOT modified.
       */
      const result = await referrerModel.updateOne(
        {
          _id: entity.shareBy,
        },
        [
          {
            $set: {
              pendingShareBy: {
                $max: [
                  0,
                  {
                    $subtract: [
                      {
                        $ifNull: ["$pendingShareBy", 0],
                      },
                      1,
                    ],
                  },
                ],
              },

              completedShareBy: {
                $add: [
                  {
                    $ifNull: ["$completedShareBy", 0],
                  },
                  1,
                ],
              },

              earning: {
                $add: [
                  {
                    $ifNull: ["$earning", 0],
                  },
                  referralEarning,
                ],
              },
            },
          },
        ],
        updateOptions,
      );

      if (result.matchedCount !== 1) {
        throw ApiError.notFound(`Referral referrer not found: ${entity.shareBy}`);
      }

      BookingLogger.info(
        {
          event: "BOOKING_REFERRAL_COMPLETED",

          entityId: entity?._id?.toString(),
          entityType,
          role,

          referrerId: entity.shareBy?.toString(),
          referrerType: entity.cd,

          completedCounter: counters.completed,
          completedBefore,

          shouldReward,

          commission: normalizedCommission,
          discountMultiplier: normalizedMultiplier,

          referralEarning,
        },
        "Referral completion processed",
      );

      return {
        updated: true,
        rewarded: shouldReward && referralEarning > 0,

        action,
        role,

        completedCounter: counters.completed,
        completedBefore,

        referralEarning,
      };
    } catch (error) {
      BookingLogger.error(
        {
          event: "BOOKING_REFERRAL_UPDATE_FAILED",

          entityId: entity?._id?.toString(),
          entityType,
          role,

          shareBy: entity?.shareBy?.toString(),
          referrerType: entity?.cd,

          action,

          commission,
          discountMultiplier,

          error: error.message,
          stack: error.stack,
        },
        "Referral update failed",
      );

      /**
       * Referral/accounting operations are part of the booking
       * transaction, so failure must abort the transaction.
       */
      throw error;
    }
  }

  /**
   * Update vendor rating
   *
   * Production Improvements:
   * - MongoDB aggregation
   * - Constant memory usage
   * - Faster for large datasets
   */
  static async updateVendorRating(vendorId, session) {
    const [result] = await Bookings.aggregate([
      {
        $match: {
          vendorId: new mongoose.Types.ObjectId(vendorId),
          rating: { $gt: 0 },
        },
      },
      {
        $group: {
          _id: null,
          ratingCount: { $sum: 1 },
          averageRating: { $avg: "$rating" },
        },
      },
    ]).session(session);

    const ratingCount = result?.ratingCount || 0;

    const averageRating = result ? Math.round(result.averageRating * 100) / 100 : 0;

    await Vendor.updateOne(
      {
        _id: vendorId,
      },
      {
        rating: averageRating,
        ratingCount,
      },
      {
        session,
      },
    );
  }

  /**
   * Validate rating permission
   */
  static validateRatingPermission(booking) {
    const validatedBookingRatingPermission =
      Date.now() > new Date(booking.bookingDate).getTime() + 5 * 60 * 60 * 1000;

    if (booking.cancelOrder) {
      throw ApiError.badRequest("Cancelled bookings cannot be rated");
    }

    if (!booking.orderCompleted) {
      throw ApiError.badRequest("Booking must be completed before rating");
    }

    // if (!validatedBookingRatingPermission) {
    //   throw ApiError.badRequest("You can only rate a booking after 5 hours of completion");
    // }

    if (Number(booking.rating || 0) > 0) {
      throw ApiError.conflict("Booking has already been rated");
    }
  }
}

module.exports = BookingService;
