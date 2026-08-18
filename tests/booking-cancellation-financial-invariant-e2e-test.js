"use strict";

/**
 * ============================================================
 * BOOKING CANCELLATION FINANCIAL / REFERRAL INVARIANT E2E TEST
 * ============================================================
 *
 * Tests:
 *
 * 1. Cancellation authorization / IDOR protection
 * 2. Concurrent cancellation requests
 * 3. Exactly ONE cancellation succeeds
 * 4. Booking becomes cancelled exactly once
 * 5. Customer cancellation accounting changes exactly once
 * 6. Provider cancellation accounting changes exactly once
 * 7. Customer referrer cancellation accounting changes once
 * 8. Provider referrer cancellation accounting changes once
 * 9. Cancellation NEVER credits referral earning
 * 10. Cancellation NEVER mutates balances
 * 11. Replay cannot mutate accounting twice
 * 12. Pending counters never become negative
 *
 * Expected cancellation transition:
 *
 * Booking:
 *   cancelOrder     false -> true
 *   orderCompleted  remains false
 *
 * Customer:
 *   pending         -1
 *   canceled        +1
 *
 * Provider:
 *   pendingVendor   -1
 *   canceledVendor  +1
 *
 * Customer Referrer:
 *   pendingShareBy   -1
 *   canceledShareBy  +1
 *   earning           unchanged
 *
 * Provider Referrer:
 *   pendingShareBy   -1
 *   canceledShareBy  +1
 *   earning           unchanged
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

const CANCEL_API = `${API_BASE}/bookings/cancelOrderV`;

const CONCURRENCY = Number(process.env.TEST_CANCELLATION_CONCURRENCY || 100);

const REPLAY_COUNT = Number(process.env.TEST_CANCELLATION_REPLAY_COUNT || 10);

/**
 * Use yesterday so the test is independent of any
 * future-date restrictions that may exist elsewhere.
 */
const yesterday = new Date();

yesterday.setDate(yesterday.getDate() - 1);

const BOOKING_DATE = yesterday.toDateString();

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
  const suffix = String(Math.floor(Math.random() * 100000000)).padStart(8, "0");

  return Number(`${prefix}${suffix}`);
}

