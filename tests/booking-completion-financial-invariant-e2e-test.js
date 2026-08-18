"use strict";

/**
 * ============================================================
 * BOOKING COMPLETION FINANCIAL / REFERRAL INVARIANT E2E TEST
 * ============================================================
 *
 * Tests:
 *
 * 1. Completion authorization / IDOR protection
 * 2. 100 concurrent completion requests
 * 3. Exactly ONE completion succeeds
 * 4. Booking becomes completed exactly once
 * 5. Customer accounting changes exactly once
 * 6. Provider accounting changes exactly once
 * 7. Customer referrer accounting changes exactly once
 * 8. Provider referrer accounting changes exactly once
 * 9. Referral earning is credited exactly once
 * 10. Referral reward goes to earning, NOT balance
 * 11. Replay cannot double-credit referral earning
 * 12. Pending counters never become negative
 *
 * IMPORTANT BUSINESS RULE:
 *
 * BookingService currently rewards when:
 *
 *      completedBefore >= 5
 *
 * Therefore fixtures use:
 *
 *      customer.completed = 5
 *      provider.completedVendor = 5
 *
 * The completion performed by this test is therefore the first
 * reward-eligible completion.
 *
 * Expected reward:
 *
 *      commission * 5% * discountMultiplier
 *
 * ============================================================
 */

const axios = require("axios");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const User = require("../models/user");
const Vendor = require("../models/vendor");
const Bookings = require("../models/bookings");

const ENV = require("../src/config/env");

/**
 * ============================================================
 * SAFETY GUARD
 * ============================================================
 */

if (process.env.NODE_ENV === "production" || process.env.ALLOW_AUTHORIZATION_TEST !== "1") {
  console.error(
    "REFUSING TO RUN: NODE_ENV must not be production and ALLOW_AUTHORIZATION_TEST=1 is required.",
  );

  process.exit(1);
}

/**
 * ============================================================
 * CONFIGURATION
 * ============================================================
 */

const API_BASE = process.env.TEST_API_BASE || "http://localhost:3000/api";

const COMPLETE_API = `${API_BASE}/bookings/orderCompletedV`;

const CONCURRENCY = Number(process.env.TEST_COMPLETION_CONCURRENCY || 100);

const COMMISSION = Number(process.env.TEST_PROVIDER_COMMISSION || 100);

/**
 * Keep discount zero so expected reward is deterministic:
 *
 * multiplier = 1
 *
 * reward = 100 * 0.05 = 5
 */
const TOTAL_DISCOUNT = 0;
const TRANSACTION_COUNT = 0;

const EXPECTED_DISCOUNT_MULTIPLIER = 1;

const EXPECTED_REFERRAL_REWARD = COMMISSION * 0.05 * EXPECTED_DISCOUNT_MULTIPLIER;

/**
 * Completion requires:
 *
 * Date.now() > bookingDate
 *
 * Use yesterday.
 */
const yesterday = new Date();

yesterday.setDate(yesterday.getDate() - 1);

const BOOKING_DATE = yesterday.toDateString();

/**
 * Unique test marker.
 */
const TEST_RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

/**
 * ============================================================
 * STATE
 * ============================================================
 */

let assertions = 0;
let passed = 0;
let failed = 0;

let customerVendor;
let providerVendor;
let attackerVendor;

let customerReferrer;
let providerReferrer;

let booking;

let customerToken;
let attackerToken;

/**
 * ============================================================
 * HELPERS
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

function number(value) {
  return Number(value || 0);
}

function delta(before, after) {
  return number(after) - number(before);
}

function approximatelyEqual(a, b, epsilon = 0.000001) {
  return Math.abs(number(a) - number(b)) <= epsilon;
}

function randomPhone(prefix) {
  /**
   * Generate deterministic-looking unique Indian-style
   * 10-digit test number.
   *
   * prefix should be 81-89.
   */
  const suffix = String(Math.floor(Math.random() * 100000000)).padStart(8, "0");

  return Number(`${prefix}${suffix}`);
}

function createVendorToken(vendor) {
  /**
   * Match your vendor authentication token structure.
   *
   * Your previous token contained:
   *
   * phoneNo
   * vendorId
   * type
   */
  return jwt.sign(
    {
      phoneNo: vendor.phoneNo,
      vendorId: vendor._id.toString(),
      type: vendor.type || "electrician",
    },
    ENV.JWT_VENDOR_SECRET,
    {
      expiresIn: "1h",
    },
  );
}

