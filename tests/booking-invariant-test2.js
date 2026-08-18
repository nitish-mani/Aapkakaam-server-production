"use strict";

/**
 * Vendor -> Vendor Booking Concurrency / Transaction Invariant E2E Test
 *
 * PURPOSE
 * -------
 * Prove that concurrent requests cannot:
 *
 * 1. Create multiple active bookings for the same vendor/date.
 * 2. Double-charge the authenticated customer Vendor.
 * 3. Double-charge the service-provider Vendor.
 * 4. Double-increment booking/accounting counters.
 * 5. Use another Vendor's identity through body.userId.
 * 6. Produce uncontrolled HTTP 500 responses under normal contention.
 *
 * IMPORTANT
 * ---------
 * - Run only against development/test.
 * - Creates temporary Vendors directly in MongoDB.
 * - Generates its own Vendor JWT.
 * - Does NOT depend on OTP/SMS.
 * - Cleans up all test records.
 *
 * Run:
 *
 * NODE_ENV=development ALLOW_AUTHORIZATION_TEST=1 \
 * node tests/booking-invariant-test2.js
 */

const axios = require("axios");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const Vendor = require("../models/vendor");
const Bookings = require("../models/bookings");
const ENV = require("../src/config/env");

/**
 * ============================================================
 * CONFIGURATION
 * ============================================================
 */

const API_BASE = process.env.TEST_API_BASE || "http://localhost:3000/api";

const API_URL = `${API_BASE}/bookings/postToBookingsV`;

const CONCURRENCY = Number(process.env.TEST_BOOKING_CONCURRENCY || 100);

const TEST_PASSWORD = "BookingInvariant@123";

const TEST_PINCODE = "274201";

const TEST_TYPE = "plumber";

/**
 * Keep the test sufficiently far in the future.
 */
const BOOKING_DATE = (() => {
  const date = new Date();

  date.setDate(date.getDate() + 14);

  return date.toDateString();
})();

/**
 * Test namespace.
 */
const TEST_RUN_ID = `${Date.now()}-${Math.floor(Math.random() * 1000000)}`;

/**
 * Use Indian-looking test numbers but keep them unique.
 *
 * MongoDB schema stores phoneNo as Number.
 */
const PHONE_BASE = 7000000000 + Number(String(Date.now()).slice(-7));

const CUSTOMER_PHONE = PHONE_BASE;
const PROVIDER_PHONE = PHONE_BASE + 1;
const VICTIM_PHONE = PHONE_BASE + 2;

/**
 * Controlled financial state.
 *
 * With:
 *
 * totalDiscount = 0
 * transactionCount = 0
 *
 * BookingService.calculateBookingCharges():
 *
 * customerCharge = 10
 * vendorCharge   = commission
 */
const INITIAL_BALANCE = 1000;
const PROVIDER_COMMISSION = 50;

const EXPECTED_CUSTOMER_CHARGE = 10;
const EXPECTED_PROVIDER_CHARGE = 50;

/**
 * ============================================================
 * TEST STATE
 * ============================================================
 */

let customerVendor = null;
let providerVendor = null;
let victimVendor = null;

let customerToken = null;

let assertions = 0;
let passed = 0;
let failed = 0;

/**
 * ============================================================
 * OUTPUT HELPERS
 * ============================================================
 */

function section(title) {
  console.log("");
  console.log("========================================");
  console.log(title);
  console.log("========================================");
}

function assert(condition, message, details = "") {
  assertions += 1;

  if (condition) {
    passed += 1;

    console.log(`✓ ${message}`);

    return true;
  }

  failed += 1;

  console.error(`✗ ${message}`);

  if (details) {
    console.error(`  ${details}`);
  }

  return false;
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

/**
 * ============================================================
 * SAFETY
 * ============================================================
 */

function assertSafeEnvironment() {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Refusing to run booking invariant test in production");
  }

  if (process.env.ALLOW_AUTHORIZATION_TEST !== "1") {
    throw new Error("Set ALLOW_AUTHORIZATION_TEST=1 to run this test");
  }

  if (!ENV.JWT_VENDOR_SECRET) {
    throw new Error("JWT_VENDOR_SECRET is not configured");
  }
}

