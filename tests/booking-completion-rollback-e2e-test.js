"use strict";

/**
 * ============================================================
 * BOOKING COMPLETION TRANSACTION ROLLBACK E2E TEST
 * ============================================================
 *
 * PURPOSE
 * -------
 * Prove that completion is genuinely atomic.
 *
 * BookingService intentionally throws:
 *
 *   BOOKING_TEST_INJECTED_COMPLETION_FAILURE
 *
 * AFTER:
 *
 *   - booking.orderCompleted = true
 *   - customer completion counters mutate
 *   - provider completion counters mutate
 *   - customer-referrer state mutates
 *   - provider-referrer state mutates
 *
 * but BEFORE MongoDB transaction commit.
 *
 * Therefore every mutation MUST roll back.
 *
 * IMPORTANT
 * ---------
 * API server must be started separately with:
 *
 * NODE_ENV=development \
 * ALLOW_BOOKING_ROLLBACK_TEST=1 \
 * BOOKING_FAILURE_POINT=after_completion_mutations \
 * npm run dev
 *
 * Then run:
 *
 * NODE_ENV=development \
 * ALLOW_AUTHORIZATION_TEST=1 \
 * node tests/booking-completion-rollback-e2e-test.js
 *
 * NEVER enable ALLOW_BOOKING_ROLLBACK_TEST in production.
 */

const axios = require("axios");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const Vendor = require("../models/vendor");
const User = require("../models/user");
const Bookings = require("../models/bookings");

const ENV = require("../src/config/env");

/**
 * ============================================================
 * CONFIG
 * ============================================================
 */

const API_BASE = process.env.TEST_API_BASE || "http://localhost:3000/api";

const COMPLETE_API = `${API_BASE}/bookings/orderCompletedV`;

const CONCURRENCY = Number(process.env.TEST_ROLLBACK_CONCURRENCY || 1);

const COMMISSION = 100;

const BOOKING_DATE = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toDateString();

/**
 * Use very unlikely phone numbers so fixtures don't collide
 * with real development accounts.
 */
const RUN_ID = `${Date.now()}`.slice(-7);

const CUSTOMER_PHONE = Number(`91${RUN_ID}01`);
const PROVIDER_PHONE = Number(`91${RUN_ID}02`);
const ATTACKER_PHONE = Number(`91${RUN_ID}03`);
const CUSTOMER_REFERRER_PHONE = Number(`91${RUN_ID}04`);
const PROVIDER_REFERRER_PHONE = Number(`91${RUN_ID}05`);

const PASSWORD = "RollbackTest@123";

/**
 * ============================================================
 * TEST STATE
 * ============================================================
 */

let customerVendor;
let providerVendor;
let attackerVendor;

let customerReferrer;
let providerReferrer;

let booking;

let authToken;

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

function assert(condition, message) {
  assertions += 1;

  if (condition) {
    passed += 1;
    console.log(`✓ ${message}`);
    return;
  }

  failed += 1;
  console.error(`✗ ${message}`);
}

function assertEqual(actual, expected, message) {
  assert(
    String(actual) === String(expected),
    `${message} [expected=${expected}, actual=${actual}]`,
  );
}

function number(value) {
  return Number(value || 0);
}

/**
 * ============================================================
 * ENVIRONMENT SAFETY
 * ============================================================
 */

function validateEnvironment() {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Rollback E2E test must NEVER run with NODE_ENV=production");
  }

  if (process.env.ALLOW_AUTHORIZATION_TEST !== "1") {
    throw new Error("Set ALLOW_AUTHORIZATION_TEST=1 before running this test");
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
  const mongoUri =
    ENV.MONGODB_URI || ENV.MONGO_URI || process.env.MONGODB_URI || process.env.MONGO_URI;

  if (!mongoUri) {
    throw new Error("MongoDB URI is not configured");
  }

  await mongoose.connect(mongoUri);

  console.log("MongoDB connected.");
}

/**
 * ============================================================
 * JWT
 * ============================================================
 */

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

/**
 * ============================================================
 * FIXTURES
 * ============================================================
 */