/**
 * ============================================================
 * DATABASE CONNECTION
 * ============================================================
 */

async function connectDatabase() {
  if (mongoose.connection.readyState === 1) {
    return;
  }

  /**
   * Adjust this fallback only if your env config uses another
   * property name.
   */
  const mongoUri =
    ENV.MONGODB_URI || ENV.MONGO_URI || process.env.MONGODB_URI || process.env.MONGO_URI;

  if (!mongoUri) {
    throw new Error(
      "MongoDB URI not found. Expected ENV.MONGODB_URI, ENV.MONGO_URI, MONGODB_URI or MONGO_URI.",
    );
  }

  await mongoose.connect(mongoUri);

  console.log("MongoDB connected.");
}

/**
 * ============================================================
 * CREATE FIXTURES
 * ============================================================
 */

async function createFixtures() {
  section("CREATE TEST FIXTURES");

  /**
   * ----------------------------------------------------------
   * CUSTOMER REFERRER
   * ----------------------------------------------------------
   *
   * Customer's shareBy points here.
   *
   * pendingShareBy starts at 1 because this booking is already
   * pending.
   */
  customerReferrer = await Vendor.create({
    name: `Completion Customer Referrer ${TEST_RUN_ID}`,

    phoneNo: randomPhone(81),

    password: "test-password",

    type: "electrician",

    balance: 1000,

    earning: 100,

    pendingShareBy: 1,

    completedShareBy: 10,

    canceledShareBy: 2,
  });

  /**
   * ----------------------------------------------------------
   * PROVIDER REFERRER
   * ----------------------------------------------------------
   */
  providerReferrer = await User.create({
    name: `Completion Provider Referrer ${TEST_RUN_ID}`,

    phoneNo: randomPhone(82),

    password: "test-password",

    balance: 1000,

    earning: 200,

    pendingShareBy: 1,

    completedShareBy: 20,

    canceledShareBy: 3,
  });

  /**
   * ----------------------------------------------------------
   * CUSTOMER VENDOR
   * ----------------------------------------------------------
   *
   * completed = 5
   *
   * This means the NEXT completion is reward eligible.
   *
   * cd = "vendor"
   *
   * Therefore shareBy resolves in Vendor collection.
   */
  customerVendor = await Vendor.create({
    name: `Completion Customer ${TEST_RUN_ID}`,

    phoneNo: randomPhone(83),

    password: "test-password",

    type: "electrician",

    balance: 900,

    pending: 1,

    completed: 5,

    canceled: 0,

    bookingCount: 6,

    shareBy: customerReferrer._id.toString(),

    cd: "vendor",

    totalDiscount: TOTAL_DISCOUNT,

    transactionCount: TRANSACTION_COUNT,
  });

  /**
   * ----------------------------------------------------------
   * PROVIDER VENDOR
   * ----------------------------------------------------------
   *
   * completedVendor = 5
   *
   * NEXT provider completion is reward eligible.
   *
   * cd = "user"
   *
   * Therefore provider's shareBy resolves in User collection.
   */
  providerVendor = await Vendor.create({
    name: `Completion Provider ${TEST_RUN_ID}`,

    phoneNo: randomPhone(84),

    password: "test-password",

    type: "electrician",

    balance: 800,

    commission: COMMISSION,

    pendingVendor: 1,

    completedVendor: 5,

    canceledVendor: 0,

    bookingCountVendor: 6,

    shareBy: providerReferrer._id.toString(),

    cd: "user",

    totalDiscount: TOTAL_DISCOUNT,

    transactionCount: TRANSACTION_COUNT,
  });

  /**
   * ----------------------------------------------------------
   * ATTACKER
   * ----------------------------------------------------------
   */
  attackerVendor = await Vendor.create({
    name: `Completion Attacker ${TEST_RUN_ID}`,

    phoneNo: randomPhone(85),

    password: "test-password",

    type: "electrician",

    balance: 1000,

    pending: 0,

    completed: 0,

    canceled: 0,

    pendingVendor: 0,

    completedVendor: 0,

    canceledVendor: 0,
  });

  /**
   * ----------------------------------------------------------
   * BOOKING
   * ----------------------------------------------------------
   */
  booking = await Bookings.create({
    userId: customerVendor._id,

    vendorId: providerVendor._id,

    type: "electrician",

    pincode: "274201",

    bookingDate: BOOKING_DATE,

    bookedOn: new Date(),

    bookingTime: Date.now(),

    cancelOrder: false,

    orderCompleted: false,

    rating: 0,

    ratingPermission: false,
  });

  customerToken = createVendorToken(customerVendor);

  attackerToken = createVendorToken(attackerVendor);

  console.log({
    customerVendor: customerVendor._id.toString(),

    providerVendor: providerVendor._id.toString(),

    attackerVendor: attackerVendor._id.toString(),

    customerReferrer: customerReferrer._id.toString(),

    providerReferrer: providerReferrer._id.toString(),

    bookingId: booking._id.toString(),

    bookingDate: BOOKING_DATE,

    commission: COMMISSION,

    expectedReferralReward: EXPECTED_REFERRAL_REWARD,

    concurrency: CONCURRENCY,
  });
}