/**
 * ============================================================
 * DATABASE
 * ============================================================
 */

async function connectMongo() {
  if (mongoose.connection.readyState === 1) {
    return;
  }

  /**
   * Adapt this fallback if your project exposes Mongo URI
   * under another environment variable.
   */
  const mongoUri =
    process.env.MONGODB_URI ||
    process.env.MONGO_URI ||
    process.env.DB_URI ||
    process.env.MONGODB_URL ||
    ENV.MONGODB_URI ||
    ENV.MONGO_URI ||
    ENV.DB_URI;

  if (!mongoUri) {
    throw new Error(
      "MongoDB URI not found. Set MONGODB_URI/MONGO_URI/DB_URI " +
        "or adapt connectMongo() to your existing config.",
    );
  }

  await mongoose.connect(mongoUri);

  console.log("MongoDB connected.");
}

/**
 * ============================================================
 * FIXTURES
 * ============================================================
 */

async function createVendor({ name, phoneNo, type = TEST_TYPE, commission = 50 }) {
  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 12);

  return Vendor.create({
    name,

    phoneNo,

    email: "",

    password: passwordHash,

    type,

    gender: "male",

    experience: 1,

    verifyPhoneNo: true,

    verifyEmail: false,

    isVerified: true,

    commission,

    wageRate: 0,

    wageRateType: "",

    balance: INITIAL_BALANCE,

    totalDiscount: 0,

    transactionCount: 0,

    bookingCount: 0,

    bookingCountVendor: 0,

    pending: 0,

    pendingVendor: 0,

    completed: 0,

    completedVendor: 0,

    canceled: 0,

    canceledVendor: 0,

    shareCount: 0,

    pincode: TEST_PINCODE,

    agreedToTnCnP: true,

    accountCreatedOn: new Date(),
  });
}

function createVendorToken(vendor) {
  return jwt.sign(
    {
      phoneNo: vendor.phoneNo,

      vendorId: vendor._id.toString(),

      type: vendor.type,
    },

    ENV.JWT_VENDOR_SECRET,

    {
      expiresIn: "1h",
    },
  );
}

async function createFixtures() {
  section("CREATE TEST FIXTURES");

  customerVendor = await createVendor({
    name: `Invariant Customer ${TEST_RUN_ID}`,

    phoneNo: CUSTOMER_PHONE,

    type: "plumber",

    commission: 50,
  });

  providerVendor = await createVendor({
    name: `Invariant Provider ${TEST_RUN_ID}`,

    phoneNo: PROVIDER_PHONE,

    type: TEST_TYPE,

    commission: PROVIDER_COMMISSION,
  });

  victimVendor = await createVendor({
    name: `Invariant Victim ${TEST_RUN_ID}`,

    phoneNo: VICTIM_PHONE,

    type: "electrician",

    commission: 50,
  });

  customerToken = createVendorToken(customerVendor);

  console.log({
    customerVendor: customerVendor._id.toString(),

    providerVendor: providerVendor._id.toString(),

    victimVendor: victimVendor._id.toString(),

    bookingDate: BOOKING_DATE,

    concurrency: CONCURRENCY,
  });
}

/**
 * ============================================================
 * STATE SNAPSHOT
 * ============================================================
 */

async function getVendorState(id) {
  const vendor = await Vendor.findById(id)
    .select(
      [
        "balance",
        "bookingCount",
        "bookingCountVendor",
        "pending",
        "pendingVendor",
        "completed",
        "completedVendor",
        "canceled",
        "canceledVendor",
        "transactionCount",
        "totalDiscount",
        "commission",
      ].join(" "),
    )
    .lean();

  if (!vendor) {
    throw new Error(`Vendor not found: ${id}`);
  }

  return vendor;
}