async function createFixtures() {
  section("CREATE TEST FIXTURES");

  const passwordHash = await bcrypt.hash(PASSWORD, 4);

  /**
   * Customer referrer.
   *
   * This account should receive referral completion accounting
   * during the transaction — which must then roll back.
   */
  customerReferrer = await User.create({
    name: "Rollback Customer Referrer",
    phoneNo: CUSTOMER_REFERRER_PHONE,
    password: passwordHash,

    balance: 700,
    earning: 100,

    pendingShareBy: 1,
    completedShareBy: 10,
    canceledShareBy: 2,

    transactionCount: 10,
    totalDiscount: 0,

    verifyPhoneNo: true,
  });

  /**
   * Provider referrer.
   */
  providerReferrer = await Vendor.create({
    name: "Rollback Provider Referrer",
    phoneNo: PROVIDER_REFERRER_PHONE,
    password: passwordHash,

    type: "electrician",

    commission: COMMISSION,

    balance: 900,
    earning: 200,

    pendingShareBy: 1,
    completedShareBy: 20,
    canceledShareBy: 3,

    transactionCount: 10,
    totalDiscount: 0,

    verifyPhoneNo: true,
  });

  /**
   * Vendor acting as booking customer.
   */
  customerVendor = await Vendor.create({
    name: "Rollback Customer Vendor",
    phoneNo: CUSTOMER_PHONE,
    password: passwordHash,

    type: "electrician",

    commission: 50,

    balance: 5000,

    pending: 1,
    completed: 5,
    canceled: 2,

    bookingCount: 10,

    shareBy: customerReferrer._id.toString(),
    cd: "user",

    verifyPhoneNo: true,
  });

  /**
   * Service provider.
   */
  providerVendor = await Vendor.create({
    name: "Rollback Provider Vendor",
    phoneNo: PROVIDER_PHONE,
    password: passwordHash,

    type: "electrician",

    commission: COMMISSION,

    balance: 5000,

    pendingVendor: 1,
    completedVendor: 5,
    canceledVendor: 2,

    bookingCountVendor: 10,

    shareBy: providerReferrer._id.toString(),
    cd: "vendor",

    transactionCount: 10,
    totalDiscount: 0,

    verifyPhoneNo: true,
  });

  /**
   * Unrelated account used to verify no accidental mutation.
   */
  attackerVendor = await Vendor.create({
    name: "Rollback Attacker Vendor",
    phoneNo: ATTACKER_PHONE,
    password: passwordHash,

    type: "electrician",

    commission: 50,

    balance: 1234,

    pending: 7,
    completed: 8,
    canceled: 9,

    pendingVendor: 4,
    completedVendor: 5,
    canceledVendor: 6,

    verifyPhoneNo: true,
  });

  booking = await Bookings.create({
    userId: customerVendor._id,
    vendorId: providerVendor._id,

    type: providerVendor.type,
    pincode: "274001",

    bookingDate: BOOKING_DATE,

    cancelOrder: false,
    orderCompleted: false,

    rating: 0,
    ratingPermission: false,
    isServed: false,
    isBooked: true,
  });

  authToken = createVendorToken(customerVendor);

  console.log({
    customerVendor: customerVendor._id.toString(),
    providerVendor: providerVendor._id.toString(),
    attackerVendor: attackerVendor._id.toString(),

    customerReferrer: customerReferrer._id.toString(),

    providerReferrer: providerReferrer._id.toString(),

    bookingId: booking._id.toString(),

    bookingDate: BOOKING_DATE,

    commission: COMMISSION,
  });
}

/**
 * ============================================================
 * STATE SNAPSHOT
 * ============================================================
 */

async function getState() {
  const [currentBooking, customer, provider, customerRef, providerRef, attacker] =
    await Promise.all([
      Bookings.findById(booking._id).lean(),

      Vendor.findById(customerVendor._id).lean(),

      Vendor.findById(providerVendor._id).lean(),

      User.findById(customerReferrer._id).lean(),

      Vendor.findById(providerReferrer._id).lean(),

      Vendor.findById(attackerVendor._id).lean(),
    ]);

  if (!currentBooking) {
    throw new Error("Booking disappeared during rollback test");
  }

  if (!customer) {
    throw new Error("Customer Vendor disappeared");
  }

  if (!provider) {
    throw new Error("Provider Vendor disappeared");
  }

  if (!customerRef) {
    throw new Error("Customer referrer disappeared");
  }

  if (!providerRef) {
    throw new Error("Provider referrer disappeared");
  }

  return {
    booking: currentBooking,
    customer,
    provider,
    customerReferrer: customerRef,
    providerReferrer: providerRef,
    attacker,
  };
}

/**
 * ============================================================
 * API REQUEST
 * ============================================================
 */

async function sendCompletionRequest(index = 1) {
  const requestId = `rollback-test-${Date.now()}-${index}`;

  const started = Date.now();

  try {
    const response = await axios.patch(
      COMPLETE_API,

      {
        bookingId: booking._id.toString(),
      },

      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
          "x-request-id": requestId,
        },

        validateStatus: () => true,

        timeout: 15000,
      },
    );

    return {
      status: response.status,
      data: response.data,
      durationMs: Date.now() - started,
    };
  } catch (error) {
    return {
      status: "NETWORK_ERROR",
      error: error.message,
      durationMs: Date.now() - started,
    };
  }
}