/**
 * ============================================================
 * LOAD COMPLETE STATE
 * ============================================================
 */

async function getState() {
  const [
    currentBooking,

    currentCustomer,

    currentProvider,

    currentAttacker,

    currentCustomerReferrer,

    currentProviderReferrer,
  ] = await Promise.all([
    Bookings.findById(booking._id).lean(),

    Vendor.findById(customerVendor._id).lean(),

    Vendor.findById(providerVendor._id).lean(),

    Vendor.findById(attackerVendor._id).lean(),

    Vendor.findById(customerReferrer._id).lean(),

    User.findById(providerReferrer._id).lean(),
  ]);

  if (!currentBooking) {
    throw new Error("Test booking disappeared");
  }

  if (!currentCustomer) {
    throw new Error("Customer Vendor disappeared");
  }

  if (!currentProvider) {
    throw new Error("Provider Vendor disappeared");
  }

  if (!currentCustomerReferrer) {
    throw new Error("Customer referrer disappeared");
  }

  if (!currentProviderReferrer) {
    throw new Error("Provider referrer disappeared");
  }

  return {
    booking: currentBooking,

    customer: currentCustomer,

    provider: currentProvider,

    attacker: currentAttacker,

    customerReferrer: currentCustomerReferrer,

    providerReferrer: currentProviderReferrer,
  };
}

/**
 * ============================================================
 * HTTP
 * ============================================================
 */

async function sendCompletionRequest({ token, index, label = "complete" }) {
  const requestId = `completion-financial-${TEST_RUN_ID}-${label}-${index}`;

  const start = Date.now();

  try {
    const response = await axios.patch(
      COMPLETE_API,

      {
        bookingId: booking._id.toString(),
      },

      {
        headers: {
          "Content-Type": "application/json",

          Authorization: `Bearer ${token}`,

          "x-request-id": requestId,
        },

        validateStatus: () => true,

        timeout: 15000,
      },
    );

    return {
      index,

      status: response.status,

      data: response.data,

      durationMs: Date.now() - start,
    };
  } catch (error) {
    return {
      index,

      status: "NETWORK_ERROR",

      error: error.message,

      durationMs: Date.now() - start,
    };
  }
}

/**
 * ============================================================
 * TEST 1
 * IDOR
 * ============================================================
 */

async function testIdor() {
  section("COMPLETION IDOR AUTHORIZATION");

  const before = await getState();

  const result = await sendCompletionRequest({
    token: attackerToken,

    index: 0,

    label: "attacker",
  });

  const after = await getState();

  assert(
    result.status === 403,
    `Attacker Vendor cannot complete another customer's booking [HTTP ${result.status}]`,
  );

  assert(Number(result.status) < 500, "Unauthorized completion does not produce HTTP 500");

  assert(after.booking.orderCompleted === false, "Unauthorized completion cannot complete booking");

  assert(after.booking.cancelOrder === false, "Unauthorized completion cannot cancel booking");

  assert(
    delta(before.customer.pending, after.customer.pending) === 0,
    "IDOR does not mutate customer pending",
  );

  assert(
    delta(before.customer.completed, after.customer.completed) === 0,
    "IDOR does not mutate customer completed",
  );

  assert(
    delta(before.provider.pendingVendor, after.provider.pendingVendor) === 0,
    "IDOR does not mutate provider pendingVendor",
  );

  assert(
    delta(before.provider.completedVendor, after.provider.completedVendor) === 0,
    "IDOR does not mutate provider completedVendor",
  );

  assert(
    delta(before.customerReferrer.earning, after.customerReferrer.earning) === 0,
    "IDOR cannot credit customer referrer earning",
  );

  assert(
    delta(before.providerReferrer.earning, after.providerReferrer.earning) === 0,
    "IDOR cannot credit provider referrer earning",
  );

  assert(
    delta(before.customerReferrer.completedShareBy, after.customerReferrer.completedShareBy) === 0,
    "IDOR cannot increment customer referrer completedShareBy",
  );

  assert(
    delta(before.providerReferrer.completedShareBy, after.providerReferrer.completedShareBy) === 0,
    "IDOR cannot increment provider referrer completedShareBy",
  );
}

