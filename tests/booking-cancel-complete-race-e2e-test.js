"use strict";

/**
 * ============================================================
 * BOOKING CANCEL vs COMPLETE RACE E2E SECURITY / INVARIANT TEST
 * ============================================================
 *
 * Purpose:
 *
 * Prove that when many cancellation and completion requests race
 * against the SAME active booking:
 *
 *   - exactly one terminal transition wins
 *   - booking can NEVER become both cancelled and completed
 *   - accounting counters mutate exactly once
 *   - balances are not mutated by terminal transitions
 *   - replay attempts cannot mutate accounting again
 *   - another Vendor cannot cancel/complete the booking (IDOR)
 *   - no race request produces HTTP 500
 *
 * This test targets Vendor-as-customer flow:
 *
 *   PATCH /api/bookings/cancelOrderV
 *   PATCH /api/bookings/orderCompletedV
 *
 * IMPORTANT:
 *
 * The booking date is deliberately in the past because
 * BookingService.completeBooking() rejects completion before
 * bookingDate.
 *
 * Run:
 *
 * NODE_ENV=development ALLOW_AUTHORIZATION_TEST=1 \
 * node tests/booking-cancel-complete-race-e2e-test.js
 */

const axios = require("axios");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

const Vendor = require("../models/vendor");
const Bookings = require("../models/bookings");

let ENV;

try {
  ENV = require("../src/config/env");
} catch (_) {
  ENV = {};
}

/**
 * ============================================================
 * CONFIGURATION
 * ============================================================
 */

const BASE_URL =
  process.env.TEST_API_BASE_URL || process.env.API_BASE_URL || "http://localhost:3000/api";

const CANCEL_URL = `${BASE_URL}/bookings/cancelOrderV`;
const COMPLETE_URL = `${BASE_URL}/bookings/orderCompletedV`;

const TOTAL_REQUESTS = Number(process.env.TEST_RACE_CONCURRENCY || 100);

const CANCEL_REQUESTS = Math.floor(TOTAL_REQUESTS / 2);
const COMPLETE_REQUESTS = TOTAL_REQUESTS - CANCEL_REQUESTS;

const REQUEST_TIMEOUT_MS = Number(process.env.TEST_REQUEST_TIMEOUT_MS || 15000);

const JWT_SECRET = process.env.JWT_VENDOR_SECRET || ENV.JWT_VENDOR_SECRET;

const MONGODB_URI =
  process.env.MONGODB_URI ||
  process.env.MONGO_URI ||
  process.env.MONGODB_URL ||
  ENV.MONGODB_URI ||
  ENV.MONGO_URI ||
  ENV.MONGODB_URL;

/**
 * Use a past canonical booking date.
 *
 * Do NOT use today's date because completeBooking() requires:
 *
 * Date.now() > new Date(booking.bookingDate).getTime()
 */
function getPastCanonicalDate() {
  const date = new Date();

  date.setDate(date.getDate() - 2);

  return date.toDateString();
}

const BOOKING_DATE = getPastCanonicalDate();

/**
 * ============================================================
 * TEST STATE
 * ============================================================
 */

let assertions = 0;
let passed = 0;
let failed = 0;

let customerVendor;
let providerVendor;
let attackerVendor;
let booking;

let customerToken;
let attackerToken;

/**
 * ============================================================
 * LOGGING / ASSERTION HELPERS
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
  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : 0;
}

function delta(before, after) {
  return number(after) - number(before);
}

function countByStatus(results) {
  const counts = {};

  for (const result of results) {
    const key = String(result.status);

    counts[key] = (counts[key] || 0) + 1;
  }

  return counts;
}

function createVendorToken(vendor) {
  if (!JWT_SECRET) {
    throw new Error(
      "JWT_VENDOR_SECRET is unavailable. " +
        "Set JWT_VENDOR_SECRET or ensure src/config/env exports JWT_VENDOR_SECRET.",
    );
  }

  /**
   * Keep payload compatible with the existing vendor auth format.
   *
   * Middleware should ultimately resolve req.auth.id from vendorId.
   */
  return jwt.sign(
    {
      phoneNo: vendor.phoneNo,
      vendorId: vendor._id.toString(),
      type: vendor.type,
    },
    JWT_SECRET,
    {
      expiresIn: "1h",
    },
  );
}

/**
 * ============================================================
 * DATABASE HELPERS
 * ============================================================
 */