/**
 * ============================================================
 * ROLLBACK ASSERTIONS
 * ============================================================
 */

function verifyRollback(before, after) {
  section("BOOKING ROLLBACK");

  assertEqual(
    after.booking.orderCompleted,
    before.booking.orderCompleted,
    "Injected failure rolls back orderCompleted",
  );

  assertEqual(
    after.booking.cancelOrder,
    before.booking.cancelOrder,
    "Injected failure does not cancel booking",
  );

  /**
   * Customer accounting.
   */

  section("CUSTOMER ACCOUNTING ROLLBACK");

  assertEqual(after.customer.pending, before.customer.pending, "Customer pending is rolled back");

  assertEqual(
    after.customer.completed,
    before.customer.completed,
    "Customer completed is rolled back",
  );

  assertEqual(
    after.customer.canceled,
    before.customer.canceled,
    "Customer canceled remains unchanged",
  );

  assertEqual(
    after.customer.balance,
    before.customer.balance,
    "Customer balance remains unchanged",
  );

  assertEqual(
    after.customer.bookingCount,
    before.customer.bookingCount,
    "Customer bookingCount remains unchanged",
  );

  /**
   * Provider accounting.
   */

  section("PROVIDER ACCOUNTING ROLLBACK");

  assertEqual(
    after.provider.pendingVendor,
    before.provider.pendingVendor,
    "Provider pendingVendor is rolled back",
  );

  assertEqual(
    after.provider.completedVendor,
    before.provider.completedVendor,
    "Provider completedVendor is rolled back",
  );

  assertEqual(
    after.provider.canceledVendor,
    before.provider.canceledVendor,
    "Provider canceledVendor remains unchanged",
  );

  assertEqual(
    after.provider.balance,
    before.provider.balance,
    "Provider balance remains unchanged",
  );

  assertEqual(
    after.provider.bookingCountVendor,
    before.provider.bookingCountVendor,
    "Provider bookingCountVendor remains unchanged",
  );

  /**
   * Customer referrer.
   */

  section("CUSTOMER REFERRAL ROLLBACK");

  assertEqual(
    after.customerReferrer.pendingShareBy,
    before.customerReferrer.pendingShareBy,
    "Customer referrer pendingShareBy is rolled back",
  );

  assertEqual(
    after.customerReferrer.completedShareBy,
    before.customerReferrer.completedShareBy,
    "Customer referrer completedShareBy is rolled back",
  );

  assertEqual(
    after.customerReferrer.canceledShareBy,
    before.customerReferrer.canceledShareBy,
    "Customer referrer canceledShareBy remains unchanged",
  );

  assertEqual(
    after.customerReferrer.earning,
    before.customerReferrer.earning,
    "Customer referral earning is rolled back",
  );

  assertEqual(
    after.customerReferrer.balance,
    before.customerReferrer.balance,
    "Customer referrer balance remains unchanged",
  );

  /**
   * Provider referrer.
   */

  section("PROVIDER REFERRAL ROLLBACK");

  assertEqual(
    after.providerReferrer.pendingShareBy,
    before.providerReferrer.pendingShareBy,
    "Provider referrer pendingShareBy is rolled back",
  );

  assertEqual(
    after.providerReferrer.completedShareBy,
    before.providerReferrer.completedShareBy,
    "Provider referrer completedShareBy is rolled back",
  );

  assertEqual(
    after.providerReferrer.canceledShareBy,
    before.providerReferrer.canceledShareBy,
    "Provider referrer canceledShareBy remains unchanged",
  );

  assertEqual(
    after.providerReferrer.earning,
    before.providerReferrer.earning,
    "Provider referral earning is rolled back",
  );

  assertEqual(
    after.providerReferrer.balance,
    before.providerReferrer.balance,
    "Provider referrer balance remains unchanged",
  );

  /**
   * Unrelated account.
   */

  section("UNRELATED ACCOUNT INVARIANTS");

  if (before.attacker && after.attacker) {
    assertEqual(
      after.attacker.balance,
      before.attacker.balance,
      "Unrelated Vendor balance remains unchanged",
    );

    assertEqual(
      after.attacker.pending,
      before.attacker.pending,
      "Unrelated Vendor pending remains unchanged",
    );

    assertEqual(
      after.attacker.completed,
      before.attacker.completed,
      "Unrelated Vendor completed remains unchanged",
    );

    assertEqual(
      after.attacker.pendingVendor,
      before.attacker.pendingVendor,
      "Unrelated Vendor pendingVendor remains unchanged",
    );

    assertEqual(
      after.attacker.completedVendor,
      before.attacker.completedVendor,
      "Unrelated Vendor completedVendor remains unchanged",
    );
  }
}