/**
 * ============================================================
 * TEST 2
 * 100-WAY COMPLETION CONCURRENCY
 * ============================================================
 */

async function testConcurrency() {
  section(`${CONCURRENCY}-WAY COMPLETION CONCURRENCY`);

  const before = await getState();

  assert(
    before.booking.orderCompleted === false,
    "Booking is not completed before concurrency test",
  );

  assert(before.booking.cancelOrder === false, "Booking is not cancelled before concurrency test");

  assert(number(before.customer.pending) === 1, "Customer starts with exactly one pending booking");

  assert(
    number(before.provider.pendingVendor) === 1,
    "Provider starts with exactly one pendingVendor booking",
  );

  assert(number(before.customer.completed) === 5, "Customer starts with five completed bookings");

  assert(
    number(before.provider.completedVendor) === 5,
    "Provider starts with five completedVendor bookings",
  );

  assert(
    number(before.customerReferrer.pendingShareBy) === 1,
    "Customer referrer starts with one pendingShareBy",
  );

  assert(
    number(before.providerReferrer.pendingShareBy) === 1,
    "Provider referrer starts with one pendingShareBy",
  );

  console.log(`Sending ${CONCURRENCY} concurrent completion requests...`);

  const startedAt = Date.now();

  const requests = Array.from(
    {
      length: CONCURRENCY,
    },

    (_, index) =>
      sendCompletionRequest({
        token: customerToken,

        index,

        label: "race",
      }),
  );

  const results = await Promise.all(requests);

  const elapsedMs = Date.now() - startedAt;

  const successful = results.filter((result) => result.status === 200);

  const serverErrors = results.filter(
    (result) => typeof result.status === "number" && result.status >= 500,
  );

  const networkErrors = results.filter((result) => result.status === "NETWORK_ERROR");

  const statusCounts = {};

  for (const result of results) {
    const key = String(result.status);

    statusCounts[key] = (statusCounts[key] || 0) + 1;
  }

  console.log({
    elapsedMs,

    requests: results.length,

    successful: successful.length,

    serverErrors: serverErrors.length,

    networkErrors: networkErrors.length,

    statusCounts,
  });

  const after = await getState();

  /**
   * ----------------------------------------------------------
   * HTTP invariants
   * ----------------------------------------------------------
   */

  assert(results.length === CONCURRENCY, `Received results for all ${CONCURRENCY} requests`);

  assert(successful.length === 1, "Exactly one concurrent completion request succeeds");

  assert(serverErrors.length === 0, "Completion concurrency produces no HTTP 500 responses");

  assert(networkErrors.length === 0, "Completion concurrency produces no network errors");

  /**
   * ----------------------------------------------------------
   * Booking invariants
   * ----------------------------------------------------------
   */

  assert(after.booking.orderCompleted === true, "Booking becomes completed");

  assert(after.booking.cancelOrder === false, "Completed booking is not cancelled");

  /**
   * ----------------------------------------------------------
   * Customer accounting
   * ----------------------------------------------------------
   */

  assert(
    delta(before.customer.pending, after.customer.pending) === -1,
    "Customer pending decrements exactly once",
  );

  assert(
    delta(before.customer.completed, after.customer.completed) === 1,
    "Customer completed increments exactly once",
  );

  assert(
    delta(before.customer.canceled, after.customer.canceled) === 0,
    "Customer canceled remains unchanged",
  );

  assert(number(after.customer.pending) >= 0, "Customer pending never becomes negative");

  /**
   * Completion must NOT charge customer again.
   */
  assert(
    approximatelyEqual(before.customer.balance, after.customer.balance),
    "Completion does not mutate customer balance",
  );

  /**
   * ----------------------------------------------------------
   * Provider accounting
   * ----------------------------------------------------------
   */

  assert(
    delta(before.provider.pendingVendor, after.provider.pendingVendor) === -1,
    "Provider pendingVendor decrements exactly once",
  );

  assert(
    delta(before.provider.completedVendor, after.provider.completedVendor) === 1,
    "Provider completedVendor increments exactly once",
  );

  assert(
    delta(before.provider.canceledVendor, after.provider.canceledVendor) === 0,
    "Provider canceledVendor remains unchanged",
  );

  assert(
    number(after.provider.pendingVendor) >= 0,
    "Provider pendingVendor never becomes negative",
  );

  assert(
    approximatelyEqual(before.provider.balance, after.provider.balance),
    "Completion does not mutate provider balance",
  );

  /**
   * ----------------------------------------------------------
   * Customer referrer
   * ----------------------------------------------------------
   */

  assert(
    delta(before.customerReferrer.pendingShareBy, after.customerReferrer.pendingShareBy) === -1,
    "Customer referrer pendingShareBy decrements exactly once",
  );

  assert(
    delta(before.customerReferrer.completedShareBy, after.customerReferrer.completedShareBy) === 1,
    "Customer referrer completedShareBy increments exactly once",
  );

  assert(
    delta(before.customerReferrer.canceledShareBy, after.customerReferrer.canceledShareBy) === 0,
    "Customer referrer canceledShareBy remains unchanged",
  );

  assert(
    number(after.customerReferrer.pendingShareBy) >= 0,
    "Customer referrer pendingShareBy never becomes negative",
  );

  assert(
    approximatelyEqual(
      delta(before.customerReferrer.earning, after.customerReferrer.earning),

      EXPECTED_REFERRAL_REWARD,
    ),
    `Customer referrer earning increases exactly once by ${EXPECTED_REFERRAL_REWARD}`,
  );

  /**
   * Reward must go to earning, not balance.
   */
  assert(
    approximatelyEqual(before.customerReferrer.balance, after.customerReferrer.balance),
    "Customer referral reward does NOT mutate referrer balance",
  );

  /**
   * ----------------------------------------------------------
   * Provider referrer
   * ----------------------------------------------------------
   */

  assert(
    delta(before.providerReferrer.pendingShareBy, after.providerReferrer.pendingShareBy) === -1,
    "Provider referrer pendingShareBy decrements exactly once",
  );

  assert(
    delta(before.providerReferrer.completedShareBy, after.providerReferrer.completedShareBy) === 1,
    "Provider referrer completedShareBy increments exactly once",
  );

  assert(
    delta(before.providerReferrer.canceledShareBy, after.providerReferrer.canceledShareBy) === 0,
    "Provider referrer canceledShareBy remains unchanged",
  );

  assert(
    number(after.providerReferrer.pendingShareBy) >= 0,
    "Provider referrer pendingShareBy never becomes negative",
  );

  assert(
    approximatelyEqual(
      delta(before.providerReferrer.earning, after.providerReferrer.earning),

      EXPECTED_REFERRAL_REWARD,
    ),
    `Provider referrer earning increases exactly once by ${EXPECTED_REFERRAL_REWARD}`,
  );

  assert(
    approximatelyEqual(before.providerReferrer.balance, after.providerReferrer.balance),
    "Provider referral reward does NOT mutate referrer balance",
  );

  /**
   * ----------------------------------------------------------
   * Booking-count invariants
   * ----------------------------------------------------------
   */

  assert(
    delta(before.customer.bookingCount, after.customer.bookingCount) === 0,
    "Completion does not increment customer bookingCount again",
  );

  assert(
    delta(before.provider.bookingCountVendor, after.provider.bookingCountVendor) === 0,
    "Completion does not increment provider bookingCountVendor again",
  );

  return after;
}