async function connectDatabase() {
  if (mongoose.connection.readyState === 1) {
    return;
  }

  if (!MONGODB_URI) {
    /**
     * Some projects connect MongoDB as a side effect of their
     * database configuration.
     *
     * Try common config locations before failing.
     */
    const possibleModules = [
      "../src/config/database",
      "../src/config/db",
      "../config/database",
      "../config/db",
    ];

    for (const modulePath of possibleModules) {
      try {
        const dbModule = require(modulePath);

        if (typeof dbModule === "function") {
          await dbModule();
        } else if (dbModule && typeof dbModule.connect === "function") {
          await dbModule.connect();
        }

        if (mongoose.connection.readyState === 1) {
          console.log("MongoDB connected.");
          return;
        }
      } catch (_) {
        // Try next known configuration module.
      }
    }

    throw new Error(
      "MongoDB URI not found. Set MONGODB_URI/MONGO_URI " +
        "or adjust connectDatabase() to your existing DB config.",
    );
  }

  await mongoose.connect(MONGODB_URI);

  console.log("MongoDB connected.");
}

async function getState() {
  const [currentBooking, currentCustomer, currentProvider, currentAttacker] = await Promise.all([
    Bookings.findById(booking._id).lean(),

    Vendor.findById(customerVendor._id)
      .select(
        "balance pending completed canceled bookingCount " +
          "pendingVendor completedVendor canceledVendor bookingCountVendor",
      )
      .lean(),

    Vendor.findById(providerVendor._id)
      .select(
        "balance pending completed canceled bookingCount " +
          "pendingVendor completedVendor canceledVendor bookingCountVendor",
      )
      .lean(),

    Vendor.findById(attackerVendor._id)
      .select(
        "balance pending completed canceled bookingCount " +
          "pendingVendor completedVendor canceledVendor bookingCountVendor",
      )
      .lean(),
  ]);

  if (!currentBooking) {
    throw new Error("Race-test booking disappeared");
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

  return {
    booking: currentBooking,
    customer: currentCustomer,
    provider: currentProvider,
    attacker: currentAttacker,
  };
}

/**
 * ============================================================
 * FIXTURE CREATION
 * ============================================================
 */

async function createFixtures() {
  section("CREATE TEST FIXTURES");

  const suffix = `${Date.now()}`.slice(-7);

  /**
   * Generate safe Indian-style numeric phone values.
   *
   * Models currently store phoneNo as Number.
   */
  const customerPhone = Number(`81${suffix}01`.slice(0, 10));
  const providerPhone = Number(`82${suffix}02`.slice(0, 10));
  const attackerPhone = Number(`83${suffix}03`.slice(0, 10));

  customerVendor = await Vendor.create({
    name: "Race Customer Vendor",
    phoneNo: customerPhone,
    password: "TEST_ONLY_HASH",
    type: "electrician",

    balance: 10000,

    bookingCount: 1,
    pending: 1,
    completed: 0,
    canceled: 0,

    bookingCountVendor: 0,
    pendingVendor: 0,
    completedVendor: 0,
    canceledVendor: 0,

    commission: 50,
  });

  providerVendor = await Vendor.create({
    name: "Race Provider Vendor",
    phoneNo: providerPhone,
    password: "TEST_ONLY_HASH",
    type: "plumber",

    balance: 10000,

    bookingCount: 0,
    pending: 0,
    completed: 0,
    canceled: 0,

    /**
     * Simulate accounting state immediately after one
     * successful booking creation.
     */
    bookingCountVendor: 1,
    pendingVendor: 1,
    completedVendor: 0,
    canceledVendor: 0,

    commission: 50,

    totalDiscount: 0,
    transactionCount: 0,
  });

  attackerVendor = await Vendor.create({
    name: "Race Attacker Vendor",
    phoneNo: attackerPhone,
    password: "TEST_ONLY_HASH",
    type: "mason",

    balance: 10000,

    bookingCount: 0,
    pending: 0,
    completed: 0,
    canceled: 0,

    bookingCountVendor: 0,
    pendingVendor: 0,
    completedVendor: 0,
    canceledVendor: 0,

    commission: 50,
  });

  /**
   * Create ACTIVE booking directly.
   *
   * This isolates cancellation/completion invariants from
   * booking-creation behavior, which has already been tested
   * separately.
   */
  booking = await Bookings.create({
    userId: customerVendor._id,
    vendorId: providerVendor._id,

    type: providerVendor.type,
    pincode: "274001",

    bookingDate: BOOKING_DATE,

    bookingTime: Date.now() - 48 * 60 * 60 * 1000,

    bookedOn: new Date(Date.now() - 48 * 60 * 60 * 1000),

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
    bookingId: booking._id.toString(),
    bookingDate: BOOKING_DATE,
    cancelRequests: CANCEL_REQUESTS,
    completeRequests: COMPLETE_REQUESTS,
  });
}

/**
 * ============================================================
 * HTTP HELPERS
 * ============================================================
 */

async function sendRequest({ url, token, requestId, operation }) {
  const startedAt = Date.now();

  try {
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

        timeout: REQUEST_TIMEOUT_MS,

        validateStatus: () => true,
      },
    );

    return {
      operation,
      requestId,
      status: response.status,
      data: response.data,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      operation,
      requestId,
      status: "NETWORK_ERROR",
      error: error.message,
      durationMs: Date.now() - startedAt,
    };
  }
}