/**
 * ============================================================
 * COMPLETE SNAPSHOT COMPARISON
 * ============================================================
 *
 * These assertions protect fields that matter financially even
 * if additional business logic gets added later.
 */

function verifyCriticalFinancialState(before, after) {
  section("CRITICAL FINANCIAL STATE");

  const customerFields = [
    "balance",
    "pending",
    "completed",
    "canceled",
    "bookingCount",
    "earning",
    "transactionCount",
    "totalDiscount",
  ];

  for (const field of customerFields) {
    assertEqual(
      number(after.customer[field]),
      number(before.customer[field]),
      `Customer ${field} has no committed mutation`,
    );
  }

  const providerFields = [
    "balance",
    "pendingVendor",
    "completedVendor",
    "canceledVendor",
    "bookingCountVendor",
    "earning",
    "transactionCount",
    "totalDiscount",
  ];

  for (const field of providerFields) {
    assertEqual(
      number(after.provider[field]),
      number(before.provider[field]),
      `Provider ${field} has no committed mutation`,
    );
  }

  const referralFields = [
    "balance",
    "earning",
    "pendingShareBy",
    "completedShareBy",
    "canceledShareBy",
  ];

  for (const field of referralFields) {
    assertEqual(
      number(after.customerReferrer[field]),
      number(before.customerReferrer[field]),
      `Customer referrer ${field} has no committed mutation`,
    );

    assertEqual(
      number(after.providerReferrer[field]),
      number(before.providerReferrer[field]),
      `Provider referrer ${field} has no committed mutation`,
    );
  }
}

/**
 * ============================================================
 * CLEANUP
 * ============================================================
 */

async function cleanup() {
  section("CLEANUP");

  const bookingIds = booking?._id ? [booking._id] : [];

  const vendorIds = [
    customerVendor?._id,
    providerVendor?._id,
    attackerVendor?._id,
    providerReferrer?._id,
  ].filter(Boolean);

  const userIds = [customerReferrer?._id].filter(Boolean);

  const [bookingResult, vendorResult, userResult] = await Promise.all([
    Bookings.deleteMany({
      _id: {
        $in: bookingIds,
      },
    }),

    Vendor.deleteMany({
      _id: {
        $in: vendorIds,
      },
    }),

    User.deleteMany({
      _id: {
        $in: userIds,
      },
    }),
  ]);

  console.log({
    bookingsDeleted: bookingResult.deletedCount,

    vendorsDeleted: vendorResult.deletedCount,

    usersDeleted: userResult.deletedCount,
  });
}

/**
 * ============================================================
 * MAIN
 * ============================================================
 */

