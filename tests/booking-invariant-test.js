"use strict";

/**
 * ============================================================
 * BOOKING TRANSACTION INVARIANT / CONCURRENCY TEST
 * ============================================================
 *
 * Purpose:
 *
 * Fire many concurrent requests for the SAME:
 *
 *   vendorId + bookingDate
 *
 * and verify that the entire business transaction executes
 * exactly once.
 *
 * Expected:
 *
 * HTTP
 *   1 x 201
 *   N-1 x 409
 *
 * Booking
 *   active booking count +1
 *
 * Booking vendor-user
 *   balance      -customerCharge
 *   bookingCount +1
 *   pending      +1
 *
 * Target vendor
 *   balance            -vendorCharge
 *   pendingVendor       +1
 *   bookingCountVendor  +1
 *
 * Referrer (when applicable)
 *   pendingShareBy +1
 *
 * Notification
 *   exactly one booking-created vendor SMS notification
 *
 * ============================================================
 *
 * IMPORTANT
 *
 * Run this against DEV/TEST data only.
 *
 * The bookingDate MUST NOT already have an active booking
 * for the target vendor.
 * ============================================================
 */

const mongoose = require("mongoose");
const axios = require("axios");

require("dotenv").config();

/**
 * ------------------------------------------------------------
 * UPDATE THESE MODEL PATHS IF YOUR PROJECT USES DIFFERENT PATHS
 * ------------------------------------------------------------
 */

const Vendor = require("../models/vendor");
const Bookings = require("../models/bookings");
const Notification = require("../models/notification");

/**
 * ============================================================
 * TEST CONFIGURATION
 * ============================================================
 */

const API_URL =
  process.env.BOOKING_TEST_URL || "http://localhost:3000/api/bookings/postToBookingsV";

const CONCURRENT_REQUESTS = Math.max(2, Number(process.env.BOOKING_TEST_CONCURRENCY) || 100);

/**
 * Vendor who is MAKING the booking.
 *
 * This corresponds to vendorUser in:
 *
 * updateAccountingForVendorBooking()
 */
const BOOKING_VENDOR_USER_ID =
  process.env.TEST_BOOKING_VENDOR_USER_ID || "6a6b454ca0f0a22fa1ccc598";

/**
 * Vendor being booked.
 */
const TARGET_VENDOR_ID = process.env.TEST_TARGET_VENDOR_ID || "6a6878a6698f59feb3e20066";

/**
 * Must be a fresh date for this target vendor.
 *
 * Your application currently uses:
 *
 * Mon Aug 03 2026
 */
const BOOKING_DATE = process.env.TEST_BOOKING_DATE || "Mon Aug 10 2026";

const BOOKING_TYPE = process.env.TEST_BOOKING_TYPE || "labour";

const PINCODE = process.env.TEST_BOOKING_PINCODE || "274201";

/**
 * Add your auth token if the endpoint requires authentication.
 */
const AUTH_TOKEN =
  process.env.TEST_AUTH_TOKEN ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJwaG9uZU5vIjo4Mjk5NDAwNTIwLCJ2ZW5kb3JJZCI6IjZhNmI0NTRjYTBmMGEyMmZhMWNjYzU5OCIsInR5cGUiOiJtaWxrIG1hbiIsImlhdCI6MTc4NTQxNTE0OCwiZXhwIjoxNzg1Njc0MzQ4fQ.-94lmShKK6y6Wy7IsgZdeY1byIEWeLj_EtTTMX2RC4U";
/**
 * Your endpoint may derive userId from authentication.
 *
 * If your controller expects it in the body, leave this here.
 */
const REQUEST_BODY = {
  userId: BOOKING_VENDOR_USER_ID,

  vendorId: TARGET_VENDOR_ID,

  bookingDate: BOOKING_DATE,

  type: BOOKING_TYPE,

  pincode: PINCODE,

  isSelfBooking: false,
};

/**
 * ============================================================
 * HELPERS
 * ============================================================
 */

function assertConfigured(value, name) {
  if (!value || String(value).startsWith("PUT_")) {
    throw new Error(`${name} is not configured`);
  }
}

function number(value) {
  return Number(value || 0);
}

function delta(before, after) {
  return number(after) - number(before);
}