function createVendorToken(vendor) {
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
 * DATABASE
 * ============================================================
 */

async function connectDatabase() {
  if (mongoose.connection.readyState === 1) {
    return;
  }

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
 * FIXTURES
 * ============================================================
 */

async function createFixtures() {
  section("CREATE TEST FIXTURES");

  /**
   * Customer referrer.
   *
   * pendingShareBy = 1 because our booking already exists
   * in pending state.
   */
  customerReferrer = await Vendor.create({
    name: `Cancellation Customer Referrer ${TEST_RUN_ID}`,

    phoneNo: randomPhone(81),

    password: "test-password",

    type: "electrician",

    balance: 500,

    earning: 100,

    pendingShareBy: 1,

    completedShareBy: 10,

    canceledShareBy: 4,
  });

  /**
   * Provider referrer.
   */
  providerReferrer = await User.create({
    name: `Cancellation Provider Referrer ${TEST_RUN_ID}`,

    phoneNo: randomPhone(82),

    password: "test-password",

    balance: 700,

    earning: 200,

    pendingShareBy: 1,

    completedShareBy: 20,

    canceledShareBy: 8,
  });

  /**
   * Customer Vendor.
   *
   * shareBy -> Vendor collection.
   */
  customerVendor = await Vendor.create({
    name: `Cancellation Customer ${TEST_RUN_ID}`,

    phoneNo: randomPhone(83),

    password: "test-password",

    type: "electrician",

    balance: 10000,

    pending: 1,

    completed: 5,

    canceled: 5,

    bookingCount: 11,

    shareBy: customerReferrer._id.toString(),

    cd: "vendor",

    totalDiscount: 0,

    transactionCount: 0,
  });

  /**
   * Provider Vendor.
   *
   * shareBy -> User collection.
   */
  providerVendor = await Vendor.create({
    name: `Cancellation Provider ${TEST_RUN_ID}`,

    phoneNo: randomPhone(84),

    password: "test-password",

    type: "electrician",

    balance: 10000,

    commission: 100,

    pendingVendor: 1,

    completedVendor: 7,

    canceledVendor: 7,

    bookingCountVendor: 15,

    shareBy: providerReferrer._id.toString(),

    cd: "user",

    totalDiscount: 0,

    transactionCount: 0,
  });

  /**
   * Unauthorized attacker.
   */
  attackerVendor = await Vendor.create({
    name: `Cancellation Attacker ${TEST_RUN_ID}`,

    phoneNo: randomPhone(85),

    password: "test-password",

    type: "electrician",

    balance: 1000,

    pending: 0,

    completed: 0,

    canceled: 0,

    bookingCount: 0,

    pendingVendor: 0,

    completedVendor: 0,

    canceledVendor: 0,

    bookingCountVendor: 0,
  });

  /**
   * Active booking.
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

    concurrency: CONCURRENCY,

    replayCount: REPLAY_COUNT,
  });
}

/**
 * ============================================================
 * DATABASE SNAPSHOT
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

  if (!currentAttacker) {
    throw new Error("Attacker Vendor disappeared");
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

async function sendCancellationRequest({ token, index, label = "cancel" }) {
  const requestId = `cancellation-financial-${TEST_RUN_ID}-${label}-${index}`;

  const start = Date.now();

  try {
    const response = await axios.patch(
      CANCEL_API,

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

      requestId,

      status: response.status,

      data: response.data,

      durationMs: Date.now() - start,
    };
  } catch (error) {
    return {
      index,

      requestId,

      status: "NETWORK_ERROR",

      error: error.message,

      durationMs: Date.now() - start,
    };
  }
}

/**
 * ============================================================
 * TEST 1
 * CANCELLATION IDOR
 * ============================================================
 */

async function testIdor() {
  section("CANCELLATION IDOR AUTHORIZATION");

  const before = await getState();

  const result = await sendCancellationRequest({
    token: attackerToken,

    index: 0,

    label: "attacker",
  });

  const after = await getState();

  console.log({
    status: result.status,

    data: result.data,
  });

  assert(
    result.status === 403,
    `Attacker Vendor cannot cancel another customer's booking [HTTP ${result.status}]`,
  );

  assert(Number(result.status) < 500, "Unauthorized cancellation does not produce HTTP 500");

  assert(result.status !== "NETWORK_ERROR", "Unauthorized cancellation produces no network error");

  /**
   * Booking.
   */
  assert(after.booking.cancelOrder === false, "Unauthorized cancellation cannot cancel booking");

  assert(
    after.booking.orderCompleted === false,
    "Unauthorized cancellation cannot complete booking",
  );

  /**
   * Customer.
   */
  assert(
    delta(before.customer.pending, after.customer.pending) === 0,
    "IDOR does not mutate customer pending",
  );

  assert(
    delta(before.customer.canceled, after.customer.canceled) === 0,
    "IDOR does not mutate customer canceled",
  );

  assert(
    delta(before.customer.completed, after.customer.completed) === 0,
    "IDOR does not mutate customer completed",
  );

  assert(
    delta(before.customer.bookingCount, after.customer.bookingCount) === 0,
    "IDOR does not mutate customer bookingCount",
  );

  assert(
    approximatelyEqual(before.customer.balance, after.customer.balance),
    "IDOR does not mutate customer balance",
  );

  /**
   * Provider.
   */
  assert(
    delta(before.provider.pendingVendor, after.provider.pendingVendor) === 0,
    "IDOR does not mutate provider pendingVendor",
  );

  assert(
    delta(before.provider.canceledVendor, after.provider.canceledVendor) === 0,
    "IDOR does not mutate provider canceledVendor",
  );

  assert(
    delta(before.provider.completedVendor, after.provider.completedVendor) === 0,
    "IDOR does not mutate provider completedVendor",
  );

  assert(
    delta(before.provider.bookingCountVendor, after.provider.bookingCountVendor) === 0,
    "IDOR does not mutate provider bookingCountVendor",
  );

  assert(
    approximatelyEqual(before.provider.balance, after.provider.balance),
    "IDOR does not mutate provider balance",
  );

  /**
   * Customer referrer.
   */
  assert(
    delta(before.customerReferrer.pendingShareBy, after.customerReferrer.pendingShareBy) === 0,
    "IDOR does not mutate customer referrer pendingShareBy",
  );

  assert(
    delta(before.customerReferrer.canceledShareBy, after.customerReferrer.canceledShareBy) === 0,
    "IDOR does not mutate customer referrer canceledShareBy",
  );

  assert(
    delta(before.customerReferrer.completedShareBy, after.customerReferrer.completedShareBy) === 0,
    "IDOR does not mutate customer referrer completedShareBy",
  );

  assert(
    approximatelyEqual(before.customerReferrer.earning, after.customerReferrer.earning),
    "IDOR cannot mutate customer referrer earning",
  );

  /**
   * Provider referrer.
   */
  assert(
    delta(before.providerReferrer.pendingShareBy, after.providerReferrer.pendingShareBy) === 0,
    "IDOR does not mutate provider referrer pendingShareBy",
  );

  assert(
    delta(before.providerReferrer.canceledShareBy, after.providerReferrer.canceledShareBy) === 0,
    "IDOR does not mutate provider referrer canceledShareBy",
  );

  assert(
    delta(before.providerReferrer.completedShareBy, after.providerReferrer.completedShareBy) === 0,
    "IDOR does not mutate provider referrer completedShareBy",
  );

  assert(
    approximatelyEqual(before.providerReferrer.earning, after.providerReferrer.earning),
    "IDOR cannot mutate provider referrer earning",
  );
}

/**
 * ============================================================
 * TEST 2
 * CANCELLATION CONCURRENCY
 * ============================================================
 */

async function testConcurrency() {
  section(`${CONCURRENCY}-WAY CANCELLATION CONCURRENCY`);

  const before = await getState();

  /**
   * Precondition invariants.
   */
  assert(before.booking.cancelOrder === false, "Booking is not cancelled before concurrency test");

  assert(
    before.booking.orderCompleted === false,
    "Booking is not completed before concurrency test",
  );

  assert(number(before.customer.pending) === 1, "Customer starts with exactly one pending booking");

  assert(
    number(before.provider.pendingVendor) === 1,
    "Provider starts with exactly one pendingVendor booking",
  );

  assert(
    number(before.customerReferrer.pendingShareBy) === 1,
    "Customer referrer starts with exactly one pendingShareBy",
  );

  assert(
    number(before.providerReferrer.pendingShareBy) === 1,
    "Provider referrer starts with exactly one pendingShareBy",
  );

  console.log(`Sending ${CONCURRENCY} concurrent cancellation requests...`);

  const startedAt = Date.now();

  const results = await Promise.all(
    Array.from(
      {
        length: CONCURRENCY,
      },

      (_, index) =>
        sendCancellationRequest({
          token: customerToken,

          index,

          label: "race",
        }),
    ),
  );

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

  if (serverErrors.length > 0) {
    console.log("FIRST SERVER ERROR:");

    console.dir(serverErrors[0], {
      depth: null,
    });
  }

  const after = await getState();

  /**
   * ----------------------------------------------------------
   * HTTP invariants
   * ----------------------------------------------------------
   */

  assert(results.length === CONCURRENCY, `Received results for all ${CONCURRENCY} requests`);

  assert(successful.length === 1, "Exactly one concurrent cancellation request succeeds");

  assert(serverErrors.length === 0, "Cancellation concurrency produces no HTTP 500 responses");

  assert(networkErrors.length === 0, "Cancellation concurrency produces no network errors");

  /**
   * ----------------------------------------------------------
   * Booking invariants
   * ----------------------------------------------------------
   */

  assert(after.booking.cancelOrder === true, "Booking becomes cancelled");

  assert(after.booking.orderCompleted === false, "Cancelled booking is not completed");

  assert(
    after.booking.cancelOrder !== after.booking.orderCompleted,
    "Booking has exactly one terminal state",
  );

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
    delta(before.customer.canceled, after.customer.canceled) === 1,
    "Customer canceled increments exactly once",
  );

  assert(
    delta(before.customer.completed, after.customer.completed) === 0,
    "Customer completed remains unchanged",
  );

  assert(number(after.customer.pending) >= 0, "Customer pending never becomes negative");

  assert(
    approximatelyEqual(before.customer.balance, after.customer.balance),
    "Cancellation does not mutate customer balance",
  );

  assert(
    delta(before.customer.bookingCount, after.customer.bookingCount) === 0,
    "Cancellation does not mutate customer bookingCount",
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
    delta(before.provider.canceledVendor, after.provider.canceledVendor) === 1,
    "Provider canceledVendor increments exactly once",
  );

  assert(
    delta(before.provider.completedVendor, after.provider.completedVendor) === 0,
    "Provider completedVendor remains unchanged",
  );

  assert(
    number(after.provider.pendingVendor) >= 0,
    "Provider pendingVendor never becomes negative",
  );

  assert(
    approximatelyEqual(before.provider.balance, after.provider.balance),
    "Cancellation does not mutate provider balance",
  );

  assert(
    delta(before.provider.bookingCountVendor, after.provider.bookingCountVendor) === 0,
    "Cancellation does not mutate provider bookingCountVendor",
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
    delta(before.customerReferrer.canceledShareBy, after.customerReferrer.canceledShareBy) === 1,
    "Customer referrer canceledShareBy increments exactly once",
  );

  assert(
    delta(before.customerReferrer.completedShareBy, after.customerReferrer.completedShareBy) === 0,
    "Customer referrer completedShareBy remains unchanged",
  );

  assert(
    number(after.customerReferrer.pendingShareBy) >= 0,
    "Customer referrer pendingShareBy never becomes negative",
  );

  /**
   * Cancellation must NEVER credit referral earning.
   */
  assert(
    approximatelyEqual(before.customerReferrer.earning, after.customerReferrer.earning),
    "Cancellation does not credit customer referrer earning",
  );

  assert(
    approximatelyEqual(before.customerReferrer.balance, after.customerReferrer.balance),
    "Cancellation does not mutate customer referrer balance",
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
    delta(before.providerReferrer.canceledShareBy, after.providerReferrer.canceledShareBy) === 1,
    "Provider referrer canceledShareBy increments exactly once",
  );

  assert(
    delta(before.providerReferrer.completedShareBy, after.providerReferrer.completedShareBy) === 0,
    "Provider referrer completedShareBy remains unchanged",
  );

  assert(
    number(after.providerReferrer.pendingShareBy) >= 0,
    "Provider referrer pendingShareBy never becomes negative",
  );

  assert(
    approximatelyEqual(before.providerReferrer.earning, after.providerReferrer.earning),
    "Cancellation does not credit provider referrer earning",
  );

  assert(
    approximatelyEqual(before.providerReferrer.balance, after.providerReferrer.balance),
    "Cancellation does not mutate provider referrer balance",
  );

  return after;
}

/**
 * ============================================================
 * TEST 3
 * POST-CANCELLATION REPLAY
 * ============================================================
 */

async function testReplay() {
  section("POST-CANCELLATION REPLAY SAFETY");

  const before = await getState();

  const results = await Promise.all(
    Array.from(
      {
        length: REPLAY_COUNT,
      },

      (_, index) =>
        sendCancellationRequest({
          token: customerToken,

          index,

          label: "replay",
        }),
    ),
  );

  const after = await getState();

  console.log({
    statuses: results.map((result) => result.status),
  });

  const successful = results.filter((result) => result.status === 200);

  const serverErrors = results.filter(
    (result) => typeof result.status === "number" && result.status >= 500,
  );

  const networkErrors = results.filter((result) => result.status === "NETWORK_ERROR");

  assert(successful.length === 0, "No cancellation replay request succeeds");

  assert(serverErrors.length === 0, "Cancellation replay produces no HTTP 500");

  assert(networkErrors.length === 0, "Cancellation replay produces no network errors");

  /**
   * Booking.
   */
  assert(after.booking.cancelOrder === true, "Booking remains cancelled after replay");

  assert(after.booking.orderCompleted === false, "Replay cannot complete cancelled booking");

  /**
   * Customer.
   */
  assert(
    delta(before.customer.pending, after.customer.pending) === 0,
    "Replay cannot decrement customer pending again",
  );

  assert(
    delta(before.customer.canceled, after.customer.canceled) === 0,
    "Replay cannot increment customer canceled again",
  );

  assert(
    delta(before.customer.completed, after.customer.completed) === 0,
    "Replay cannot mutate customer completed",
  );

  assert(
    delta(before.customer.bookingCount, after.customer.bookingCount) === 0,
    "Replay cannot mutate customer bookingCount",
  );

  assert(
    approximatelyEqual(before.customer.balance, after.customer.balance),
    "Replay cannot mutate customer balance",
  );

  /**
   * Provider.
   */
  assert(
    delta(before.provider.pendingVendor, after.provider.pendingVendor) === 0,
    "Replay cannot decrement provider pendingVendor again",
  );

  assert(
    delta(before.provider.canceledVendor, after.provider.canceledVendor) === 0,
    "Replay cannot increment provider canceledVendor again",
  );

  assert(
    delta(before.provider.completedVendor, after.provider.completedVendor) === 0,
    "Replay cannot mutate provider completedVendor",
  );

  assert(
    delta(before.provider.bookingCountVendor, after.provider.bookingCountVendor) === 0,
    "Replay cannot mutate provider bookingCountVendor",
  );

  assert(
    approximatelyEqual(before.provider.balance, after.provider.balance),
    "Replay cannot mutate provider balance",
  );

  /**
   * Customer referrer.
   */
  assert(
    delta(before.customerReferrer.pendingShareBy, after.customerReferrer.pendingShareBy) === 0,
    "Replay cannot decrement customer referrer pendingShareBy again",
  );

  assert(
    delta(before.customerReferrer.canceledShareBy, after.customerReferrer.canceledShareBy) === 0,
    "Replay cannot increment customer referrer canceledShareBy again",
  );

  assert(
    delta(before.customerReferrer.completedShareBy, after.customerReferrer.completedShareBy) === 0,
    "Replay cannot mutate customer referrer completedShareBy",
  );

  assert(
    approximatelyEqual(before.customerReferrer.earning, after.customerReferrer.earning),
    "Replay cannot mutate customer referrer earning",
  );

  assert(
    approximatelyEqual(before.customerReferrer.balance, after.customerReferrer.balance),
    "Replay cannot mutate customer referrer balance",
  );

  /**
   * Provider referrer.
   */
  assert(
    delta(before.providerReferrer.pendingShareBy, after.providerReferrer.pendingShareBy) === 0,
    "Replay cannot decrement provider referrer pendingShareBy again",
  );

  assert(
    delta(before.providerReferrer.canceledShareBy, after.providerReferrer.canceledShareBy) === 0,
    "Replay cannot increment provider referrer canceledShareBy again",
  );

  assert(
    delta(before.providerReferrer.completedShareBy, after.providerReferrer.completedShareBy) === 0,
    "Replay cannot mutate provider referrer completedShareBy",
  );

  assert(
    approximatelyEqual(before.providerReferrer.earning, after.providerReferrer.earning),
    "Replay cannot mutate provider referrer earning",
  );

  assert(
    approximatelyEqual(before.providerReferrer.balance, after.providerReferrer.balance),
    "Replay cannot mutate provider referrer balance",
  );

  /**
   * Non-negative invariants.
   */
  assert(number(after.customer.pending) >= 0, "Customer pending remains non-negative after replay");

  assert(
    number(after.provider.pendingVendor) >= 0,
    "Provider pendingVendor remains non-negative after replay",
  );

  assert(
    number(after.customerReferrer.pendingShareBy) >= 0,
    "Customer referrer pendingShareBy remains non-negative after replay",
  );

  assert(
    number(after.providerReferrer.pendingShareBy) >= 0,
    "Provider referrer pendingShareBy remains non-negative after replay",
  );
}

/**
 * ============================================================
 * FINAL DATABASE INVARIANTS
 * ============================================================
 */

async function testFinalState() {
  section("FINAL DATABASE INVARIANTS");

  const state = await getState();

  /**
   * Booking.
   */
  assert(
    state.booking.cancelOrder === true && state.booking.orderCompleted === false,
    "Booking has exactly one valid terminal state: CANCELLED",
  );

  /**
   * Customer.
   */
  assert(number(state.customer.pending) === 0, "Customer pending is exactly zero");

  assert(number(state.customer.canceled) === 6, "Customer canceled increments from 5 to 6");

  assert(number(state.customer.completed) === 5, "Customer completed remains exactly five");

  assert(number(state.customer.bookingCount) === 11, "Customer bookingCount remains unchanged");

  assert(approximatelyEqual(state.customer.balance, 10000), "Customer balance remains unchanged");

  /**
   * Provider.
   */
  assert(number(state.provider.pendingVendor) === 0, "Provider pendingVendor is exactly zero");

  assert(
    number(state.provider.canceledVendor) === 8,
    "Provider canceledVendor increments from 7 to 8",
  );

  assert(
    number(state.provider.completedVendor) === 7,
    "Provider completedVendor remains exactly seven",
  );

  assert(
    number(state.provider.bookingCountVendor) === 15,
    "Provider bookingCountVendor remains unchanged",
  );

  assert(approximatelyEqual(state.provider.balance, 10000), "Provider balance remains unchanged");

  /**
   * Customer referrer.
   */
  assert(
    number(state.customerReferrer.pendingShareBy) === 0,
    "Customer referrer pendingShareBy is exactly zero",
  );

  assert(
    number(state.customerReferrer.canceledShareBy) === 5,
    "Customer referrer canceledShareBy increments from 4 to 5",
  );

  assert(
    number(state.customerReferrer.completedShareBy) === 10,
    "Customer referrer completedShareBy remains unchanged",
  );

  assert(
    approximatelyEqual(state.customerReferrer.earning, 100),
    "Customer referrer earning remains unchanged",
  );

  assert(
    approximatelyEqual(state.customerReferrer.balance, 500),
    "Customer referrer balance remains unchanged",
  );

  /**
   * Provider referrer.
   */
  assert(
    number(state.providerReferrer.pendingShareBy) === 0,
    "Provider referrer pendingShareBy is exactly zero",
  );

  assert(
    number(state.providerReferrer.canceledShareBy) === 9,
    "Provider referrer canceledShareBy increments from 8 to 9",
  );

  assert(
    number(state.providerReferrer.completedShareBy) === 20,
    "Provider referrer completedShareBy remains unchanged",
  );

  assert(
    approximatelyEqual(state.providerReferrer.earning, 200),
    "Provider referrer earning remains unchanged",
  );

  assert(
    approximatelyEqual(state.providerReferrer.balance, 700),
    "Provider referrer balance remains unchanged",
  );

  /**
   * Global pending invariant.
   */
  assert(
    number(state.customer.pending) >= 0 &&
      number(state.provider.pendingVendor) >= 0 &&
      number(state.customerReferrer.pendingShareBy) >= 0 &&
      number(state.providerReferrer.pendingShareBy) >= 0,
    "No pending counter becomes negative",
  );

  /**
   * Attacker must remain completely untouched.
   */
  assert(
    number(state.attacker.pending) === 0 &&
      number(state.attacker.completed) === 0 &&
      number(state.attacker.canceled) === 0,
    "Attacker customer counters remain untouched",
  );

  assert(
    number(state.attacker.pendingVendor) === 0 &&
      number(state.attacker.completedVendor) === 0 &&
      number(state.attacker.canceledVendor) === 0,
    "Attacker provider counters remain untouched",
  );
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

    section("VENDOR BOOKING CANCELLATION FINANCIAL / REFERRAL INVARIANT E2E TEST");

    console.log({
      cancelApi: CANCEL_API,

      nodeEnv: process.env.NODE_ENV,

      concurrency: CONCURRENCY,

      replayCount: REPLAY_COUNT,

      bookingDate: BOOKING_DATE,
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

  section("FINAL CANCELLATION FINANCIAL / REFERRAL TEST SUMMARY");

  console.log(`Assertions: ${assertions}`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);

  if (failed > 0 || exitCode !== 0) {
    console.error("");

    console.error("FAIL: BOOKING CANCELLATION FINANCIAL / REFERRAL INVARIANTS FAILED");

    process.exit(1);
  }

  console.log("");

  console.log("PASS: BOOKING CANCELLATION FINANCIAL / REFERRAL INVARIANTS PASSED");

  console.log(`
Verified:

✓ Unauthorized Vendor cannot cancel another customer's booking
✓ IDOR cannot mutate accounting or referral state
✓ ${CONCURRENCY} concurrent cancellation requests produce exactly one success
✓ Booking cancels exactly once
✓ Cancelled booking cannot simultaneously become completed
✓ Customer pending decrements exactly once
✓ Customer canceled increments exactly once
✓ Customer completed remains unchanged
✓ Provider pendingVendor decrements exactly once
✓ Provider canceledVendor increments exactly once
✓ Provider completedVendor remains unchanged
✓ Customer referrer pendingShareBy decrements exactly once
✓ Customer referrer canceledShareBy increments exactly once
✓ Provider referrer pendingShareBy decrements exactly once
✓ Provider referrer canceledShareBy increments exactly once
✓ Cancellation never credits referral earning
✓ Cancellation does not mutate customer/provider balances
✓ Cancellation does not mutate referrer balances
✓ Cancellation does not mutate booking counts
✓ Replay cannot perform cancellation twice
✓ Replay cannot mutate accounting twice
✓ Replay cannot mutate referral accounting twice
✓ Pending counters never become negative
✓ Concurrent cancellation produces no HTTP 500
✓ Concurrent cancellation produces no network errors
`);

  process.exit(0);
}

run();
