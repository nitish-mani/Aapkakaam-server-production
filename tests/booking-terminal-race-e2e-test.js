"use strict";

/**
 * ============================================================
 * BOOKING TERMINAL STATE RACE E2E TEST
 * ============================================================
 *
 * Races:
 *
 *   50 x COMPLETE
 *   50 x CANCEL
 *
 * against the SAME active Vendor-as-customer booking.
 *
 * Core invariant:
 *
 *   successfulCompletes + successfulCancels === 1
 *
 * Exactly one terminal transition may commit.
 *
 * If COMPLETE wins:
 *
 *   booking.orderCompleted = true
 *   booking.cancelOrder = false
 *
 *   customer.pending       -1
 *   customer.completed     +1
 *   customer.canceled       0
 *
 *   provider.pendingVendor   -1
 *   provider.completedVendor +1
 *   provider.canceledVendor   0
 *
 *   referrer.pendingShareBy   -1
 *   referrer.completedShareBy +1
 *   referrer.canceledShareBy   0
 *   referrer.earning          +reward
 *
 *
 * If CANCEL wins:
 *
 *   booking.cancelOrder = true
 *   booking.orderCompleted = false
 *
 *   customer.pending       -1
 *   customer.canceled      +1
 *   customer.completed      0
 *
 *   provider.pendingVendor   -1
 *   provider.canceledVendor  +1
 *   provider.completedVendor  0
 *
 *   referrer.pendingShareBy  -1
 *   referrer.canceledShareBy +1
 *   referrer.completedShareBy 0
 *   referrer.earning          0
 *
 *
 * Additionally verifies:
 *
 * - IDOR protection
 * - no HTTP 500 during race
 * - no network errors
 * - booking can never become COMPLETED + CANCELLED
 * - pending counters never become negative
 * - balances never change during terminal transition
 * - booking counts never change
 * - replay cannot mutate accounting
 * - losing operation cannot later change terminal state
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
 * SAFETY
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
 * CONFIG
 * ============================================================
 */

const API_BASE = process.env.TEST_API_BASE || "http://localhost:3000/api";

const COMPLETE_API = `${API_BASE}/bookings/orderCompletedV`;

const CANCEL_API = `${API_BASE}/bookings/cancelOrderV`;

const CONCURRENCY = Number(process.env.TEST_TERMINAL_CONCURRENCY || 100);

if (!Number.isInteger(CONCURRENCY) || CONCURRENCY < 2) {
  throw new Error("TEST_TERMINAL_CONCURRENCY must be an integer >= 2");
}

const COMPLETE_REQUESTS = Math.floor(CONCURRENCY / 2);

const CANCEL_REQUESTS = CONCURRENCY - COMPLETE_REQUESTS;

const REPLAY_COUNT = Number(process.env.TEST_TERMINAL_REPLAY_COUNT || 10);

const COMMISSION = Number(process.env.TEST_PROVIDER_COMMISSION || 100);

/**
 * Keep discount deterministic.
 */
const TOTAL_DISCOUNT = 0;
const TRANSACTION_COUNT = 0;

const EXPECTED_DISCOUNT_MULTIPLIER = 1;

const EXPECTED_REFERRAL_REWARD = COMMISSION * 0.05 * EXPECTED_DISCOUNT_MULTIPLIER;

/**
 * Both cancellation and completion must be allowed.
 *
 * Completion requires:
 *
 * Date.now() > bookingDate
 *
 * Therefore use yesterday.
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

let winningState = null;

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

function assertEqual(actual, expected, message) {
  assert(actual === expected, `${message} [expected=${expected}, actual=${actual}]`);
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
 * DATABASE CONNECTION
 * ============================================================
 */