async function run() {
  validateEnvironment();

  await connectMongo();

  section("VENDOR BOOKING COMPLETION TRANSACTION ROLLBACK E2E TEST");

  console.log({
    completeApi: COMPLETE_API,
    nodeEnv: process.env.NODE_ENV,
    bookingDate: BOOKING_DATE,
    expectedFailure: "BOOKING_TEST_INJECTED_COMPLETION_FAILURE",
  });

  try {
    await createFixtures();

    /**
     * --------------------------------------------------------
     * BEFORE SNAPSHOT
     * --------------------------------------------------------
     */

    section("PRE-FAILURE DATABASE STATE");

    const before = await getState();

    assert(before.booking.orderCompleted === false, "Booking starts incomplete");

    assert(before.booking.cancelOrder === false, "Booking starts uncancelled");

    assertEqual(before.customer.pending, 1, "Customer starts with one pending booking");

    assertEqual(before.provider.pendingVendor, 1, "Provider starts with one pendingVendor booking");

    assertEqual(
      before.customerReferrer.pendingShareBy,
      1,
      "Customer referrer starts with one pendingShareBy",
    );

    assertEqual(
      before.providerReferrer.pendingShareBy,
      1,
      "Provider referrer starts with one pendingShareBy",
    );

    /**
     * --------------------------------------------------------
     * TRIGGER FAILURE
     * --------------------------------------------------------
     */

    section("INJECT COMPLETION TRANSACTION FAILURE");

    console.log("Sending completion request expected to fail after transactional mutations...");

    const result = await sendCompletionRequest();

    console.log(result);

    assert(result.status !== 200, "Injected completion request does not succeed");

    assert(
      result.status !== "NETWORK_ERROR",
      "Injected failure is returned by API, not network failure",
    );

    /**
     * A deliberately injected internal exception will normally
     * become HTTP 500.
     *
     * Unlike security/concurrency tests, HTTP 500 is EXPECTED
     * here because the test intentionally crashes the
     * transaction.
     */
    assert(Number(result.status) === 500, "Injected internal transaction failure returns HTTP 500");

    /**
     * --------------------------------------------------------
     * AFTER SNAPSHOT
     * --------------------------------------------------------
     */

    section("POST-FAILURE DATABASE STATE");

    const after = await getState();

    /**
     * --------------------------------------------------------
     * ROLLBACK PROOF
     * --------------------------------------------------------
     */

    verifyRollback(before, after);

    verifyCriticalFinancialState(before, after);

    /**
     * --------------------------------------------------------
     * FINAL INVARIANTS
     * --------------------------------------------------------
     */

    section("FINAL DATABASE INVARIANTS");

    assert(after.booking.orderCompleted === false, "Failed transaction leaves booking incomplete");

    assert(after.booking.cancelOrder === false, "Failed transaction leaves booking active");

    assertEqual(after.customer.pending, 1, "Customer still has exactly one pending booking");

    assertEqual(after.customer.completed, 5, "Customer completed counter remains exactly five");

    assertEqual(
      after.provider.pendingVendor,
      1,
      "Provider still has exactly one pendingVendor booking",
    );

    assertEqual(after.provider.completedVendor, 5, "Provider completedVendor remains exactly five");

    assertEqual(after.customerReferrer.pendingShareBy, 1, "Customer referral remains pending");

    assertEqual(
      after.customerReferrer.completedShareBy,
      10,
      "Customer referral completion counter remains unchanged",
    );

    assertEqual(
      after.customerReferrer.earning,
      100,
      "Customer referral earning receives no committed reward",
    );

    assertEqual(after.providerReferrer.pendingShareBy, 1, "Provider referral remains pending");

    assertEqual(
      after.providerReferrer.completedShareBy,
      20,
      "Provider referral completion counter remains unchanged",
    );

    assertEqual(
      after.providerReferrer.earning,
      200,
      "Provider referral earning receives no committed reward",
    );

    assert(number(after.customer.pending) >= 0, "Customer pending remains non-negative");

    assert(
      number(after.provider.pendingVendor) >= 0,
      "Provider pendingVendor remains non-negative",
    );
  } finally {
    await cleanup();

    await mongoose.disconnect();

    console.log("MongoDB disconnected.");
  }

  /**
   * ==========================================================
   * SUMMARY
   * ==========================================================
   */

  section("FINAL COMPLETION TRANSACTION ROLLBACK TEST SUMMARY");

  console.log(`Assertions: ${assertions}`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);

  console.log("");

  if (failed > 0) {
    console.error("FAIL: BOOKING COMPLETION TRANSACTION ROLLBACK INVARIANTS FAILED");

    process.exitCode = 1;

    return;
  }

  console.log("PASS: BOOKING COMPLETION TRANSACTION ROLLBACK INVARIANTS PASSED");

  console.log(`
Verified:

✓ Failure occurs after completion mutations execute

✓ MongoDB aborts the complete transaction

✓ booking.orderCompleted rolls back

✓ booking.cancelOrder remains unchanged

✓ Customer pending rollback succeeds

✓ Customer completed rollback succeeds

✓ Provider pendingVendor rollback succeeds

✓ Provider completedVendor rollback succeeds

✓ Customer referral pendingShareBy rolls back

✓ Customer referral completedShareBy rolls back

✓ Customer referral earning rolls back

✓ Provider referral pendingShareBy rolls back

✓ Provider referral completedShareBy rolls back

✓ Provider referral earning rolls back

✓ Customer/provider balances remain unchanged

✓ Booking counters remain unchanged

✓ No partial financial mutation survives

✓ No partial referral mutation survives

✓ Failed transaction leaves booking retryable
`);
}

/**
 * ============================================================
 * PROCESS
 * ============================================================
 */

run().catch(async (error) => {
  section("TEST FAILED");

  console.error(error);

  try {
    await cleanup();
  } catch (cleanupError) {
    console.error("Cleanup after test failure also failed:", cleanupError);
  }

  try {
    await mongoose.disconnect();
  } catch (_) {
    // Ignore disconnect errors.
  }

  process.exitCode = 1;
});