function sendCancel(index, token = customerToken) {
  return sendRequest({
    url: CANCEL_URL,
    token,
    operation: "cancel",
    requestId: `cancel-race-${Date.now()}-${index}`,
  });
}

function sendComplete(index, token = customerToken) {
  return sendRequest({
    url: COMPLETE_URL,
    token,
    operation: "complete",
    requestId: `complete-race-${Date.now()}-${index}`,
  });
}

/**
 * ============================================================
 * IDOR TEST
 * ============================================================
 */

async function testIdor() {
  section("TERMINAL TRANSITION IDOR AUTHORIZATION");

  const before = await getState();

  const cancelResult = await sendCancel("attacker", attackerToken);

  assert(
    cancelResult.status === 403,
    `Attacker Vendor cannot cancel another customer's booking [HTTP ${cancelResult.status}]`,
  );

  assert(cancelResult.status !== 500, "Unauthorized cancellation does not produce HTTP 500");

  const completeResult = await sendComplete("attacker", attackerToken);

  assert(
    completeResult.status === 403,
    `Attacker Vendor cannot complete another customer's booking [HTTP ${completeResult.status}]`,
  );

  assert(completeResult.status !== 500, "Unauthorized completion does not produce HTTP 500");

  const after = await getState();

  assert(after.booking.cancelOrder === false, "IDOR attempts do not cancel booking");

  assert(after.booking.orderCompleted === false, "IDOR attempts do not complete booking");

  assert(
    delta(before.customer.pending, after.customer.pending) === 0,
    "IDOR attempts do not mutate customer pending",
  );

  assert(
    delta(before.customer.completed, after.customer.completed) === 0,
    "IDOR attempts do not mutate customer completed",
  );

  assert(
    delta(before.customer.canceled, after.customer.canceled) === 0,
    "IDOR attempts do not mutate customer canceled",
  );

  assert(
    delta(before.provider.pendingVendor, after.provider.pendingVendor) === 0,
    "IDOR attempts do not mutate provider pendingVendor",
  );

  assert(
    delta(before.provider.completedVendor, after.provider.completedVendor) === 0,
    "IDOR attempts do not mutate provider completedVendor",
  );

  assert(
    delta(before.provider.canceledVendor, after.provider.canceledVendor) === 0,
    "IDOR attempts do not mutate provider canceledVendor",
  );
}

/**
 * ============================================================
 * CANCEL / COMPLETE RACE
 * ============================================================
 */