function approximatelyEqual(a, b, epsilon = 0.000001) {
  return Math.abs(number(a) - number(b)) <= epsilon;
}

function passFail(condition) {
  return condition ? "PASS" : "FAIL";
}

function printSection(title) {
  console.log("");
  console.log("========================================");
  console.log(title);
  console.log("========================================");
}

function printAssertion({ name, before, after, expectedDelta, actualDelta, pass }) {
  console.log(`${pass ? "PASS" : "FAIL"} | ${name}`);

  if (before !== undefined) {
    console.log(`       before: ${before}`);
  }

  if (after !== undefined) {
    console.log(`       after:  ${after}`);
  }

  if (expectedDelta !== undefined) {
    console.log(`       expected delta: ${expectedDelta}`);
  }

  if (actualDelta !== undefined) {
    console.log(`       actual delta:   ${actualDelta}`);
  }
}

/**
 * ============================================================
 * DATABASE STATE
 * ============================================================
 */

async function getState() {
  const [bookingVendorUser, targetVendor, activeBookingCount] = await Promise.all([
    Vendor.findById(BOOKING_VENDOR_USER_ID)
      .select(
        [
          "balance",
          "bookingCount",
          "pending",
          "shareBy",
          "cd",
          "commission",
          "completed",
          "completedVendor",
        ].join(" "),
      )
      .lean(),

    Vendor.findById(TARGET_VENDOR_ID)
      .select(["balance", "pendingVendor", "bookingCountVendor", "commission"].join(" "))
      .lean(),

    Bookings.countDocuments({
      vendorId: new mongoose.Types.ObjectId(TARGET_VENDOR_ID),

      bookingDate: BOOKING_DATE,

      cancelOrder: false,
      orderCompleted: false,
    }),
  ]);

  if (!bookingVendorUser) {
    throw new Error(`Booking vendor-user not found: ${BOOKING_VENDOR_USER_ID}`);
  }

  if (!targetVendor) {
    throw new Error(`Target vendor not found: ${TARGET_VENDOR_ID}`);
  }

  /**
   * ----------------------------------------------------------
   * REFERRER
   * ----------------------------------------------------------
   */

  let referrer = null;

  if (bookingVendorUser.shareBy && bookingVendorUser.cd === "vendor") {
    referrer = await Vendor.findById(bookingVendorUser.shareBy)
      .select("pendingShareBy completedShareBy canceledShareBy earning")
      .lean();
  }

  return {
    bookingVendorUser,
    targetVendor,
    activeBookingCount,
    referrer,
  };
}

/**
 * ============================================================
 * SEND ONE REQUEST
 * ============================================================
 */

async function sendBookingRequest(index) {
  const start = Date.now();

  const requestId = `invariant-test-${Date.now()}-${index}`;

  try {
    const response = await axios.post(
      API_URL,

      {
        ...REQUEST_BODY,
        requestId,
      },

      {
        headers: {
          "Content-Type": "application/json",

          ...(AUTH_TOKEN
            ? {
                Authorization: `Bearer ${AUTH_TOKEN}`,
              }
            : {}),

          "x-request-id": requestId,
        },

        validateStatus: () => true,

        timeout: 15000,
      },
    );

    return {
      request: index,
      status: response.status,
      durationMs: Date.now() - start,
      data: response.data,
    };
  } catch (error) {
    return {
      request: index,
      status: "NETWORK_ERROR",
      durationMs: Date.now() - start,
      error: error.message,
    };
  }
}

/**
 * ============================================================
 * FIND CREATED BOOKING
 * ============================================================
 */

async function getCreatedBooking() {
  return Bookings.findOne({
    vendorId: new mongoose.Types.ObjectId(TARGET_VENDOR_ID),

    bookingDate: BOOKING_DATE,

    cancelOrder: false,
    orderCompleted: false,
  })
    .sort({
      bookedOn: -1,
    })
    .lean();
}

/**
 * ============================================================
 * NOTIFICATION CHECK
 * ============================================================
 */

async function getNotificationState(bookingId) {
  if (!bookingId) {
    return {
      count: 0,
      notifications: [],
    };
  }

  const idempotencyKey = `booking:${bookingId}:created:vendor:sms`;

  const notifications = await Notification.find({
    idempotencyKey,
  })
    .select("_id idempotencyKey status attempts type template")
    .lean();

  return {
    idempotencyKey,
    count: notifications.length,
    notifications,
  };
}

