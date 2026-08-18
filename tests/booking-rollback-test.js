"use strict";

/**
 * ============================================================
 * BOOKING TRANSACTION ROLLBACK TEST
 * ============================================================
 *
 * PURPOSE
 *
 * Verify that a failure during accounting rolls back ALL
 * booking transaction mutations.
 *
 * Test setup:
 *
 * Booking vendor-user:
 *   balance must be sufficient for customerCharge
 *
 * Target vendor:
 *   balance is temporarily forced to 0 so that:
 *
 *     balance: { $gte: vendorCharge }
 *
 *   fails inside updateAccountingForVendorBooking().
 *
 * Expected result:
 *
 *   HTTP 402 (or your configured payment-required status)
 *
 * AND:
 *
 *   active booking count             unchanged
 *   vendorUser.balance               unchanged
 *   vendorUser.bookingCount          unchanged
 *   vendorUser.pending               unchanged
 *   targetVendor.pendingVendor       unchanged
 *   targetVendor.bookingCountVendor  unchanged
 *   referral.pendingShareBy          unchanged
 *   booking notification count       unchanged
 *
 * Finally:
 *
 *   target vendor's original balance is restored.
 *
 * IMPORTANT:
 * Run against DEV/TEST data only.
 * ============================================================
 */

require("dotenv").config();

const axios = require("axios");
const mongoose = require("mongoose");

const Vendor = require("../models/vendor");
const Bookings = require("../models/bookings");
const Notification = require("../models/notification");

/**
 * ============================================================
 * CONFIG
 * ============================================================
 */

const API_URL =
  process.env.BOOKING_TEST_URL || "http://localhost:3000/api/bookings/postToBookingsV";

const BOOKING_VENDOR_USER_ID = process.env.TEST_BOOKING_VENDOR_USER_ID || "PUT_VENDOR_USER_ID_HERE";

const TARGET_VENDOR_ID = process.env.TEST_TARGET_VENDOR_ID || "PUT_TARGET_VENDOR_ID_HERE";

/**
 * IMPORTANT:
 *
 * Use a fresh date with no existing active booking.
 */
const BOOKING_DATE = process.env.TEST_ROLLBACK_BOOKING_DATE || "Tue Aug 11 2026";

const BOOKING_TYPE = process.env.TEST_BOOKING_TYPE || "labour";

const PINCODE = process.env.TEST_BOOKING_PINCODE || "274201";

const AUTH_TOKEN = process.env.TEST_AUTH_TOKEN ||  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJwaG9uZU5vIjo4Mjk5NDAwNTIwLCJ2ZW5kb3JJZCI6IjZhNmI0NTRjYTBmMGEyMmZhMWNjYzU5OCIsInR5cGUiOiJtaWxrIG1hbiIsImlhdCI6MTc4NTQxNTE0OCwiZXhwIjoxNzg1Njc0MzQ4fQ.-94lmShKK6y6Wy7IsgZdeY1byIEWeLj_EtTTMX2RC4U";

/**
 * We deliberately force target vendor balance to this value.
 *
 * It should be lower than vendorCharge.
 */
const FORCED_TARGET_BALANCE = 0;

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

function num(value) {
  return Number(value || 0);
}