async function countActiveBookings() {
  return Bookings.countDocuments({
    vendorId: providerVendor._id,

    bookingDate: BOOKING_DATE,

    cancelOrder: false,

    orderCompleted: false,
  });
}

async function getActiveBookings() {
  return Bookings.find({
    vendorId: providerVendor._id,

    bookingDate: BOOKING_DATE,

    cancelOrder: false,

    orderCompleted: false,
  })
    .sort({
      bookedOn: 1,
    })
    .lean();
}

/**
 * ============================================================
 * HTTP
 * ============================================================
 */

async function sendBookingRequest(index, { bodyUserId = customerVendor._id.toString() } = {}) {
  const requestId = `booking-invariant-${TEST_RUN_ID}-${index}`;

  const startedAt = Date.now();

  try {
    const response = await axios.post(
      API_URL,

      {
        /**
         * Validator currently requires userId.
         *
         * Controller authorization must ensure this belongs
         * to the authenticated Vendor.
         */
        userId: bodyUserId,

        vendorId: providerVendor._id.toString(),

        bookingDate: BOOKING_DATE,

        type: providerVendor.type,

        pincode: TEST_PINCODE,
      },

      {
        headers: {
          Authorization: `Bearer ${customerToken}`,

          "Content-Type": "application/json",

          "x-request-id": requestId,
        },

        timeout: 30000,

        validateStatus: () => true,
      },
    );

    return {
      index,

      status: response.status,

      data: response.data,

      durationMs: Date.now() - startedAt,

      networkError: false,
    };
  } catch (error) {
    return {
      index,

      status: null,

      data: null,

      durationMs: Date.now() - startedAt,

      networkError: true,

      error: error.message,
    };
  }
}

/**
 * ============================================================
 * SECURITY TEST
 * ============================================================
 */

async function testBodyUserIdInjection() {
  section("BODY USER ID / IDOR AUTHORIZATION");

  const customerBefore = await getVendorState(customerVendor._id);

  const victimBefore = await getVendorState(victimVendor._id);

  const providerBefore = await getVendorState(providerVendor._id);

  const bookingCountBefore = await countActiveBookings();

  const result = await sendBookingRequest(
    "idor",

    {
      bodyUserId: victimVendor._id.toString(),
    },
  );

  /**
   * Current controller policy should reject a body userId
   * that does not match req.auth.id.
   */
  assert(
    result.status >= 400 && result.status < 500,

    `Authenticated Vendor cannot use victim userId [HTTP ${result.status}]`,

    JSON.stringify(result.data),
  );

  assert(
    result.status !== 500,

    "IDOR rejection does not produce HTTP 500",
  );

  const customerAfter = await getVendorState(customerVendor._id);

  const victimAfter = await getVendorState(victimVendor._id);

  const providerAfter = await getVendorState(providerVendor._id);

  const bookingCountAfter = await countActiveBookings();

  assert(
    approximatelyEqual(customerAfter.balance, customerBefore.balance),

    "IDOR attempt does not charge authenticated Vendor",
  );

  assert(
    approximatelyEqual(victimAfter.balance, victimBefore.balance),

    "IDOR attempt does not charge victim Vendor",
  );

  assert(
    approximatelyEqual(providerAfter.balance, providerBefore.balance),

    "IDOR attempt does not charge provider Vendor",
  );

  assert(
    number(victimAfter.bookingCount) === number(victimBefore.bookingCount),

    "IDOR attempt does not increment victim bookingCount",
  );

  assert(
    number(victimAfter.pending) === number(victimBefore.pending),

    "IDOR attempt does not increment victim pending",
  );

  assert(
    bookingCountAfter === bookingCountBefore,

    "IDOR attempt creates no active booking",
  );
}

/**
 * ============================================================
 * CONCURRENCY TEST
 * ============================================================
 */