/**
 * ============================================================
 * TEST 3
 * POST-COMPLETION REPLAY
 * ============================================================
 */

async function testReplay() {
  section("POST-COMPLETION REPLAY SAFETY");

  const before = await getState();

  const replayRequests = Array.from(
    {
      length: 10,
    },

    (_, index) =>
      sendCompletionRequest({
        token: customerToken,

        index,

        label: "replay",
      }),
  );

  const results = await Promise.all(replayRequests);

  const after = await getState();

  console.log({
    statuses: results.map((result) => result.status),
  });

  const successful = results.filter((result) => result.status === 200);

  const serverErrors = results.filter(
    (result) => typeof result.status === "number" && result.status >= 500,
  );

  const networkErrors = results.filter((result) => result.status === "NETWORK_ERROR");

  assert(successful.length === 0, "No completion replay request succeeds");

  assert(serverErrors.length === 0, "Completion replay produces no HTTP 500");

  assert(networkErrors.length === 0, "Completion replay produces no network errors");

  assert(after.booking.orderCompleted === true, "Booking remains completed after replay");

  assert(after.booking.cancelOrder === false, "Replay cannot cancel completed booking");

  /**
   * Customer counters
   */
  assert(
    delta(before.customer.pending, after.customer.pending) === 0,
    "Replay cannot decrement customer pending again",
  );

  assert(
    delta(before.customer.completed, after.customer.completed) === 0,
    "Replay cannot increment customer completed again",
  );

  /**
   * Provider counters
   */
  assert(
    delta(before.provider.pendingVendor, after.provider.pendingVendor) === 0,
    "Replay cannot decrement provider pendingVendor again",
  );

  assert(
    delta(before.provider.completedVendor, after.provider.completedVendor) === 0,
    "Replay cannot increment provider completedVendor again",
  );

  /**
   * Customer referrer
   */
  assert(
    delta(before.customerReferrer.pendingShareBy, after.customerReferrer.pendingShareBy) === 0,
    "Replay cannot decrement customer referrer pendingShareBy again",
  );

  assert(
    delta(before.customerReferrer.completedShareBy, after.customerReferrer.completedShareBy) === 0,
    "Replay cannot increment customer referrer completedShareBy again",
  );

  assert(
    approximatelyEqual(before.customerReferrer.earning, after.customerReferrer.earning),
    "Replay cannot credit customer referrer earning again",
  );

  /**
   * Provider referrer
   */
  assert(
    delta(before.providerReferrer.pendingShareBy, after.providerReferrer.pendingShareBy) === 0,
    "Replay cannot decrement provider referrer pendingShareBy again",
  );

  assert(
    delta(before.providerReferrer.completedShareBy, after.providerReferrer.completedShareBy) === 0,
    "Replay cannot increment provider referrer completedShareBy again",
  );

  assert(
    approximatelyEqual(before.providerReferrer.earning, after.providerReferrer.earning),
    "Replay cannot credit provider referrer earning again",
  );

  /**
   * Balances
   */
  assert(
    approximatelyEqual(before.customer.balance, after.customer.balance),
    "Replay cannot mutate customer balance",
  );

  assert(
    approximatelyEqual(before.provider.balance, after.provider.balance),
    "Replay cannot mutate provider balance",
  );

  assert(
    approximatelyEqual(before.customerReferrer.balance, after.customerReferrer.balance),
    "Replay cannot mutate customer referrer balance",
  );

  assert(
    approximatelyEqual(before.providerReferrer.balance, after.providerReferrer.balance),
    "Replay cannot mutate provider referrer balance",
  );
}