/**
 * ============================================================
 * MAIN TEST
 * ============================================================
 */

async function run() {
  let exitCode = 1;

  try {
    assertConfigured(BOOKING_VENDOR_USER_ID, "TEST_BOOKING_VENDOR_USER_ID");

    assertConfigured(TARGET_VENDOR_ID, "TEST_TARGET_VENDOR_ID");

    if (!mongoose.isValidObjectId(BOOKING_VENDOR_USER_ID)) {
      throw new Error("TEST_BOOKING_VENDOR_USER_ID is not a valid ObjectId");
    }

    if (!mongoose.isValidObjectId(TARGET_VENDOR_ID)) {
      throw new Error("TEST_TARGET_VENDOR_ID is not a valid ObjectId");
    }

    if (!process.env.MONGODB_URL_1) {
      throw new Error("MONGODB_URL_1 is required");
    }

    printSection("BOOKING TRANSACTION INVARIANT TEST");

    console.log(`API: ${API_URL}`);

    console.log(`Concurrency: ${CONCURRENT_REQUESTS}`);

    console.log(`Booking vendor-user: ${BOOKING_VENDOR_USER_ID}`);

    console.log(`Target vendor: ${TARGET_VENDOR_ID}`);

    console.log(`Booking date: ${BOOKING_DATE}`);

    /**
     * --------------------------------------------------------
     * CONNECT DATABASE
     * --------------------------------------------------------
     */

    await mongoose.connect(process.env.MONGODB_URL_1);

    console.log("MongoDB connected.");

    /**
     * --------------------------------------------------------
     * BEFORE STATE
     * --------------------------------------------------------
     */

    const before = await getState();

    if (before.activeBookingCount !== 0) {
      throw new Error(
        [
          "TEST ABORTED.",
          "",
          `Target vendor already has ${before.activeBookingCount}`,
          `active booking(s) for ${BOOKING_DATE}.`,
          "",
          "Use a fresh booking date before running this test.",
        ].join(" "),
      );
    }

    printSection("BEFORE");

    console.log({
      activeBookings: before.activeBookingCount,

      bookingVendorUser: {
        balance: before.bookingVendorUser.balance,

        bookingCount: before.bookingVendorUser.bookingCount,

        pending: before.bookingVendorUser.pending,

        shareBy: before.bookingVendorUser.shareBy || null,

        cd: before.bookingVendorUser.cd || null,
      },

      targetVendor: {
        balance: before.targetVendor.balance,

        pendingVendor: before.targetVendor.pendingVendor,

        bookingCountVendor: before.targetVendor.bookingCountVendor,
      },

      referrer: before.referrer
        ? {
            pendingShareBy: before.referrer.pendingShareBy,
          }
        : null,
    });

    /**
     * --------------------------------------------------------
     * FIRE CONCURRENT REQUESTS
     * --------------------------------------------------------
     */

    printSection("SENDING CONCURRENT REQUESTS");

    const testStart = Date.now();

    const requests = Array.from(
      {
        length: CONCURRENT_REQUESTS,
      },
      (_, index) => sendBookingRequest(index + 1),
    );

    const results = await Promise.all(requests);

    const durationMs = Date.now() - testStart;

    console.table(
      results.map((result) => ({
        request: result.request,

        status: result.status,

        durationMs: result.durationMs,
      })),
    );

    /**
     * Give post-commit notification enqueueing/worker a
     * moment to persist state.
     *
     * The booking/accounting assertions do not depend on this.
     */
    await new Promise((resolve) => setTimeout(resolve, 1500));

    /**
     * --------------------------------------------------------
     * AFTER STATE
     * --------------------------------------------------------
     */

    const after = await getState();

    const createdBooking = await getCreatedBooking();

    const notificationState = await getNotificationState(createdBooking?._id?.toString());

    /**
     * --------------------------------------------------------
     * HTTP ASSERTIONS
     * --------------------------------------------------------
     */

    const successCount = results.filter((result) => result.status === 201).length;

    const conflictCount = results.filter((result) => result.status === 409).length;

    const unexpected = results.filter((result) => result.status !== 201 && result.status !== 409);

    /**
     * --------------------------------------------------------
     * CALCULATE ACTUAL DELTAS
     * --------------------------------------------------------
     */

    const bookingDelta = after.activeBookingCount - before.activeBookingCount;

    const vendorUserBalanceDelta = delta(
      before.bookingVendorUser.balance,

      after.bookingVendorUser.balance,
    );

    const vendorUserBookingCountDelta = delta(
      before.bookingVendorUser.bookingCount,

      after.bookingVendorUser.bookingCount,
    );

    const vendorUserPendingDelta = delta(
      before.bookingVendorUser.pending,

      after.bookingVendorUser.pending,
    );

    const targetBalanceDelta = delta(before.targetVendor.balance, after.targetVendor.balance);

    const pendingVendorDelta = delta(
      before.targetVendor.pendingVendor,

      after.targetVendor.pendingVendor,
    );

    const bookingCountVendorDelta = delta(
      before.targetVendor.bookingCountVendor,

      after.targetVendor.bookingCountVendor,
    );

    let referralDelta = null;

    if (before.referrer && after.referrer) {
      referralDelta = delta(
        before.referrer.pendingShareBy,

        after.referrer.pendingShareBy,
      );
    }

    /**
     * --------------------------------------------------------
     * DETERMINE CHARGES FROM ACTUAL BALANCE DELTAS
     * --------------------------------------------------------
     *
     * This test does not duplicate your
     * calculateBookingCharges() business logic.
     *
     * Instead it verifies:
     *
     * - only one balance mutation occurred
     * - counters changed exactly once
     *
     * For exact expected charge verification, optionally set:
     *
     * TEST_EXPECTED_CUSTOMER_CHARGE
     * TEST_EXPECTED_VENDOR_CHARGE
     */

    const expectedCustomerCharge =
      process.env.TEST_EXPECTED_CUSTOMER_CHARGE !== undefined
        ? Number(process.env.TEST_EXPECTED_CUSTOMER_CHARGE)
        : null;

    const expectedVendorCharge =
      process.env.TEST_EXPECTED_VENDOR_CHARGE !== undefined
        ? Number(process.env.TEST_EXPECTED_VENDOR_CHARGE)
        : null;

    /**
     * --------------------------------------------------------
     * ASSERTIONS
     * --------------------------------------------------------
     */

    const assertions = [];

    assertions.push({
      name: "Exactly one HTTP booking succeeded",

      pass: successCount === 1,
    });

    assertions.push({
      name: "All competing requests returned 409",

      pass: conflictCount === CONCURRENT_REQUESTS - 1,
    });

    assertions.push({
      name: "No unexpected HTTP/network responses",

      pass: unexpected.length === 0,
    });

    assertions.push({
      name: "Exactly one active booking created",

      before: before.activeBookingCount,

      after: after.activeBookingCount,

      expectedDelta: 1,

      actualDelta: bookingDelta,

      pass: bookingDelta === 1,
    });

    assertions.push({
      name: "Booking vendor-user bookingCount incremented once",

      before: before.bookingVendorUser.bookingCount,

      after: after.bookingVendorUser.bookingCount,

      expectedDelta: 1,

      actualDelta: vendorUserBookingCountDelta,

      pass: vendorUserBookingCountDelta === 1,
    });

    assertions.push({
      name: "Booking vendor-user pending incremented once",

      before: before.bookingVendorUser.pending,

      after: after.bookingVendorUser.pending,

      expectedDelta: 1,

      actualDelta: vendorUserPendingDelta,

      pass: vendorUserPendingDelta === 1,
    });

    assertions.push({
      name: "Target vendor pendingVendor incremented once",

      before: before.targetVendor.pendingVendor,

      after: after.targetVendor.pendingVendor,

      expectedDelta: 1,

      actualDelta: pendingVendorDelta,

      pass: pendingVendorDelta === 1,
    });

    assertions.push({
      name: "Target vendor bookingCountVendor incremented once",

      before: before.targetVendor.bookingCountVendor,

      after: after.targetVendor.bookingCountVendor,

      expectedDelta: 1,

      actualDelta: bookingCountVendorDelta,

      pass: bookingCountVendorDelta === 1,
    });

    /**
     * Balance must decrease.
     */
    assertions.push({
      name: "Booking vendor-user balance deducted",

      before: before.bookingVendorUser.balance,

      after: after.bookingVendorUser.balance,

      actualDelta: vendorUserBalanceDelta,

      pass: vendorUserBalanceDelta < 0,
    });

    assertions.push({
      name: "Target vendor balance deducted",

      before: before.targetVendor.balance,

      after: after.targetVendor.balance,

      actualDelta: targetBalanceDelta,

      pass: targetBalanceDelta < 0,
    });

    /**
     * Optional exact-charge assertions.
     */
    if (expectedCustomerCharge !== null) {
      assertions.push({
        name: "Customer charge deducted exactly once",

        expectedDelta: -expectedCustomerCharge,

        actualDelta: vendorUserBalanceDelta,

        pass: approximatelyEqual(vendorUserBalanceDelta, -expectedCustomerCharge),
      });
    }

    if (expectedVendorCharge !== null) {
      assertions.push({
        name: "Vendor charge deducted exactly once",

        expectedDelta: -expectedVendorCharge,

        actualDelta: targetBalanceDelta,

        pass: approximatelyEqual(targetBalanceDelta, -expectedVendorCharge),
      });
    }

    /**
     * Referral assertion only when a valid referrer exists.
     */
    if (before.referrer) {
      assertions.push({
        name: "Referrer pendingShareBy incremented once",

        before: before.referrer.pendingShareBy,

        after: after.referrer?.pendingShareBy,

        expectedDelta: 1,

        actualDelta: referralDelta,

        pass: referralDelta === 1,
      });
    }

    /**
     * Notification business-idempotency assertion.
     */
    assertions.push({
      name: "Exactly one booking-created notification exists",

      expectedDelta: 1,

      actualDelta: notificationState.count,

      pass: notificationState.count === 1,
    });

    /**
     * --------------------------------------------------------
     * REPORT
     * --------------------------------------------------------
     */

    printSection("INVARIANT ASSERTIONS");

    for (const assertion of assertions) {
      printAssertion(assertion);
    }

    printSection("FINAL STATE");

    console.log({
      bookingId: createdBooking?._id || null,

      bookingVendorUser: {
        balance: after.bookingVendorUser.balance,

        balanceDelta: vendorUserBalanceDelta,

        bookingCount: after.bookingVendorUser.bookingCount,

        bookingCountDelta: vendorUserBookingCountDelta,

        pending: after.bookingVendorUser.pending,

        pendingDelta: vendorUserPendingDelta,
      },

      targetVendor: {
        balance: after.targetVendor.balance,

        balanceDelta: targetBalanceDelta,

        pendingVendor: after.targetVendor.pendingVendor,

        pendingVendorDelta,

        bookingCountVendor: after.targetVendor.bookingCountVendor,

        bookingCountVendorDelta,
      },

      referral: before.referrer
        ? {
            pendingShareBy: after.referrer?.pendingShareBy,

            pendingShareByDelta: referralDelta,
          }
        : "NOT_APPLICABLE",

      notification: {
        idempotencyKey: notificationState.idempotencyKey,

        count: notificationState.count,

        records: notificationState.notifications,
      },
    });

    printSection("TEST SUMMARY");

    console.log(`Total requests: ${CONCURRENT_REQUESTS}`);

    console.log(`Successful bookings: ${successCount}`);

    console.log(`409 conflicts: ${conflictCount}`);

    console.log(`Unexpected responses: ${unexpected.length}`);

    console.log(`Total request duration: ${durationMs}ms`);

    const failedAssertions = assertions.filter((assertion) => !assertion.pass);

    if (failedAssertions.length === 0) {
      console.log("");
      console.log("========================================");

      console.log("PASS: ALL BOOKING TRANSACTION INVARIANTS PASSED");

      console.log("========================================");

      exitCode = 0;
    } else {
      console.log("");
      console.log("========================================");

      console.log(`FAIL: ${failedAssertions.length} INVARIANT(S) FAILED`);

      console.log("========================================");

      for (const failure of failedAssertions) {
        console.log(`- ${failure.name}`);
      }

      exitCode = 1;
    }
  } catch (error) {
    printSection("TEST FAILED");

    console.error(error);

    exitCode = 1;
  } finally {
    try {
      await mongoose.disconnect();
    } catch {
      // Ignore shutdown error.
    }

    process.exitCode = exitCode;
  }
}

run();