function delta(before, after) {
  return num(after) - num(before);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printSection(title) {
  console.log("");
  console.log("========================================");
  console.log(title);
  console.log("========================================");
}

function assertion(name, condition, details = {}) {
  return {
    name,
    pass: Boolean(condition),
    ...details,
  };
}

function printAssertion(result) {
  console.log(`${result.pass ? "PASS" : "FAIL"} | ${result.name}`);

  if (result.before !== undefined) {
    console.log(`       before: ${result.before}`);
  }

  if (result.after !== undefined) {
    console.log(`       after:  ${result.after}`);
  }

  if (result.expected !== undefined) {
    console.log(`       expected: ${result.expected}`);
  }

  if (result.actual !== undefined) {
    console.log(`       actual:   ${result.actual}`);
  }

  if (result.actualDelta !== undefined) {
    console.log(`       delta:    ${result.actualDelta}`);
  }
}

/**
 * ============================================================
 * READ DATABASE STATE
 * ============================================================
 */

async function readState() {
  const [bookingVendorUser, targetVendor, activeBookings] = await Promise.all([
    Vendor.findById(BOOKING_VENDOR_USER_ID)
      .select(["balance", "bookingCount", "pending", "shareBy", "cd"].join(" "))
      .lean(),

    Vendor.findById(TARGET_VENDOR_ID)
      .select(["balance", "pendingVendor", "bookingCountVendor"].join(" "))
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

  let referrer = null;

  if (bookingVendorUser.shareBy && bookingVendorUser.cd === "vendor") {
    referrer = await Vendor.findById(bookingVendorUser.shareBy)
      .select("pendingShareBy completedShareBy canceledShareBy earning")
      .lean();
  }

  return {
    bookingVendorUser,
    targetVendor,
    activeBookings,
    referrer,
  };
}

/**
 * ============================================================
 * COUNT NOTIFICATIONS FOR THIS TEST BOOKING
 * ============================================================
 *
 * Since a rolled-back booking should not exist, there is no
 * bookingId/idempotencyKey to query.
 *
 * Therefore we use source/type/date-oriented fields only if
 * they exist in your Notification model.
 *
 * The safest primary assertion remains:
 *
 *     booking must not exist.
 *
 * We additionally capture total notification count before and
 * after. Run this test in an otherwise idle DEV environment.
 * ============================================================
 */

async function getNotificationCount() {
  return Notification.countDocuments({});
}

/**
 * ============================================================
 * SEND REQUEST
 * ============================================================
 */

async function sendBookingRequest() {
  const requestId = `rollback-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  const start = Date.now();

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

          "x-request-id": requestId,

          ...(AUTH_TOKEN
            ? {
                Authorization: `Bearer ${AUTH_TOKEN}`,
              }
            : {}),
        },

        validateStatus: () => true,

        timeout: 15000,
      },
    );

    return {
      status: response.status,

      data: response.data,

      durationMs: Date.now() - start,

      requestId,
    };
  } catch (error) {
    return {
      status: "NETWORK_ERROR",

      error: error.message,

      durationMs: Date.now() - start,

      requestId,
    };
  }
}

/**
 * ============================================================
 * MAIN
 * ============================================================
 */

async function run() {
  let originalTargetBalance = null;

  let targetBalanceModified = false;

  let exitCode = 1;

  try {
    /**
     * --------------------------------------------------------
     * VALIDATION
     * --------------------------------------------------------
     */

    assertConfigured(BOOKING_VENDOR_USER_ID, "TEST_BOOKING_VENDOR_USER_ID");

    assertConfigured(TARGET_VENDOR_ID, "TEST_TARGET_VENDOR_ID");

    if (!mongoose.isValidObjectId(BOOKING_VENDOR_USER_ID)) {
      throw new Error("TEST_BOOKING_VENDOR_USER_ID is invalid");
    }

    if (!mongoose.isValidObjectId(TARGET_VENDOR_ID)) {
      throw new Error("TEST_TARGET_VENDOR_ID is invalid");
    }

    if (!process.env.MONGODB_URL_1) {
      throw new Error("MONGODB_URL_1 is required");
    }

    printSection("BOOKING TRANSACTION ROLLBACK TEST");

    console.log(`API: ${API_URL}`);

    console.log(`Booking vendor-user: ${BOOKING_VENDOR_USER_ID}`);

    console.log(`Target vendor: ${TARGET_VENDOR_ID}`);

    console.log(`Booking date: ${BOOKING_DATE}`);

    /**
     * --------------------------------------------------------
     * CONNECT
     * --------------------------------------------------------
     */

    await mongoose.connect(process.env.MONGODB_URL_1);

    console.log("MongoDB connected.");

    /**
     * --------------------------------------------------------
     * INITIAL STATE
     * --------------------------------------------------------
     */

    const initialState = await readState();

    if (initialState.activeBookings !== 0) {
      throw new Error(
        [
          "TEST ABORTED.",
          `Target vendor already has ${initialState.activeBookings}`,
          `active booking(s) for ${BOOKING_DATE}.`,
          "Use a fresh booking date.",
        ].join(" "),
      );
    }

    if (num(initialState.bookingVendorUser.balance) <= 0) {
      throw new Error(
        [
          "TEST ABORTED.",
          "Booking vendor-user has no balance.",
          "The first accounting update must be capable of succeeding",
          "for this rollback test to be meaningful.",
        ].join(" "),
      );
    }

    originalTargetBalance = num(initialState.targetVendor.balance);

    printSection("ORIGINAL STATE");

    console.log({
      activeBookings: initialState.activeBookings,

      bookingVendorUser: {
        balance: initialState.bookingVendorUser.balance,

        bookingCount: initialState.bookingVendorUser.bookingCount,

        pending: initialState.bookingVendorUser.pending,

        shareBy: initialState.bookingVendorUser.shareBy || null,

        cd: initialState.bookingVendorUser.cd || null,
      },

      targetVendor: {
        balance: initialState.targetVendor.balance,

        pendingVendor: initialState.targetVendor.pendingVendor,

        bookingCountVendor: initialState.targetVendor.bookingCountVendor,
      },

      referrer: initialState.referrer
        ? {
            pendingShareBy: initialState.referrer.pendingShareBy,
          }
        : null,
    });

    /**
     * --------------------------------------------------------
     * FORCE TARGET VENDOR INTO FAILURE CONDITION
     * --------------------------------------------------------
     *
     * We do this BEFORE capturing the test's BEFORE state.
     *
     * This means restoring the balance later does not affect
     * rollback assertions.
     * --------------------------------------------------------
     */

    printSection("PREPARING FAILURE CONDITION");

    console.log(`Original target balance: ${originalTargetBalance}`);

    console.log(`Temporarily forcing target balance to: ${FORCED_TARGET_BALANCE}`);

    const forceResult = await Vendor.updateOne(
      {
        _id: TARGET_VENDOR_ID,
      },

      {
        $set: {
          balance: FORCED_TARGET_BALANCE,
        },
      },
    );

    if (forceResult.matchedCount !== 1) {
      throw new Error("Unable to update target vendor balance");
    }

    targetBalanceModified = true;

    /**
     * Verify forced state.
     */

    const forcedVendor = await Vendor.findById(TARGET_VENDOR_ID).select("balance").lean();

    if (num(forcedVendor?.balance) !== FORCED_TARGET_BALANCE) {
      throw new Error("Unable to establish target vendor failure condition");
    }

    console.log("Failure condition prepared.");

    /**
     * --------------------------------------------------------
     * CAPTURE BEFORE STATE
     * --------------------------------------------------------
     */

    const before = await readState();

    const notificationsBefore = await getNotificationCount();

    printSection("BEFORE FAILED BOOKING");

    console.log({
      activeBookings: before.activeBookings,

      bookingVendorUser: {
        balance: before.bookingVendorUser.balance,

        bookingCount: before.bookingVendorUser.bookingCount,

        pending: before.bookingVendorUser.pending,
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

      notifications: notificationsBefore,
    });

    /**
     * --------------------------------------------------------
     * SEND BOOKING
     * --------------------------------------------------------
     */

    printSection("SENDING BOOKING THAT MUST FAIL");

    const response = await sendBookingRequest();

    console.log({
      status: response.status,

      durationMs: response.durationMs,

      requestId: response.requestId,

      response: response.data || response.error,
    });

    /**
     * Give any incorrectly-triggered post-commit notification
     * enough time to appear.
     */

    await sleep(1500);

    /**
     * --------------------------------------------------------
     * CAPTURE AFTER STATE
     * --------------------------------------------------------
     */

    const after = await readState();

    const notificationsAfter = await getNotificationCount();

    /**
     * --------------------------------------------------------
     * CALCULATE DELTAS
     * --------------------------------------------------------
     */

    const bookingDelta = after.activeBookings - before.activeBookings;

    const bookingUserBalanceDelta = delta(
      before.bookingVendorUser.balance,
      after.bookingVendorUser.balance,
    );

    const bookingCountDelta = delta(
      before.bookingVendorUser.bookingCount,
      after.bookingVendorUser.bookingCount,
    );

    const pendingDelta = delta(before.bookingVendorUser.pending, after.bookingVendorUser.pending);

    const targetBalanceDelta = delta(before.targetVendor.balance, after.targetVendor.balance);

    const pendingVendorDelta = delta(
      before.targetVendor.pendingVendor,
      after.targetVendor.pendingVendor,
    );

    const bookingCountVendorDelta = delta(
      before.targetVendor.bookingCountVendor,
      after.targetVendor.bookingCountVendor,
    );

    const notificationDelta = notificationsAfter - notificationsBefore;

    let referralDelta = null;

    if (before.referrer && after.referrer) {
      referralDelta = delta(before.referrer.pendingShareBy, after.referrer.pendingShareBy);
    }

    /**
     * --------------------------------------------------------
     * ASSERTIONS
     * --------------------------------------------------------
     */

    const assertions = [];

    /**
     * Your ApiError.paymentRequired() should normally be 402.
     *
     * If your implementation intentionally uses another status,
     * change TEST_EXPECTED_FAILURE_STATUS.
     */

    const expectedFailureStatus = Number(process.env.TEST_EXPECTED_FAILURE_STATUS) || 402;

    assertions.push(
      assertion(
        "Booking request failed with expected status",
        response.status === expectedFailureStatus,
        {
          expected: expectedFailureStatus,

          actual: response.status,
        },
      ),
    );

    assertions.push(
      assertion("No active booking was created", bookingDelta === 0, {
        before: before.activeBookings,

        after: after.activeBookings,

        actualDelta: bookingDelta,
      }),
    );

    assertions.push(
      assertion("Booking vendor-user balance rolled back", bookingUserBalanceDelta === 0, {
        before: before.bookingVendorUser.balance,

        after: after.bookingVendorUser.balance,

        actualDelta: bookingUserBalanceDelta,
      }),
    );

    assertions.push(
      assertion("Booking vendor-user bookingCount rolled back", bookingCountDelta === 0, {
        before: before.bookingVendorUser.bookingCount,

        after: after.bookingVendorUser.bookingCount,

        actualDelta: bookingCountDelta,
      }),
    );

    assertions.push(
      assertion("Booking vendor-user pending rolled back", pendingDelta === 0, {
        before: before.bookingVendorUser.pending,

        after: after.bookingVendorUser.pending,

        actualDelta: pendingDelta,
      }),
    );

    assertions.push(
      assertion("Target vendor balance unchanged", targetBalanceDelta === 0, {
        before: before.targetVendor.balance,

        after: after.targetVendor.balance,

        actualDelta: targetBalanceDelta,
      }),
    );

    assertions.push(
      assertion("Target vendor pendingVendor unchanged", pendingVendorDelta === 0, {
        before: before.targetVendor.pendingVendor,

        after: after.targetVendor.pendingVendor,

        actualDelta: pendingVendorDelta,
      }),
    );

    assertions.push(
      assertion("Target vendor bookingCountVendor unchanged", bookingCountVendorDelta === 0, {
        before: before.targetVendor.bookingCountVendor,

        after: after.targetVendor.bookingCountVendor,

        actualDelta: bookingCountVendorDelta,
      }),
    );

    if (before.referrer && after.referrer) {
      assertions.push(
        assertion("Referral pendingShareBy unchanged", referralDelta === 0, {
          before: before.referrer.pendingShareBy,

          after: after.referrer.pendingShareBy,

          actualDelta: referralDelta,
        }),
      );
    }

    assertions.push(
      assertion("No notification was created", notificationDelta === 0, {
        before: notificationsBefore,

        after: notificationsAfter,

        actualDelta: notificationDelta,
      }),
    );

    /**
     * --------------------------------------------------------
     * REPORT
     * --------------------------------------------------------
     */

    printSection("ROLLBACK ASSERTIONS");

    for (const result of assertions) {
      printAssertion(result);
    }

    printSection("STATE AFTER FAILED TRANSACTION");

    console.log({
      activeBookings: after.activeBookings,

      bookingVendorUser: {
        balance: after.bookingVendorUser.balance,

        balanceDelta: bookingUserBalanceDelta,

        bookingCount: after.bookingVendorUser.bookingCount,

        bookingCountDelta,

        pending: after.bookingVendorUser.pending,

        pendingDelta,
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

      notifications: {
        before: notificationsBefore,

        after: notificationsAfter,

        delta: notificationDelta,
      },
    });

    /**
     * --------------------------------------------------------
     * FINAL RESULT
     * --------------------------------------------------------
     */

    const failures = assertions.filter((item) => !item.pass);

    printSection("TEST SUMMARY");

    if (failures.length === 0) {
      console.log("PASS: TRANSACTION ROLLBACK IS ATOMIC");

      console.log("");
      console.log("No booking/accounting/referral/notification");

      console.log("side effects survived the failed transaction.");

      exitCode = 0;
    } else {
      console.log(`FAIL: ${failures.length} ROLLBACK INVARIANT(S) FAILED`);

      console.log("");

      for (const failure of failures) {
        console.log(`- ${failure.name}`);
      }

      exitCode = 1;
    }
  } catch (error) {
    printSection("TEST ERROR");

    console.error(error?.stack || error);

    exitCode = 1;
  } finally {
    /**
     * ========================================================
     * ALWAYS RESTORE TARGET VENDOR BALANCE
     * ========================================================
     *
     * This executes whether:
     *
     * - test passes
     * - assertion fails
     * - API throws
     * - database assertion throws
     *
     * It cannot protect against SIGKILL / machine crash, so
     * only run this against DEV/TEST data.
     * ========================================================
     */

    if (targetBalanceModified && originalTargetBalance !== null) {
      try {
        printSection("RESTORING TEST DATA");

        await Vendor.updateOne(
          {
            _id: TARGET_VENDOR_ID,
          },

          {
            $set: {
              balance: originalTargetBalance,
            },
          },
        );

        const restored = await Vendor.findById(TARGET_VENDOR_ID).select("balance").lean();

        if (num(restored?.balance) === originalTargetBalance) {
          console.log(`Target vendor balance restored to ${originalTargetBalance}.`);
        } else {
          console.error("WARNING: target vendor balance restoration verification failed.");

          exitCode = 1;
        }
      } catch (restoreError) {
        console.error("CRITICAL: failed to restore target vendor balance.");

        console.error(restoreError?.stack || restoreError);

        exitCode = 1;
      }
    }

    try {
      await mongoose.disconnect();
    } catch {
      // Ignore disconnect error.
    }

    process.exitCode = exitCode;
  }
}

run();