async function testRace() {
  section("100-WAY CANCEL vs COMPLETE RACE");

  const before = await getState();

  assert(before.booking.cancelOrder === false, "Booking is not cancelled before race");

  assert(before.booking.orderCompleted === false, "Booking is not completed before race");

  assert(number(before.customer.pending) === 1, "Customer starts with exactly one pending booking");

  assert(
    number(before.provider.pendingVendor) === 1,
    "Provider starts with exactly one pendingVendor booking",
  );

  const requests = [];

  for (let i = 0; i < CANCEL_REQUESTS; i += 1) {
    requests.push(sendCancel(i));
  }

  for (let i = 0; i < COMPLETE_REQUESTS; i += 1) {
    requests.push(sendComplete(i));
  }

  /**
   * Shuffle request order so Promise creation order does not
   * systematically favor one endpoint.
   */
  for (let i = requests.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));

    [requests[i], requests[j]] = [requests[j], requests[i]];
  }

  console.log(`Sending ${requests.length} concurrent terminal-state requests...`);

  const startedAt = Date.now();

  const results = await Promise.all(requests);

  const elapsedMs = Date.now() - startedAt;

  const successful = results.filter(
    (result) => typeof result.status === "number" && result.status >= 200 && result.status < 300,
  );

  const successfulCancels = successful.filter((result) => result.operation === "cancel");

  const successfulCompletes = successful.filter((result) => result.operation === "complete");

  const serverErrors = results.filter(
    (result) => typeof result.status === "number" && result.status >= 500,
  );

  const networkErrors = results.filter((result) => result.status === "NETWORK_ERROR");

  console.log({
    elapsedMs,
    requests: results.length,
    successful: successful.length,
    successfulCancels: successfulCancels.length,
    successfulCompletes: successfulCompletes.length,
    serverErrors: serverErrors.length,
    networkErrors: networkErrors.length,
    statusCounts: countByStatus(results),
  });

  assert(
    results.length === TOTAL_REQUESTS,
    `Received results for all ${TOTAL_REQUESTS} race requests`,
  );

  assert(successful.length === 1, "Exactly one cancel/complete request succeeds");

  assert(serverErrors.length === 0, "Cancel/complete race produces no HTTP 500 responses");

  assert(networkErrors.length === 0, "Cancel/complete race produces no network errors");

  assert(
    successfulCancels.length + successfulCompletes.length === 1,
    "Exactly one terminal operation wins",
  );

  const after = await getState();

  const cancelled = after.booking.cancelOrder === true;
  const completed = after.booking.orderCompleted === true;

  console.log({
    winningState: cancelled ? "CANCELLED" : completed ? "COMPLETED" : "INVALID/NONE",

    cancelOrder: after.booking.cancelOrder,
    orderCompleted: after.booking.orderCompleted,
  });

  assert(cancelled || completed, "Booking reaches a terminal state");

  assert(!(cancelled && completed), "Booking can NEVER be both cancelled and completed");

  assert(cancelled !== completed, "Exactly one terminal booking flag is true");

  /**
   * ----------------------------------------------------------
   * Pending accounting
   * ----------------------------------------------------------
   */

  assert(
    delta(before.customer.pending, after.customer.pending) === -1,
    "Customer pending decrements exactly once",
  );

  assert(
    delta(before.provider.pendingVendor, after.provider.pendingVendor) === -1,
    "Provider pendingVendor decrements exactly once",
  );

  assert(number(after.customer.pending) >= 0, "Customer pending never becomes negative");

  assert(
    number(after.provider.pendingVendor) >= 0,
    "Provider pendingVendor never becomes negative",
  );

  /**
   * ----------------------------------------------------------
   * Balance invariants
   *
   * Current BookingService terminal transitions do not refund
   * or charge balances.
   * ----------------------------------------------------------
   */

  assert(
    delta(before.customer.balance, after.customer.balance) === 0,
    "Customer balance is unchanged by terminal transition",
  );

  assert(
    delta(before.provider.balance, after.provider.balance) === 0,
    "Provider balance is unchanged by terminal transition",
  );

  /**
   * ----------------------------------------------------------
   * Booking-count invariants
   * ----------------------------------------------------------
   */

  assert(
    delta(before.customer.bookingCount, after.customer.bookingCount) === 0,
    "Customer bookingCount is unchanged",
  );

  assert(
    delta(before.provider.bookingCountVendor, after.provider.bookingCountVendor) === 0,
    "Provider bookingCountVendor is unchanged",
  );

  /**
   * ----------------------------------------------------------
   * Winner-specific accounting
   * ----------------------------------------------------------
   */

  if (cancelled) {
    section("CANCELLATION WON");

    assert(
      successfulCancels.length === 1,
      "Successful HTTP operation agrees with cancelled DB state",
    );

    assert(
      successfulCompletes.length === 0,
      "No completion request succeeds when cancellation wins",
    );

    assert(
      delta(before.customer.canceled, after.customer.canceled) === 1,
      "Customer canceled increments exactly once",
    );

    assert(
      delta(before.customer.completed, after.customer.completed) === 0,
      "Customer completed remains unchanged",
    );

    assert(
      delta(before.provider.canceledVendor, after.provider.canceledVendor) === 1,
      "Provider canceledVendor increments exactly once",
    );

    assert(
      delta(before.provider.completedVendor, after.provider.completedVendor) === 0,
      "Provider completedVendor remains unchanged",
    );
  }

  if (completed) {
    section("COMPLETION WON");

    assert(
      successfulCompletes.length === 1,
      "Successful HTTP operation agrees with completed DB state",
    );

    assert(successfulCancels.length === 0, "No cancellation request succeeds when completion wins");

    assert(
      delta(before.customer.completed, after.customer.completed) === 1,
      "Customer completed increments exactly once",
    );

    assert(
      delta(before.customer.canceled, after.customer.canceled) === 0,
      "Customer canceled remains unchanged",
    );

    assert(
      delta(before.provider.completedVendor, after.provider.completedVendor) === 1,
      "Provider completedVendor increments exactly once",
    );

    assert(
      delta(before.provider.canceledVendor, after.provider.canceledVendor) === 0,
      "Provider canceledVendor remains unchanged",
    );
  }

  return {
    cancelled,
    completed,
    state: after,
  };
}