/**
 * ============================================================
 * FINAL INVARIANTS
 * ============================================================
 */

async function testFinalState() {
  section("FINAL DATABASE INVARIANTS");

  const state = await getState();

  assert(
    state.booking.orderCompleted === true && state.booking.cancelOrder === false,
    "Booking has exactly one valid terminal state: COMPLETED",
  );

  assert(number(state.customer.pending) === 0, "Customer pending is exactly zero");

  assert(number(state.customer.completed) === 6, "Customer completed is exactly six");

  assert(number(state.provider.pendingVendor) === 0, "Provider pendingVendor is exactly zero");

  assert(number(state.provider.completedVendor) === 6, "Provider completedVendor is exactly six");

  assert(
    number(state.customerReferrer.pendingShareBy) === 0,
    "Customer referrer pendingShareBy is exactly zero",
  );

  assert(
    number(state.customerReferrer.completedShareBy) === 11,
    "Customer referrer completedShareBy increments from 10 to 11",
  );

  assert(
    approximatelyEqual(state.customerReferrer.earning, 100 + EXPECTED_REFERRAL_REWARD),
    "Customer referrer receives exactly one referral reward",
  );

  assert(
    number(state.providerReferrer.pendingShareBy) === 0,
    "Provider referrer pendingShareBy is exactly zero",
  );

  assert(
    number(state.providerReferrer.completedShareBy) === 21,
    "Provider referrer completedShareBy increments from 20 to 21",
  );

  assert(
    approximatelyEqual(state.providerReferrer.earning, 200 + EXPECTED_REFERRAL_REWARD),
    "Provider referrer receives exactly one referral reward",
  );

  assert(
    number(state.customer.pending) >= 0 &&
      number(state.provider.pendingVendor) >= 0 &&
      number(state.customerReferrer.pendingShareBy) >= 0 &&
      number(state.providerReferrer.pendingShareBy) >= 0,
    "No pending counter becomes negative",
  );
}