async function connectDatabase() {
  if (mongoose.connection.readyState === 1) {
    return;
  }

  const mongoUri =
    ENV.MONGODB_URI ||
    ENV.MONGO_URI ||
    ENV.DB_URL ||
    ENV.MONGODB_URL ||
    process.env.MONGODB_URI ||
    process.env.MONGO_URI ||
    process.env.DB_URL ||
    process.env.MONGODB_URL;

  if (!mongoUri) {
    throw new Error(
      "MongoDB URI not found. Expected MONGODB_URI, MONGO_URI, DB_URL, or MONGODB_URL.",
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
   * Vendor because customer.cd = vendor.
   */
  customerReferrer = await Vendor.create({
    name: `Terminal Race Customer Referrer ${TEST_RUN_ID}`,

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
   *
   * User because provider.cd = user.
   */
  providerReferrer = await User.create({
    name: `Terminal Race Provider Referrer ${TEST_RUN_ID}`,

    phoneNo: randomPhone(82),

    password: "test-password",

    balance: 700,

    earning: 200,

    pendingShareBy: 1,

    completedShareBy: 20,

    canceledShareBy: 8,
  });

  /**
   * Vendor acting as customer.
   *
   * completed=5 makes next completion
   * reward eligible.
   */
  customerVendor = await Vendor.create({
    name: `Terminal Race Customer ${TEST_RUN_ID}`,

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

    totalDiscount: TOTAL_DISCOUNT,

    transactionCount: TRANSACTION_COUNT,
  });

  /**
   * Service provider.
   */
  providerVendor = await Vendor.create({
    name: `Terminal Race Provider ${TEST_RUN_ID}`,

    phoneNo: randomPhone(84),

    password: "test-password",

    type: "electrician",

    balance: 10000,

    commission: COMMISSION,

    pendingVendor: 1,

    completedVendor: 5,

    canceledVendor: 7,

    bookingCountVendor: 13,

    shareBy: providerReferrer._id.toString(),

    cd: "user",

    totalDiscount: TOTAL_DISCOUNT,

    transactionCount: TRANSACTION_COUNT,
  });

  /**
   * Unauthorized attacker.
   */
  attackerVendor = await Vendor.create({
    name: `Terminal Race Attacker ${TEST_RUN_ID}`,

    phoneNo: randomPhone(85),

    password: "test-password",

    type: "electrician",

    balance: 3000,

    pending: 2,

    completed: 3,

    canceled: 4,

    bookingCount: 9,

    pendingVendor: 2,

    completedVendor: 3,

    canceledVendor: 4,

    bookingCountVendor: 9,
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

    completeRequests: COMPLETE_REQUESTS,

    cancelRequests: CANCEL_REQUESTS,

    expectedReferralReward: EXPECTED_REFERRAL_REWARD,
  });
}

/**
 * ============================================================
 * STATE SNAPSHOT
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
    throw new Error("Customer disappeared");
  }

  if (!currentProvider) {
    throw new Error("Provider disappeared");
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
 * HTTP HELPERS
 * ============================================================
 */

async function sendRequest({ operation, token, index, label }) {
  const url = operation === "complete" ? COMPLETE_API : CANCEL_API;

  const requestId = `terminal-race-${TEST_RUN_ID}-${label}-${operation}-${index}`;

  const start = Date.now();

  try {
    /**
     * Your existing completion test uses PATCH.
     *
     * Cancellation controller in your previous tests
     * also accepts the same terminal request shape.
     */
    const response = await axios.patch(
      url,

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
      operation,
      index,
      requestId,

      status: response.status,

      data: response.data,

      durationMs: Date.now() - start,
    };
  } catch (error) {
    return {
      operation,
      index,
      requestId,

      status: "NETWORK_ERROR",

      error: error.message,

      durationMs: Date.now() - start,
    };
  }
}

function isSuccess(result) {
  return typeof result.status === "number" && result.status >= 200 && result.status < 300;
}

/**
 * ============================================================
 * TEST 1
 * TERMINAL AUTHORIZATION
 * ============================================================
 */

async function testAuthorization() {
  section("TERMINAL TRANSITION IDOR AUTHORIZATION");

  const before = await getState();

  const cancelResult = await sendRequest({
    operation: "cancel",

    token: attackerToken,

    index: 0,

    label: "idor",
  });

  const completeResult = await sendRequest({
    operation: "complete",

    token: attackerToken,

    index: 1,

    label: "idor",
  });

  console.log({
    cancelStatus: cancelResult.status,

    completeStatus: completeResult.status,
  });

  const after = await getState();

  assertEqual(cancelResult.status, 403, "Attacker Vendor cannot cancel another customer's booking");

  assertEqual(
    completeResult.status,
    403,
    "Attacker Vendor cannot complete another customer's booking",
  );

  assert(Number(cancelResult.status) < 500, "Unauthorized cancellation does not produce HTTP 500");

  assert(Number(completeResult.status) < 500, "Unauthorized completion does not produce HTTP 500");

  assertEqual(after.booking.cancelOrder, false, "IDOR cannot cancel booking");

  assertEqual(after.booking.orderCompleted, false, "IDOR cannot complete booking");

  assertEqual(
    delta(before.customer.pending, after.customer.pending),
    0,
    "IDOR cannot mutate customer pending",
  );

  assertEqual(
    delta(before.customer.completed, after.customer.completed),
    0,
    "IDOR cannot mutate customer completed",
  );

  assertEqual(
    delta(before.customer.canceled, after.customer.canceled),
    0,
    "IDOR cannot mutate customer canceled",
  );

  assertEqual(
    delta(before.provider.pendingVendor, after.provider.pendingVendor),
    0,
    "IDOR cannot mutate provider pendingVendor",
  );

  assertEqual(
    delta(before.provider.completedVendor, after.provider.completedVendor),
    0,
    "IDOR cannot mutate provider completedVendor",
  );

  assertEqual(
    delta(before.provider.canceledVendor, after.provider.canceledVendor),
    0,
    "IDOR cannot mutate provider canceledVendor",
  );

  assertEqual(
    delta(before.customerReferrer.pendingShareBy, after.customerReferrer.pendingShareBy),
    0,
    "IDOR cannot mutate customer referrer pendingShareBy",
  );

  assertEqual(
    delta(before.providerReferrer.pendingShareBy, after.providerReferrer.pendingShareBy),
    0,
    "IDOR cannot mutate provider referrer pendingShareBy",
  );

  assert(
    approximatelyEqual(before.customerReferrer.earning, after.customerReferrer.earning),
    "IDOR cannot credit customer referral earning",
  );

  assert(
    approximatelyEqual(before.providerReferrer.earning, after.providerReferrer.earning),
    "IDOR cannot credit provider referral earning",
  );
}

/**
 * ============================================================
 * TEST 2
 * COMPLETE vs CANCEL RACE
 * ============================================================
 */

async function testTerminalRace() {
  section(`${COMPLETE_REQUESTS} COMPLETE vs ${CANCEL_REQUESTS} CANCEL RACE`);

  const before = await getState();

  assertEqual(before.booking.cancelOrder, false, "Booking is not cancelled before race");

  assertEqual(before.booking.orderCompleted, false, "Booking is not completed before race");

  assertEqual(
    number(before.customer.pending),
    1,
    "Customer starts with exactly one pending booking",
  );

  assertEqual(
    number(before.provider.pendingVendor),
    1,
    "Provider starts with exactly one pendingVendor booking",
  );

  assertEqual(
    number(before.customerReferrer.pendingShareBy),
    1,
    "Customer referrer starts with exactly one pendingShareBy",
  );

  assertEqual(
    number(before.providerReferrer.pendingShareBy),
    1,
    "Provider referrer starts with exactly one pendingShareBy",
  );

  console.log(`Sending ${CONCURRENCY} concurrent terminal-state requests...`);

  const requests = [];

  for (let index = 0; index < COMPLETE_REQUESTS; index += 1) {
    requests.push(
      sendRequest({
        operation: "complete",

        token: customerToken,

        index,

        label: "race",
      }),
    );
  }

  for (let index = 0; index < CANCEL_REQUESTS; index += 1) {
    requests.push(
      sendRequest({
        operation: "cancel",

        token: customerToken,

        index,

        label: "race",
      }),
    );
  }

  /**
   * Randomize ordering so one operation
   * does not always get scheduling advantage.
   */
  for (let i = requests.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));

    [requests[i], requests[j]] = [requests[j], requests[i]];
  }

  const startedAt = Date.now();

  const results = await Promise.all(requests);

  const elapsedMs = Date.now() - startedAt;

  const successes = results.filter(isSuccess);

  const successfulCompletes = successes.filter((result) => result.operation === "complete");

  const successfulCancels = successes.filter((result) => result.operation === "cancel");

  const serverErrors = results.filter(
    (result) => typeof result.status === "number" && result.status >= 500,
  );

  const networkErrors = results.filter((result) => result.status === "NETWORK_ERROR");

  const statusCounts = {};

  for (const result of results) {
    const key = `${result.operation}:${result.status}`;

    statusCounts[key] = (statusCounts[key] || 0) + 1;
  }

  console.log({
    elapsedMs,

    requests: results.length,

    successful: successes.length,

    successfulCompletes: successfulCompletes.length,

    successfulCancels: successfulCancels.length,

    serverErrors: serverErrors.length,

    networkErrors: networkErrors.length,

    statusCounts,
  });

  const after = await getState();

  /**
   * ========================================================
   * HTTP INVARIANTS
   * ========================================================
   */

  assertEqual(
    results.length,
    CONCURRENCY,
    `Received results for all ${CONCURRENCY} terminal requests`,
  );

  assertEqual(successes.length, 1, "Exactly one terminal-state request succeeds");

  assertEqual(
    successfulCompletes.length + successfulCancels.length,
    1,
    "Exactly one of COMPLETE or CANCEL wins",
  );

  assertEqual(serverErrors.length, 0, "Terminal race produces no HTTP 500 responses");

  assertEqual(networkErrors.length, 0, "Terminal race produces no network errors");

  /**
   * ========================================================
   * BOOKING TERMINAL STATE
   * ========================================================
   */

  const isCompleted = after.booking.orderCompleted === true;

  const isCancelled = after.booking.cancelOrder === true;

  assert(isCompleted || isCancelled, "Booking reaches a terminal state");

  assert(!(isCompleted && isCancelled), "Booking can NEVER be both completed and cancelled");

  assertEqual(
    Number(isCompleted) + Number(isCancelled),
    1,
    "Exactly one terminal booking flag is true",
  );

  if (isCompleted) {
    winningState = "COMPLETED";
  } else if (isCancelled) {
    winningState = "CANCELLED";
  }

  console.log({
    winningState,

    cancelOrder: after.booking.cancelOrder,

    orderCompleted: after.booking.orderCompleted,
  });

  /**
   * ========================================================
   * COMMON ACCOUNTING
   * ========================================================
   */

  assertEqual(
    delta(before.customer.pending, after.customer.pending),
    -1,
    "Customer pending decrements exactly once",
  );

  assertEqual(
    delta(before.provider.pendingVendor, after.provider.pendingVendor),
    -1,
    "Provider pendingVendor decrements exactly once",
  );

  assert(number(after.customer.pending) >= 0, "Customer pending never becomes negative");

  assert(
    number(after.provider.pendingVendor) >= 0,
    "Provider pendingVendor never becomes negative",
  );

  assert(
    approximatelyEqual(before.customer.balance, after.customer.balance),
    "Terminal transition does not mutate customer balance",
  );

  assert(
    approximatelyEqual(before.provider.balance, after.provider.balance),
    "Terminal transition does not mutate provider balance",
  );

  assertEqual(
    delta(before.customer.bookingCount, after.customer.bookingCount),
    0,
    "Terminal transition does not mutate customer bookingCount",
  );

  assertEqual(
    delta(before.provider.bookingCountVendor, after.provider.bookingCountVendor),
    0,
    "Terminal transition does not mutate provider bookingCountVendor",
  );

  /**
   * ========================================================
   * COMPLETION WON
   * ========================================================
   */

  if (winningState === "COMPLETED") {
    section("COMPLETION WON");

    assertEqual(successfulCompletes.length, 1, "Exactly one completion request succeeded");

    assertEqual(
      successfulCancels.length,
      0,
      "No cancellation request succeeds when completion wins",
    );

    assertEqual(
      delta(before.customer.completed, after.customer.completed),
      1,
      "Customer completed increments exactly once",
    );

    assertEqual(
      delta(before.customer.canceled, after.customer.canceled),
      0,
      "Customer canceled remains unchanged",
    );

    assertEqual(
      delta(before.provider.completedVendor, after.provider.completedVendor),
      1,
      "Provider completedVendor increments exactly once",
    );

    assertEqual(
      delta(before.provider.canceledVendor, after.provider.canceledVendor),
      0,
      "Provider canceledVendor remains unchanged",
    );

    /**
     * Customer referral.
     */
    assertEqual(
      delta(before.customerReferrer.pendingShareBy, after.customerReferrer.pendingShareBy),
      -1,
      "Customer referrer pendingShareBy decrements exactly once",
    );

    assertEqual(
      delta(before.customerReferrer.completedShareBy, after.customerReferrer.completedShareBy),
      1,
      "Customer referrer completedShareBy increments exactly once",
    );

    assertEqual(
      delta(before.customerReferrer.canceledShareBy, after.customerReferrer.canceledShareBy),
      0,
      "Customer referrer canceledShareBy remains unchanged",
    );

    assert(
      approximatelyEqual(
        delta(before.customerReferrer.earning, after.customerReferrer.earning),

        EXPECTED_REFERRAL_REWARD,
      ),
      `Customer referrer receives exactly one reward of ${EXPECTED_REFERRAL_REWARD}`,
    );

    /**
     * Provider referral.
     */
    assertEqual(
      delta(before.providerReferrer.pendingShareBy, after.providerReferrer.pendingShareBy),
      -1,
      "Provider referrer pendingShareBy decrements exactly once",
    );

    assertEqual(
      delta(before.providerReferrer.completedShareBy, after.providerReferrer.completedShareBy),
      1,
      "Provider referrer completedShareBy increments exactly once",
    );

    assertEqual(
      delta(before.providerReferrer.canceledShareBy, after.providerReferrer.canceledShareBy),
      0,
      "Provider referrer canceledShareBy remains unchanged",
    );

    assert(
      approximatelyEqual(
        delta(before.providerReferrer.earning, after.providerReferrer.earning),

        EXPECTED_REFERRAL_REWARD,
      ),
      `Provider referrer receives exactly one reward of ${EXPECTED_REFERRAL_REWARD}`,
    );
  }

  /**
   * ========================================================
   * CANCELLATION WON
   * ========================================================
   */

  if (winningState === "CANCELLED") {
    section("CANCELLATION WON");

    assertEqual(successfulCancels.length, 1, "Exactly one cancellation request succeeded");

    assertEqual(
      successfulCompletes.length,
      0,
      "No completion request succeeds when cancellation wins",
    );

    assertEqual(
      delta(before.customer.canceled, after.customer.canceled),
      1,
      "Customer canceled increments exactly once",
    );

    assertEqual(
      delta(before.customer.completed, after.customer.completed),
      0,
      "Customer completed remains unchanged",
    );

    assertEqual(
      delta(before.provider.canceledVendor, after.provider.canceledVendor),
      1,
      "Provider canceledVendor increments exactly once",
    );

    assertEqual(
      delta(before.provider.completedVendor, after.provider.completedVendor),
      0,
      "Provider completedVendor remains unchanged",
    );

    /**
     * Customer referral.
     */
    assertEqual(
      delta(before.customerReferrer.pendingShareBy, after.customerReferrer.pendingShareBy),
      -1,
      "Customer referrer pendingShareBy decrements exactly once",
    );

    assertEqual(
      delta(before.customerReferrer.canceledShareBy, after.customerReferrer.canceledShareBy),
      1,
      "Customer referrer canceledShareBy increments exactly once",
    );

    assertEqual(
      delta(before.customerReferrer.completedShareBy, after.customerReferrer.completedShareBy),
      0,
      "Customer referrer completedShareBy remains unchanged",
    );

    assert(
      approximatelyEqual(before.customerReferrer.earning, after.customerReferrer.earning),
      "Cancellation does not credit customer referrer earning",
    );

    /**
     * Provider referral.
     */
    assertEqual(
      delta(before.providerReferrer.pendingShareBy, after.providerReferrer.pendingShareBy),
      -1,
      "Provider referrer pendingShareBy decrements exactly once",
    );

    assertEqual(
      delta(before.providerReferrer.canceledShareBy, after.providerReferrer.canceledShareBy),
      1,
      "Provider referrer canceledShareBy increments exactly once",
    );

    assertEqual(
      delta(before.providerReferrer.completedShareBy, after.providerReferrer.completedShareBy),
      0,
      "Provider referrer completedShareBy remains unchanged",
    );

    assert(
      approximatelyEqual(before.providerReferrer.earning, after.providerReferrer.earning),
      "Cancellation does not credit provider referrer earning",
    );
  }

  /**
   * Referrer balances must NEVER change.
   */
  assert(
    approximatelyEqual(before.customerReferrer.balance, after.customerReferrer.balance),
    "Terminal transition does not mutate customer referrer balance",
  );

  assert(
    approximatelyEqual(before.providerReferrer.balance, after.providerReferrer.balance),
    "Terminal transition does not mutate provider referrer balance",
  );

  assert(
    number(after.customerReferrer.pendingShareBy) >= 0,
    "Customer referrer pendingShareBy never becomes negative",
  );

  assert(
    number(after.providerReferrer.pendingShareBy) >= 0,
    "Provider referrer pendingShareBy never becomes negative",
  );
}

/**
 * ============================================================
 * TEST 3
 * POST-TERMINAL REPLAY
 * ============================================================
 */

async function testReplay() {
  section("POST-TERMINAL REPLAY SAFETY");

  const before = await getState();

  const requests = [];

  for (let index = 0; index < REPLAY_COUNT; index += 1) {
    requests.push(
      sendRequest({
        operation: index % 2 === 0 ? "complete" : "cancel",

        token: customerToken,

        index,

        label: "replay",
      }),
    );
  }

  const results = await Promise.all(requests);

  console.log({
    statuses: results.map((result) => ({
      operation: result.operation,

      status: result.status,
    })),
  });

  const successful = results.filter(isSuccess);

  const serverErrors = results.filter(
    (result) => typeof result.status === "number" && result.status >= 500,
  );

  const networkErrors = results.filter((result) => result.status === "NETWORK_ERROR");

  const after = await getState();

  assertEqual(successful.length, 0, "No terminal-state replay request succeeds");

  assertEqual(serverErrors.length, 0, "Terminal replay produces no HTTP 500");

  assertEqual(networkErrors.length, 0, "Terminal replay produces no network errors");

  assertEqual(
    after.booking.cancelOrder,
    before.booking.cancelOrder,
    "Replay cannot change cancelOrder",
  );

  assertEqual(
    after.booking.orderCompleted,
    before.booking.orderCompleted,
    "Replay cannot change orderCompleted",
  );

  assertEqual(
    delta(before.customer.pending, after.customer.pending),
    0,
    "Replay cannot mutate customer pending",
  );

  assertEqual(
    delta(before.customer.completed, after.customer.completed),
    0,
    "Replay cannot mutate customer completed",
  );

  assertEqual(
    delta(before.customer.canceled, after.customer.canceled),
    0,
    "Replay cannot mutate customer canceled",
  );

  assertEqual(
    delta(before.provider.pendingVendor, after.provider.pendingVendor),
    0,
    "Replay cannot mutate provider pendingVendor",
  );

  assertEqual(
    delta(before.provider.completedVendor, after.provider.completedVendor),
    0,
    "Replay cannot mutate provider completedVendor",
  );

  assertEqual(
    delta(before.provider.canceledVendor, after.provider.canceledVendor),
    0,
    "Replay cannot mutate provider canceledVendor",
  );

  assertEqual(
    delta(before.customerReferrer.pendingShareBy, after.customerReferrer.pendingShareBy),
    0,
    "Replay cannot mutate customer referrer pendingShareBy",
  );

  assertEqual(
    delta(before.customerReferrer.completedShareBy, after.customerReferrer.completedShareBy),
    0,
    "Replay cannot mutate customer referrer completedShareBy",
  );

  assertEqual(
    delta(before.customerReferrer.canceledShareBy, after.customerReferrer.canceledShareBy),
    0,
    "Replay cannot mutate customer referrer canceledShareBy",
  );

  assert(
    approximatelyEqual(before.customerReferrer.earning, after.customerReferrer.earning),
    "Replay cannot mutate customer referral earning",
  );

  assertEqual(
    delta(before.providerReferrer.pendingShareBy, after.providerReferrer.pendingShareBy),
    0,
    "Replay cannot mutate provider referrer pendingShareBy",
  );

  assertEqual(
    delta(before.providerReferrer.completedShareBy, after.providerReferrer.completedShareBy),
    0,
    "Replay cannot mutate provider referrer completedShareBy",
  );

  assertEqual(
    delta(before.providerReferrer.canceledShareBy, after.providerReferrer.canceledShareBy),
    0,
    "Replay cannot mutate provider referrer canceledShareBy",
  );

  assert(
    approximatelyEqual(before.providerReferrer.earning, after.providerReferrer.earning),
    "Replay cannot mutate provider referral earning",
  );

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

  assertEqual(
    delta(before.customer.bookingCount, after.customer.bookingCount),
    0,
    "Replay cannot mutate customer bookingCount",
  );

  assertEqual(
    delta(before.provider.bookingCountVendor, after.provider.bookingCountVendor),
    0,
    "Replay cannot mutate provider bookingCountVendor",
  );
}

/**
 * ============================================================
 * FINAL DATABASE INVARIANTS
 * ============================================================
 */

async function testFinalState() {
  section("FINAL TERMINAL DATABASE INVARIANTS");

  const state = await getState();

  const terminalCount =
    Number(state.booking.orderCompleted === true) + Number(state.booking.cancelOrder === true);

  assertEqual(terminalCount, 1, "Exactly one terminal booking state exists");

  assertEqual(number(state.customer.pending), 0, "Customer pending is exactly zero");

  assertEqual(number(state.provider.pendingVendor), 0, "Provider pendingVendor is exactly zero");

  assertEqual(
    number(state.customerReferrer.pendingShareBy),
    0,
    "Customer referrer pendingShareBy is exactly zero",
  );

  assertEqual(
    number(state.providerReferrer.pendingShareBy),
    0,
    "Provider referrer pendingShareBy is exactly zero",
  );

  /**
   * Exactly one customer terminal counter
   * must have increased.
   *
   * Initial:
   *
   * completed = 5
   * canceled  = 5
   *
   * Final combined = 11.
   */
  assertEqual(
    number(state.customer.completed) + number(state.customer.canceled),
    11,
    "Customer has exactly one terminal counter increment",
  );

  /**
   * Provider initial:
   *
   * completedVendor = 5
   * canceledVendor  = 7
   *
   * Final combined = 13.
   */
  assertEqual(
    number(state.provider.completedVendor) + number(state.provider.canceledVendor),
    13,
    "Provider has exactly one terminal counter increment",
  );

  /**
   * Customer referrer initial:
   *
   * completedShareBy = 10
   * canceledShareBy  = 4
   *
   * Final combined = 15.
   */
  assertEqual(
    number(state.customerReferrer.completedShareBy) +
      number(state.customerReferrer.canceledShareBy),
    15,
    "Customer referrer has exactly one terminal referral counter increment",
  );

  /**
   * Provider referrer initial:
   *
   * completedShareBy = 20
   * canceledShareBy  = 8
   *
   * Final combined = 29.
   */
  assertEqual(
    number(state.providerReferrer.completedShareBy) +
      number(state.providerReferrer.canceledShareBy),
    29,
    "Provider referrer has exactly one terminal referral counter increment",
  );

  assert(number(state.customer.pending) >= 0, "Customer pending invariant is non-negative");

  assert(
    number(state.provider.pendingVendor) >= 0,
    "Provider pendingVendor invariant is non-negative",
  );

  assert(
    number(state.customerReferrer.pendingShareBy) >= 0,
    "Customer referrer pendingShareBy invariant is non-negative",
  );

  assert(
    number(state.providerReferrer.pendingShareBy) >= 0,
    "Provider referrer pendingShareBy invariant is non-negative",
  );

  /**
   * --------------------------------------------------------
   * Winner-specific final state
   * --------------------------------------------------------
   */

  if (winningState === "COMPLETED") {
    assertEqual(state.booking.orderCompleted, true, "Completion winner remains completed");

    assertEqual(state.booking.cancelOrder, false, "Completion winner never becomes cancelled");

    assertEqual(number(state.customer.completed), 6, "Customer completed final value is six");

    assertEqual(number(state.customer.canceled), 5, "Customer canceled final value remains five");

    assertEqual(
      number(state.provider.completedVendor),
      6,
      "Provider completedVendor final value is six",
    );

    assertEqual(
      number(state.provider.canceledVendor),
      7,
      "Provider canceledVendor final value remains seven",
    );

    assert(
      approximatelyEqual(state.customerReferrer.earning, 100 + EXPECTED_REFERRAL_REWARD),
      "Completion winner credits customer referral reward exactly once",
    );

    assert(
      approximatelyEqual(state.providerReferrer.earning, 200 + EXPECTED_REFERRAL_REWARD),
      "Completion winner credits provider referral reward exactly once",
    );
  }

  if (winningState === "CANCELLED") {
    assertEqual(state.booking.cancelOrder, true, "Cancellation winner remains cancelled");

    assertEqual(state.booking.orderCompleted, false, "Cancellation winner never becomes completed");

    assertEqual(number(state.customer.canceled), 6, "Customer canceled final value is six");

    assertEqual(number(state.customer.completed), 5, "Customer completed final value remains five");

    assertEqual(
      number(state.provider.canceledVendor),
      8,
      "Provider canceledVendor final value is eight",
    );

    assertEqual(
      number(state.provider.completedVendor),
      5,
      "Provider completedVendor final value remains five",
    );

    assert(
      approximatelyEqual(state.customerReferrer.earning, 100),
      "Cancellation winner does not credit customer referral reward",
    );

    assert(
      approximatelyEqual(state.providerReferrer.earning, 200),
      "Cancellation winner does not credit provider referral reward",
    );
  }

  /**
   * Balances and booking counts are immutable
   * during terminal transition.
   */

  assert(approximatelyEqual(state.customer.balance, 10000), "Customer balance remains unchanged");

  assert(approximatelyEqual(state.provider.balance, 10000), "Provider balance remains unchanged");

  assert(
    approximatelyEqual(state.customerReferrer.balance, 500),
    "Customer referrer balance remains unchanged",
  );

  assert(
    approximatelyEqual(state.providerReferrer.balance, 700),
    "Provider referrer balance remains unchanged",
  );

  assertEqual(number(state.customer.bookingCount), 11, "Customer bookingCount remains unchanged");

  assertEqual(
    number(state.provider.bookingCountVendor),
    13,
    "Provider bookingCountVendor remains unchanged",
  );

  /**
   * Attacker remains untouched.
   */

  assertEqual(number(state.attacker.pending), 2, "Attacker customer pending remains untouched");

  assertEqual(number(state.attacker.completed), 3, "Attacker customer completed remains untouched");

  assertEqual(number(state.attacker.canceled), 4, "Attacker customer canceled remains untouched");

  assertEqual(
    number(state.attacker.pendingVendor),
    2,
    "Attacker provider pendingVendor remains untouched",
  );

  assertEqual(
    number(state.attacker.completedVendor),
    3,
    "Attacker provider completedVendor remains untouched",
  );

  assertEqual(
    number(state.attacker.canceledVendor),
    4,
    "Attacker provider canceledVendor remains untouched",
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

    section("VENDOR BOOKING TERMINAL COMPLETE / CANCEL RACE E2E TEST");

    console.log({
      completeApi: COMPLETE_API,

      cancelApi: CANCEL_API,

      nodeEnv: process.env.NODE_ENV,

      concurrency: CONCURRENCY,

      completeRequests: COMPLETE_REQUESTS,

      cancelRequests: CANCEL_REQUESTS,

      replayCount: REPLAY_COUNT,

      bookingDate: BOOKING_DATE,

      commission: COMMISSION,

      expectedReferralReward: EXPECTED_REFERRAL_REWARD,
    });

    await createFixtures();

    await testAuthorization();

    await testTerminalRace();

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

  section("FINAL TERMINAL RACE TEST SUMMARY");

  console.log(`Assertions: ${assertions}`);

  console.log(`Passed: ${passed}`);

  console.log(`Failed: ${failed}`);

  console.log(`Winning terminal state: ${winningState || "UNKNOWN"}`);

  if (failed > 0 || exitCode !== 0) {
    console.error("");
    console.error("FAIL: BOOKING TERMINAL COMPLETE / CANCEL RACE INVARIANTS FAILED");

    process.exit(1);
  }

  console.log("");

  console.log("PASS: BOOKING TERMINAL COMPLETE / CANCEL RACE INVARIANTS PASSED");

  console.log(`
Verified:

✓ Unauthorized Vendor cannot complete another customer's booking
✓ Unauthorized Vendor cannot cancel another customer's booking
✓ IDOR causes no accounting/referral mutation

✓ ${COMPLETE_REQUESTS} completion requests race against ${CANCEL_REQUESTS} cancellation requests
✓ Exactly ONE terminal transition succeeds
✓ COMPLETE and CANCEL can never both commit
✓ Booking reaches exactly one terminal state

✓ Customer pending decrements exactly once
✓ Provider pendingVendor decrements exactly once
✓ Customer referral pendingShareBy decrements exactly once
✓ Provider referral pendingShareBy decrements exactly once

✓ Winner determines the ONLY terminal accounting mutation
✓ Completion winner increments only completion counters
✓ Cancellation winner increments only cancellation counters

✓ Completion winner credits referral earning exactly once
✓ Cancellation winner credits no referral earning

✓ Customer/provider balances remain unchanged
✓ Referrer balances remain unchanged
✓ Booking counts remain unchanged

✓ Replay cannot perform a second terminal transition
✓ Replay cannot mutate counters
✓ Replay cannot double-credit referral earning

✓ Pending counters never become negative
✓ Race produces no HTTP 500 responses
✓ Race produces no network errors

WINNER: ${winningState}
`);

  process.exit(0);
}

run();