/**
 * ============================================================
 * REPLAY / IDEMPOTENCY SAFETY
 * ============================================================
 */

async function testReplay(raceResult) {
  section("POST-TERMINAL REPLAY SAFETY");

  const before = await getState();

  /**
   * Attack BOTH endpoints after terminal state has committed.
   *
   * Neither should mutate state/accounting.
   */
  const results = await Promise.all([
    sendCancel("replay-cancel-1"),
    sendCancel("replay-cancel-2"),
    sendComplete("replay-complete-1"),
    sendComplete("replay-complete-2"),
  ]);

  const successes = results.filter(
    (result) => typeof result.status === "number" && result.status >= 200 && result.status < 300,
  );

  const serverErrors = results.filter(
    (result) => typeof result.status === "number" && result.status >= 500,
  );

  const networkErrors = results.filter((result) => result.status === "NETWORK_ERROR");

  console.log({
    statuses: results.map((result) => ({
      operation: result.operation,
      status: result.status,
    })),
  });

  assert(successes.length === 0, "No terminal-state replay request succeeds");

  assert(serverErrors.length === 0, "Terminal-state replay produces no HTTP 500");

  assert(networkErrors.length === 0, "Terminal-state replay produces no network errors");

  const after = await getState();

  assert(
    after.booking.cancelOrder === before.booking.cancelOrder,
    "Replay cannot change cancelOrder",
  );

  assert(
    after.booking.orderCompleted === before.booking.orderCompleted,
    "Replay cannot change orderCompleted",
  );

  assert(
    delta(before.customer.pending, after.customer.pending) === 0,
    "Replay cannot decrement customer pending again",
  );

  assert(
    delta(before.customer.completed, after.customer.completed) === 0,
    "Replay cannot increment customer completed again",
  );

  assert(
    delta(before.customer.canceled, after.customer.canceled) === 0,
    "Replay cannot increment customer canceled again",
  );

  assert(
    delta(before.provider.pendingVendor, after.provider.pendingVendor) === 0,
    "Replay cannot decrement provider pendingVendor again",
  );

  assert(
    delta(before.provider.completedVendor, after.provider.completedVendor) === 0,
    "Replay cannot increment provider completedVendor again",
  );

  assert(
    delta(before.provider.canceledVendor, after.provider.canceledVendor) === 0,
    "Replay cannot increment provider canceledVendor again",
  );

  assert(
    delta(before.customer.balance, after.customer.balance) === 0,
    "Replay cannot mutate customer balance",
  );

  assert(
    delta(before.provider.balance, after.provider.balance) === 0,
    "Replay cannot mutate provider balance",
  );

  if (raceResult.cancelled) {
    assert(
      after.booking.cancelOrder === true && after.booking.orderCompleted === false,
      "Cancelled booking remains exclusively cancelled after replay",
    );
  }

  if (raceResult.completed) {
    assert(
      after.booking.orderCompleted === true && after.booking.cancelOrder === false,
      "Completed booking remains exclusively completed after replay",
    );
  }
}

/**
 * ============================================================
 * FINAL DATABASE INVARIANTS
 * ============================================================
 */