/**
 * ============================================================
 * CLEANUP
 * ============================================================
 */

async function cleanup() {
  section("CLEANUP");

  if (!booking) {
    return;
  }

  const bookingIds = booking?._id ? [booking._id] : [];

  const vendorIds = [
    customerVendor?._id,

    providerVendor?._id,

    attackerVendor?._id,

    customerReferrer?._id,
  ].filter(Boolean);

  const userIds = [providerReferrer?._id].filter(Boolean);

  const [bookingResult, vendorResult, userResult] = await Promise.all([
    bookingIds.length
      ? Bookings.deleteMany({
          _id: {
            $in: bookingIds,
          },
        })
      : {
          deletedCount: 0,
        },

    vendorIds.length
      ? Vendor.deleteMany({
          _id: {
            $in: vendorIds,
          },
        })
      : {
          deletedCount: 0,
        },

    userIds.length
      ? User.deleteMany({
          _id: {
            $in: userIds,
          },
        })
      : {
          deletedCount: 0,
        },
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
  let exitCode = 0;

  try {
    await connectDatabase();

    section("VENDOR BOOKING COMPLETION FINANCIAL / REFERRAL INVARIANT E2E TEST");

    console.log({
      completeApi: COMPLETE_API,

      nodeEnv: process.env.NODE_ENV,

      concurrency: CONCURRENCY,

      bookingDate: BOOKING_DATE,

      commission: COMMISSION,

      expectedReferralReward: EXPECTED_REFERRAL_REWARD,
    });

    await createFixtures();

    await testIdor();

    await testConcurrency();

    await testReplay();

    await testFinalState();
  } catch (error) {
    exitCode = 1;

    section("TEST EXECUTION ERROR");

    console.error(error);
  } finally {
    try {
      await cleanup();
    } catch (cleanupError) {
      exitCode = 1;

      console.error("Cleanup failed:", cleanupError);
    }

    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();

      console.log("MongoDB disconnected.");
    }
  }

  section("FINAL COMPLETION FINANCIAL / REFERRAL TEST SUMMARY");

  console.log(`Assertions: ${assertions}`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);

  if (failed > 0 || exitCode !== 0) {
    console.error("");
    console.error("FAIL: BOOKING COMPLETION FINANCIAL / REFERRAL INVARIANTS FAILED");

    process.exit(1);
  }

  console.log("");
  console.log("PASS: BOOKING COMPLETION FINANCIAL / REFERRAL INVARIANTS PASSED");

  console.log(`
Verified:

✓ Unauthorized Vendor cannot complete another customer's booking
✓ IDOR cannot mutate accounting or referral state
✓ ${CONCURRENCY} concurrent completion requests produce exactly one success
✓ Booking completes exactly once
✓ Customer pending decrements exactly once
✓ Customer completed increments exactly once
✓ Provider pendingVendor decrements exactly once
✓ Provider completedVendor increments exactly once
✓ Customer referrer pendingShareBy decrements exactly once
✓ Customer referrer completedShareBy increments exactly once
✓ Provider referrer pendingShareBy decrements exactly once
✓ Provider referrer completedShareBy increments exactly once
✓ Customer referral earning is credited exactly once
✓ Provider referral earning is credited exactly once
✓ Referral reward goes to earning, not balance
✓ Completion does not charge customer/provider again
✓ Replay cannot double-credit referral earning
✓ Replay cannot mutate accounting twice
✓ Pending counters never become negative
✓ Concurrent completion produces no HTTP 500
✓ Concurrent completion produces no network errors
`);

  process.exit(0);
}

run();