async function testConcurrency() {
  section("100-WAY BOOKING CONCURRENCY");

  /**
   * Ensure this date is clean before starting.
   */
  const existing = await countActiveBookings();

  assert(
    existing === 0,

    "No active booking exists before concurrency test",

    `Found ${existing}`,
  );

  const customerBefore = await getVendorState(customerVendor._id);

  const providerBefore = await getVendorState(providerVendor._id);

  console.log("");
  console.log(`Sending ${CONCURRENCY} concurrent booking requests...`);

  /**
   * Construct all promises first and launch together.
   */
  const requests = Array.from(
    {
      length: CONCURRENCY,
    },

    (_, index) => sendBookingRequest(index + 1),
  );

  const startedAt = Date.now();

  const results = await Promise.all(requests);

  const elapsedMs = Date.now() - startedAt;

  /**
   * ==========================================================
   * RESPONSE CLASSIFICATION
   * ==========================================================
   */

  const successful = results.filter((result) => result.status >= 200 && result.status < 300);

  const clientErrors = results.filter((result) => result.status >= 400 && result.status < 500);

  const serverErrors = results.filter((result) => result.status >= 500);

  const networkErrors = results.filter((result) => result.networkError);

  const statusCounts = {};

  for (const result of results) {
    const key = result.networkError ? "NETWORK_ERROR" : String(result.status);

    statusCounts[key] = (statusCounts[key] || 0) + 1;
  }

  console.log("");
  console.log({
    elapsedMs,

    requests: results.length,

    successful: successful.length,

    clientErrors: clientErrors.length,

    serverErrors: serverErrors.length,

    networkErrors: networkErrors.length,

    statusCounts,
  });

  /**
   * ==========================================================
   * HTTP INVARIANTS
   * ==========================================================
   */

  assert(
    results.length === CONCURRENCY,

    `Received results for all ${CONCURRENCY} requests`,
  );

  assert(
    successful.length === 1,

    "Exactly one concurrent booking request succeeds",

    `Successes=${successful.length}`,
  );

  assert(
    serverErrors.length === 0,

    "Concurrency produces no HTTP 500 responses",

    serverErrors.length ? JSON.stringify(serverErrors.slice(0, 5)) : "",
  );

  assert(
    networkErrors.length === 0,

    "Concurrency produces no network errors",

    networkErrors.length ? JSON.stringify(networkErrors.slice(0, 5)) : "",
  );

  /**
   * ==========================================================
   * DATABASE STATE
   * ==========================================================
   */

  const bookings = await getActiveBookings();

  const customerAfter = await getVendorState(customerVendor._id);

  const providerAfter = await getVendorState(providerVendor._id);

  assert(
    bookings.length === 1,

    "Exactly one active booking exists in MongoDB",

    `Found=${bookings.length}`,
  );

  if (bookings.length === 1) {
    const booking = bookings[0];

    assert(
      String(booking.userId) === String(customerVendor._id),

      "Booking belongs to authenticated customer Vendor",

      `booking.userId=${booking.userId}`,
    );

    assert(
      String(booking.vendorId) === String(providerVendor._id),

      "Booking belongs to intended provider Vendor",

      `booking.vendorId=${booking.vendorId}`,
    );

    assert(
      booking.bookingDate === BOOKING_DATE,

      "Booking uses canonical requested booking date",

      `bookingDate=${booking.bookingDate}`,
    );

    assert(
      booking.cancelOrder === false,

      "Created booking is active/not cancelled",
    );

    assert(
      booking.orderCompleted === false,

      "Created booking is active/not completed",
    );
  }

  /**
   * ==========================================================
   * CUSTOMER ACCOUNTING INVARIANTS
   * ==========================================================
   */

  const customerBalanceDelta = delta(customerBefore.balance, customerAfter.balance);

  const customerBookingDelta = delta(customerBefore.bookingCount, customerAfter.bookingCount);

  const customerPendingDelta = delta(customerBefore.pending, customerAfter.pending);

  assert(
    approximatelyEqual(customerBalanceDelta, -EXPECTED_CUSTOMER_CHARGE),

    "Customer Vendor is charged exactly once",

    `Expected=-${EXPECTED_CUSTOMER_CHARGE}, Actual=${customerBalanceDelta}`,
  );

  assert(
    customerBookingDelta === 1,

    "Customer Vendor bookingCount increments exactly once",

    `Actual delta=${customerBookingDelta}`,
  );

  assert(
    customerPendingDelta === 1,

    "Customer Vendor pending increments exactly once",

    `Actual delta=${customerPendingDelta}`,
  );

  /**
   * ==========================================================
   * PROVIDER ACCOUNTING INVARIANTS
   * ==========================================================
   */

  const providerBalanceDelta = delta(providerBefore.balance, providerAfter.balance);

  const providerBookingDelta = delta(
    providerBefore.bookingCountVendor,
    providerAfter.bookingCountVendor,
  );

  const providerPendingDelta = delta(providerBefore.pendingVendor, providerAfter.pendingVendor);

  assert(
    approximatelyEqual(providerBalanceDelta, -EXPECTED_PROVIDER_CHARGE),

    "Provider Vendor commission is charged exactly once",

    `Expected=-${EXPECTED_PROVIDER_CHARGE}, Actual=${providerBalanceDelta}`,
  );

  assert(
    providerBookingDelta === 1,

    "Provider bookingCountVendor increments exactly once",

    `Actual delta=${providerBookingDelta}`,
  );

  assert(
    providerPendingDelta === 1,

    "Provider pendingVendor increments exactly once",

    `Actual delta=${providerPendingDelta}`,
  );

  /**
   * These should not be touched by booking creation.
   */
  assert(
    number(customerAfter.completed) === number(customerBefore.completed),

    "Customer completed counter is unchanged",
  );

  assert(
    number(customerAfter.canceled) === number(customerBefore.canceled),

    "Customer canceled counter is unchanged",
  );

  assert(
    number(providerAfter.completedVendor) === number(providerBefore.completedVendor),

    "Provider completedVendor counter is unchanged",
  );

  assert(
    number(providerAfter.canceledVendor) === number(providerBefore.canceledVendor),

    "Provider canceledVendor counter is unchanged",
  );

  /**
   * ==========================================================
   * REPLAY AFTER WINNER
   * ==========================================================
   */

  section("POST-CONCURRENCY DUPLICATE ATTEMPT");

  const customerBeforeReplay = await getVendorState(customerVendor._id);

  const providerBeforeReplay = await getVendorState(providerVendor._id);

  const replay = await sendBookingRequest("post-concurrency-replay");

  assert(
    replay.status >= 400 && replay.status < 500,

    `Additional booking for occupied vendor/date is rejected [HTTP ${replay.status}]`,

    JSON.stringify(replay.data),
  );

  assert(
    replay.status !== 500,

    "Duplicate booking attempt does not produce HTTP 500",
  );

  const customerAfterReplay = await getVendorState(customerVendor._id);

  const providerAfterReplay = await getVendorState(providerVendor._id);

  const bookingsAfterReplay = await getActiveBookings();

  assert(
    bookingsAfterReplay.length === 1,

    "Duplicate attempt cannot create second active booking",
  );

  assert(
    approximatelyEqual(customerAfterReplay.balance, customerBeforeReplay.balance),

    "Rejected duplicate does not charge customer again",
  );

  assert(
    approximatelyEqual(providerAfterReplay.balance, providerBeforeReplay.balance),

    "Rejected duplicate does not charge provider again",
  );

  assert(
    number(customerAfterReplay.bookingCount) === number(customerBeforeReplay.bookingCount),

    "Rejected duplicate does not increment customer bookingCount",
  );

  assert(
    number(customerAfterReplay.pending) === number(customerBeforeReplay.pending),

    "Rejected duplicate does not increment customer pending",
  );

  assert(
    number(providerAfterReplay.bookingCountVendor) ===
      number(providerBeforeReplay.bookingCountVendor),

    "Rejected duplicate does not increment provider bookingCountVendor",
  );

  assert(
    number(providerAfterReplay.pendingVendor) === number(providerBeforeReplay.pendingVendor),

    "Rejected duplicate does not increment provider pendingVendor",
  );
}