async function verifyFinalState() {
  section("FINAL DATABASE INVARIANTS");

  const state = await getState();

  const terminalCount =
    Number(state.booking.cancelOrder === true) + Number(state.booking.orderCompleted === true);

  assert(terminalCount === 1, "Exactly one booking terminal state exists");

  assert(number(state.customer.pending) === 0, "Customer pending is exactly zero");

  assert(number(state.provider.pendingVendor) === 0, "Provider pendingVendor is exactly zero");

  const customerTerminalCounters =
    number(state.customer.completed) + number(state.customer.canceled);

  const providerTerminalCounters =
    number(state.provider.completedVendor) + number(state.provider.canceledVendor);

  assert(customerTerminalCounters === 1, "Customer has exactly one terminal counter increment");

  assert(providerTerminalCounters === 1, "Provider has exactly one terminal counter increment");

  assert(number(state.customer.pending) >= 0, "Customer pending invariant is non-negative");

  assert(
    number(state.provider.pendingVendor) >= 0,
    "Provider pendingVendor invariant is non-negative",
  );

  /**
   * Attacker must remain untouched.
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

  let bookingsDeleted = 0;
  let vendorsDeleted = 0;

  if (booking?._id) {
    const result = await Bookings.deleteMany({
      _id: booking._id,
    });

    bookingsDeleted += result.deletedCount || 0;
  }

  const vendorIds = [customerVendor?._id, providerVendor?._id, attackerVendor?._id].filter(Boolean);

  if (vendorIds.length > 0) {
    const result = await Vendor.deleteMany({
      _id: {
        $in: vendorIds,
      },
    });

    vendorsDeleted += result.deletedCount || 0;
  }

  console.log({
    bookingsDeleted,
    vendorsDeleted,
  });
}

/**
 * ============================================================
 * RUNNER
 * ============================================================
 */

async function run() {
  let testError = null;

  try {
    await connectDatabase();

    section("VENDOR BOOKING CANCEL / COMPLETE RACE E2E TEST");

    console.log({
      cancelApi: CANCEL_URL,
      completeApi: COMPLETE_URL,
      nodeEnv: process.env.NODE_ENV,
      concurrency: TOTAL_REQUESTS,
      cancelRequests: CANCEL_REQUESTS,
      completeRequests: COMPLETE_REQUESTS,
      bookingDate: BOOKING_DATE,
    });

    if (process.env.NODE_ENV === "production" && process.env.ALLOW_AUTHORIZATION_TEST !== "1") {
      throw new Error("Refusing to run destructive authorization/concurrency test in production.");
    }

    await createFixtures();

    await testIdor();

    const raceResult = await testRace();

    await testReplay(raceResult);

    await verifyFinalState();
  } catch (error) {
    testError = error;

    section("TEST ERROR");

    console.error(error);
  } finally {
    try {
      await cleanup();
    } catch (cleanupError) {
      console.error("Cleanup failed:", cleanupError);
    }

    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();

      console.log("MongoDB disconnected.");
    }
  }

  section("FINAL CANCEL / COMPLETE RACE TEST SUMMARY");

  console.log(`Assertions: ${assertions}`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);

  if (testError || failed > 0) {
    console.error("");
    console.error("FAIL: BOOKING CANCEL / COMPLETE RACE INVARIANTS FAILED");

    if (testError) {
      console.error(`Reason: ${testError.message}`);
    }

    process.exitCode = 1;

    return;
  }

  console.log("");
  console.log("PASS: BOOKING CANCEL / COMPLETE RACE INVARIANTS PASSED");

  console.log(`
Verified:

✓ Unauthorized Vendor cannot cancel another customer's booking
✓ Unauthorized Vendor cannot complete another customer's booking
✓ IDOR attacks cause no accounting mutation
✓ 50 cancellation and 50 completion requests may race safely
✓ Exactly one terminal transition succeeds
✓ Booking can never become both cancelled and completed
✓ Customer pending decrements exactly once
✓ Provider pendingVendor decrements exactly once
✓ Customer terminal counter increments exactly once
✓ Provider terminal counter increments exactly once
✓ Booking counts are not incremented again
✓ Terminal transition does not mutate balances
✓ Replay cannot perform a second terminal transition
✓ Replay cannot mutate accounting twice
✓ Pending counters never become negative
✓ Race produces no HTTP 500 responses
✓ Race produces no network errors
`);
}

/**
 * Prevent unhandled rejection from silently producing a
 * misleading successful test result.
 */
process.on("unhandledRejection", (error) => {
  console.error("Unhandled rejection:", error);

  process.exitCode = 1;
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error);

  process.exitCode = 1;
});

run();