/**
 * ============================================================
 * CLEANUP
 * ============================================================
 */

async function cleanup() {
  section("CLEANUP");

  const vendorIds = [customerVendor?._id, providerVendor?._id, victimVendor?._id].filter(Boolean);

  let bookingsDeleted = 0;
  let vendorsDeleted = 0;

  if (vendorIds.length) {
    const bookingResult = await Bookings.deleteMany({
      $or: [
        {
          userId: {
            $in: vendorIds,
          },
        },

        {
          vendorId: {
            $in: vendorIds,
          },
        },
      ],
    });

    bookingsDeleted = bookingResult.deletedCount || 0;

    const vendorResult = await Vendor.deleteMany({
      _id: {
        $in: vendorIds,
      },
    });

    vendorsDeleted = vendorResult.deletedCount || 0;
  }

  console.log({
    bookingsDeleted,
    vendorsDeleted,
  });
}

/**
 * ============================================================
 * MAIN
 * ============================================================
 */

async function main() {
  let crashed = false;

  try {
    assertSafeEnvironment();

    await connectMongo();

    section("VENDOR BOOKING TRANSACTION / CONCURRENCY INVARIANT E2E TEST");

    console.log({
      api: API_URL,

      nodeEnv: process.env.NODE_ENV,

      concurrency: CONCURRENCY,

      bookingDate: BOOKING_DATE,
    });

    await createFixtures();

    /**
     * First prove body.userId cannot cross account boundaries.
     *
     * This happens before the real concurrency test so an IDOR
     * vulnerability cannot contaminate accounting baselines.
     */
    await testBodyUserIdInjection();

    /**
     * Main race-condition test.
     */
    await testConcurrency();
  } catch (error) {
    crashed = true;

    section("TEST SUITE CRASHED");

    console.error(error?.stack || error);
  } finally {
    try {
      await cleanup();
    } catch (cleanupError) {
      crashed = true;

      console.error("Cleanup failed:", cleanupError?.stack || cleanupError);
    }

    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();

      console.log("MongoDB disconnected.");
    }
  }

  section("FINAL BOOKING INVARIANT TEST SUMMARY");

  console.log(`Assertions: ${assertions}`);

  console.log(`Passed: ${passed}`);

  console.log(`Failed: ${failed}`);

  if (crashed || failed > 0) {
    console.log("");
    console.log("FAIL: BOOKING TRANSACTION / CONCURRENCY INVARIANTS VIOLATED");

    process.exitCode = 1;

    return;
  }

  console.log("");
  console.log("PASS: BOOKING TRANSACTION / CONCURRENCY INVARIANTS PASSED");

  console.log("");
  console.log("Verified:");
  console.log("");
  console.log("✓ Authenticated Vendor identity controls booking ownership");
  console.log("✓ body.userId cannot redirect booking to another Vendor");
  console.log("✓ 100 concurrent requests create exactly one active booking");
  console.log("✓ Customer Vendor is charged exactly once");
  console.log("✓ Provider Vendor is charged exactly once");
  console.log("✓ Customer booking counters increment exactly once");
  console.log("✓ Provider booking counters increment exactly once");
  console.log("✓ Duplicate attempts do not cause additional accounting mutations");
  console.log("✓ MongoDB contains exactly one active vendor/date booking");
  console.log("✓ Failed contention requests do not produce HTTP 500");
}

/**
 * Prevent accidental import execution.
 */
if (require.main === module) {
  main();
}
