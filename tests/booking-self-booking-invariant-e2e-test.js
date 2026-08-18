"use strict";

/**
 * ============================================================
 * VENDOR SELF-BOOKING INVARIANT E2E TEST
 * ============================================================
 *
 * Verifies:
 *
 * 1. Forged self-booking is rejected.
 * 2. Authenticated Vendor identity controls self-booking ownership.
 * 3. 100 concurrent self-booking requests create exactly one booking.
 * 4. Self-booking increments bookingCount exactly once.
 * 5. Self-booking does NOT:
 *      - deduct balance
 *      - increment pending
 *      - increment pendingVendor
 *      - increment bookingCountVendor
 *      - mutate referral pendingShareBy
 *      - mutate referral earning
 * 6. Self-booking completion transitions booking exactly once.
 * 7. Completion does NOT perform normal accounting/referral mutations.
 * 8. 100 concurrent completion requests produce exactly one success.
 * 9. Completion replay is safe.
 * 10. No pending/referral counters become negative.
 *
 * IMPORTANT:
 *
 * Run API separately with normal development configuration.
 *
 * Then:
 *
 * NODE_ENV=development ALLOW_AUTHORIZATION_TEST=1 \
 * node tests/booking-self-booking-invariant-e2e-test.js
 */

const axios = require("axios");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

require("dotenv").config();

const Vendor = require("../models/vendor");
const User = require("../models/user");
const Bookings = require("../models/bookings");
const ENV = require("../src/config/env");

/**
 * ============================================================
 * CONFIG
 * ============================================================
 */

const API_BASE =
  process.env.TEST_API_BASE || process.env.TEST_API_URL || "http://localhost:3000/api";

const CREATE_API = `${API_BASE}/bookings/postToBookingsV`;
const COMPLETE_API = `${API_BASE}/bookings/orderCompletedV`;

const CONCURRENCY = Number(process.env.TEST_CONCURRENCY || 100);

/**
 * Use a past date because completion rejects current/future dates.
 *
 * Go back several days to avoid midnight/timezone edge cases.
 */
const BOOKING_DATE = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toDateString();

const BOOKING_TYPE = "self-booking-test";
const PINCODE = "274001";

/**
 * ============================================================
 * TEST STATE
 * ============================================================
 */

let assertions = 0;
let passed = 0;
let failed = 0;

let selfVendor = null;
let attackerVendor = null;
let referrer = null;

let selfVendorToken = null;
let attackerToken = null;

let createdBookingId = null;

/**
 * Keep every fixture ID so cleanup remains possible even when
 * the test fails midway.
 */
const fixtureIds = {
  vendors: [],
  users: [],
  bookings: [],
};

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

    if (details) {
      console.log(`✓ ${message} ${details}`);
    } else {
      console.log(`✓ ${message}`);
    }

    return;
  }

  failed += 1;

  if (details) {
    console.error(`✗ ${message} ${details}`);
  } else {
    console.error(`✗ ${message}`);
  }
}

function assertEqual(actual, expected, message) {
  assert(actual === expected, message, `[expected=${expected}, actual=${actual}]`);
}

function number(value) {
  return Number(value || 0);
}

function delta(before, after) {
  return number(after) - number(before);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomPhone() {
  /**
   * Keep test numbers inside a predictable high range.
   */
  return Number(`8${Math.floor(100000000 + Math.random() * 899999999)}`);
}

function requestId(prefix, index = 0) {
  return `${prefix}-${Date.now()}-${process.pid}-${index}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
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
    process.env.MONGODB_URL_1 ||
    process.env.MONGODB_URI ||
    process.env.MONGO_URI ||
    process.env.DB_URI ||
    process.env.DATABASE_URL ||
    process.env.DB_URL ||
    process.env.MONGODB_URL;

  if (!mongoUri) {
    throw new Error(
      "MongoDB URI not found. Expected MONGODB_URL_1 or another supported MongoDB URI variable.",
    );
  }

  await mongoose.connect(mongoUri);

  console.log("MongoDB connected.");
}

/**
 * ============================================================
 * TOKEN CREATION
 * ============================================================
 *
 * Existing middleware appears to use vendorId from JWT.
 *
 * Include several common identity claims so this remains
 * compatible with the existing authorization middleware.
 */

function createVendorToken(vendor) {
  if (!ENV.JWT_VENDOR_SECRET) {
    throw new Error("ENV.JWT_VENDOR_SECRET is not configured.");
  }

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
 * FIXTURE CREATION
 * ============================================================
 */

async function createFixtures() {
  section("CREATE TEST FIXTURES");

  const passwordHash = await bcrypt.hash("Test@123456", 10);

  /**
   * Referrer is deliberately a User.
   *
   * Self-booking should never mutate this entity's referral
   * accounting.
   */
  referrer = await User.create({
    name: "Self Booking Referrer",
    phoneNo: randomPhone(),
    password: passwordHash,

    balance: 500,
    earning: 100,

    pending: 2,
    completed: 3,
    canceled: 1,

    pendingShareBy: 6,
    completedShareBy: 10,
    canceledShareBy: 4,

    transactionCount: 5,
    totalDiscount: 0,

    cd: `SELF-REF-${Date.now()}`,
  });

  fixtureIds.users.push(referrer._id);

  /**
   * Vendor that performs the legitimate self-booking.
   */
  selfVendor = await Vendor.create({
    name: "Self Booking Vendor",
    phoneNo: randomPhone(),
    password: passwordHash,

    type: BOOKING_TYPE,
    pincode: PINCODE,

    balance: 10000,
    earning: 250,
    commission: 100,

    bookingCount: 10,
    pending: 3,
    completed: 5,
    canceled: 2,

    bookingCountVendor: 15,
    pendingVendor: 4,
    completedVendor: 7,
    canceledVendor: 3,

    pendingShareBy: 8,
    completedShareBy: 20,
    canceledShareBy: 9,

    transactionCount: 10,
    totalDiscount: 0,

    shareBy: referrer._id.toString(),

    cd: `SELF-VENDOR-${Date.now()}`,
  });

  fixtureIds.vendors.push(selfVendor._id);

  /**
   * Attacker/other Vendor.
   *
   * Used to verify that:
   *
   * isSelfBooking=true
   * userId !== vendorId
   *
   * cannot be abused.
   */
  attackerVendor = await Vendor.create({
    name: "Self Booking Attacker Vendor",
    phoneNo: randomPhone(),
    password: passwordHash,

    type: BOOKING_TYPE,
    pincode: PINCODE,

    balance: 10000,
    earning: 300,
    commission: 100,

    bookingCount: 20,
    pending: 6,
    completed: 8,
    canceled: 4,

    bookingCountVendor: 30,
    pendingVendor: 5,
    completedVendor: 12,
    canceledVendor: 6,

    pendingShareBy: 2,
    completedShareBy: 3,
    canceledShareBy: 1,

    transactionCount: 10,
    totalDiscount: 0,

    cd: `SELF-ATTACKER-${Date.now()}`,
  });

  fixtureIds.vendors.push(attackerVendor._id);

  selfVendorToken = createVendorToken(selfVendor);
  attackerToken = createVendorToken(attackerVendor);

  console.log({
    selfVendor: selfVendor._id.toString(),
    attackerVendor: attackerVendor._id.toString(),
    referrer: referrer._id.toString(),
    bookingDate: BOOKING_DATE,
    concurrency: CONCURRENCY,
  });
}

/**
 * ============================================================
 * STATE SNAPSHOT
 * ============================================================
 */

async function getState() {
  const [currentSelfVendor, currentAttacker, currentReferrer, bookings] = await Promise.all([
    Vendor.findById(selfVendor._id).lean(),
    Vendor.findById(attackerVendor._id).lean(),
    User.findById(referrer._id).lean(),

    Bookings.find({
      $or: [
        {
          userId: selfVendor._id,
        },
        {
          vendorId: selfVendor._id,
        },
      ],
      bookingDate: BOOKING_DATE,
    }).lean(),
  ]);

  if (!currentSelfVendor) {
    throw new Error("Self-booking Vendor fixture disappeared");
  }

  if (!currentAttacker) {
    throw new Error("Attacker Vendor fixture disappeared");
  }

  if (!currentReferrer) {
    throw new Error("Referrer fixture disappeared");
  }

  return {
    selfVendor: currentSelfVendor,
    attackerVendor: currentAttacker,
    referrer: currentReferrer,
    bookings,
  };
}

/**
 * ============================================================
 * HTTP HELPERS
 * ============================================================
 */

async function post({ url, token, body, prefix, index = 0, timeout = 15000 }) {
  const id = requestId(prefix, index);
  const start = Date.now();

  try {
    const response = await axios.post(url, body, {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "x-request-id": id,
      },

      validateStatus: () => true,
      timeout,
    });

    return {
      index,
      requestId: id,
      status: response.status,
      data: response.data,
      durationMs: Date.now() - start,
    };
  } catch (error) {
    return {
      index,
      requestId: id,
      status: "NETWORK_ERROR",
      error: error.message,
      durationMs: Date.now() - start,
    };
  }
}

async function patch({ url, token, body, prefix, index = 0, timeout = 15000 }) {
  const id = requestId(prefix, index);
  const start = Date.now();

  try {
    const response = await axios.patch(url, body, {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "x-request-id": id,
      },

      validateStatus: () => true,
      timeout,
    });

    return {
      index,
      requestId: id,
      status: response.status,
      data: response.data,
      durationMs: Date.now() - start,
    };
  } catch (error) {
    return {
      index,
      requestId: id,
      status: "NETWORK_ERROR",
      error: error.message,
      durationMs: Date.now() - start,
    };
  }
}

function legitimateSelfBookingBody() {
  return {
    userId: selfVendor._id.toString(),
    vendorId: selfVendor._id.toString(),

    bookingDate: BOOKING_DATE,
    type: BOOKING_TYPE,
    pincode: PINCODE,

    isSelfBooking: true,

    name: selfVendor.name || "Self Booking Vendor",
    phoneNo: selfVendor.phoneNo,

    vill: "Self Test Village",
    post: "Self Test Post",
    dist: "Deoria",
  };
}

/**
 * ============================================================
 * FORGED SELF-BOOKING
 * ============================================================
 */

async function testForgedSelfBooking() {
  section("FORGED SELF-BOOKING AUTHORIZATION");

  const before = await getState();

  /**
   * Authenticated selfVendor claims this is a self-booking,
   * but attempts to reserve attackerVendor.
   *
   * userId !== vendorId
   *
   * createVendorBooking() must reject this.
   */
  const result = await post({
    url: CREATE_API,
    token: selfVendorToken,

    body: {
      ...legitimateSelfBookingBody(),

      userId: selfVendor._id.toString(),
      vendorId: attackerVendor._id.toString(),

      isSelfBooking: true,
    },

    prefix: "forged-self-booking",
  });

  console.log({
    status: result.status,
    data: result.data,
    error: result.error,
  });

  assert(
    [400, 403].includes(result.status),
    "Forged self-booking is rejected",
    `[HTTP ${result.status}]`,
  );

  assert(result.status !== 500, "Forged self-booking does not produce HTTP 500");

  assert(result.status !== "NETWORK_ERROR", "Forged self-booking produces no network error");

  const after = await getState();

  const forgedBookings = await Bookings.countDocuments({
    vendorId: attackerVendor._id,
    bookingDate: BOOKING_DATE,
  });

  assertEqual(forgedBookings, 0, "Forged self-booking creates no booking");

  assertEqual(
    after.selfVendor.balance,
    before.selfVendor.balance,
    "Forged self-booking does not mutate authenticated Vendor balance",
  );

  assertEqual(
    after.selfVendor.bookingCount,
    before.selfVendor.bookingCount,
    "Forged self-booking does not mutate authenticated Vendor bookingCount",
  );

  assertEqual(
    after.selfVendor.pending,
    before.selfVendor.pending,
    "Forged self-booking does not mutate authenticated Vendor pending",
  );

  assertEqual(
    after.attackerVendor.balance,
    before.attackerVendor.balance,
    "Forged self-booking does not mutate target Vendor balance",
  );

  assertEqual(
    after.attackerVendor.bookingCount,
    before.attackerVendor.bookingCount,
    "Forged self-booking does not mutate target Vendor bookingCount",
  );

  assertEqual(
    after.attackerVendor.pendingVendor,
    before.attackerVendor.pendingVendor,
    "Forged self-booking does not mutate target Vendor pendingVendor",
  );

  assertEqual(
    after.referrer.pendingShareBy,
    before.referrer.pendingShareBy,
    "Forged self-booking does not mutate referrer pendingShareBy",
  );

  assertEqual(
    after.referrer.earning,
    before.referrer.earning,
    "Forged self-booking does not mutate referrer earning",
  );
}

/**
 * ============================================================
 * SELF-BOOKING CREATION CONCURRENCY
 * ============================================================
 */

async function testConcurrentSelfBookingCreation() {
  section(`${CONCURRENCY}-WAY SELF-BOOKING CREATION CONCURRENCY`);

  const before = await getState();

  const activeBefore = await Bookings.countDocuments({
    vendorId: selfVendor._id,
    bookingDate: BOOKING_DATE,
    cancelOrder: false,
    orderCompleted: false,
  });

  assertEqual(activeBefore, 0, "No active self-booking exists before concurrency test");

  console.log(`Sending ${CONCURRENCY} concurrent self-booking requests...`);

  const start = Date.now();

  const results = await Promise.all(
    Array.from({ length: CONCURRENCY }, (_, index) =>
      post({
        url: CREATE_API,
        token: selfVendorToken,
        body: legitimateSelfBookingBody(),
        prefix: "self-booking-concurrency",
        index,
      }),
    ),
  );

  const elapsedMs = Date.now() - start;

  const successes = results.filter((result) => result.status >= 200 && result.status < 300);

  const serverErrors = results.filter(
    (result) => typeof result.status === "number" && result.status >= 500,
  );

  const networkErrors = results.filter((result) => result.status === "NETWORK_ERROR");

  const statusCounts = results.reduce((acc, result) => {
    const key = String(result.status);

    acc[key] = (acc[key] || 0) + 1;

    return acc;
  }, {});

  console.log({
    elapsedMs,
    requests: results.length,
    successful: successes.length,
    serverErrors: serverErrors.length,
    networkErrors: networkErrors.length,
    statusCounts,
  });

  assertEqual(results.length, CONCURRENCY, `Received results for all ${CONCURRENCY} requests`);

  assertEqual(successes.length, 1, "Exactly one concurrent self-booking request succeeds");

  assertEqual(serverErrors.length, 0, "Self-booking concurrency produces no HTTP 500 responses");

  assertEqual(networkErrors.length, 0, "Self-booking concurrency produces no network errors");

  /**
   * Give MongoDB a tiny amount of time before taking final
   * snapshot. Normally unnecessary, but useful for noisy dev
   * environments.
   */
  await sleep(50);

  const after = await getState();

  const activeBookings = await Bookings.find({
    vendorId: selfVendor._id,
    bookingDate: BOOKING_DATE,
    cancelOrder: false,
    orderCompleted: false,
  }).lean();

  assertEqual(activeBookings.length, 1, "Exactly one active self-booking exists in MongoDB");

  const booking = activeBookings[0];

  if (!booking) {
    throw new Error("Expected one active self-booking after concurrency test");
  }

  createdBookingId = booking._id.toString();
  fixtureIds.bookings.push(booking._id);

  assertEqual(
    booking.userId.toString(),
    selfVendor._id.toString(),
    "Self-booking customer is authenticated Vendor",
  );

  assertEqual(
    booking.vendorId.toString(),
    selfVendor._id.toString(),
    "Self-booking provider is the same Vendor",
  );

  assert(
    booking.userId.toString() === booking.vendorId.toString(),
    "Self-booking has userId === vendorId",
  );

  assertEqual(
    booking.bookingDate,
    BOOKING_DATE,
    "Self-booking uses canonical requested booking date",
  );

  assertEqual(booking.cancelOrder, false, "Created self-booking is not cancelled");

  assertEqual(booking.orderCompleted, false, "Created self-booking is not completed");

  /**
   * ==========================================================
   * IMPORTANT SELF-BOOKING ACCOUNTING CONTRACT
   * ==========================================================
   *
   * createSelfBooking() intentionally performs:
   *
   * Vendor.bookingCount +1
   *
   * It does NOT call normal Vendor→Vendor accounting.
   */

  assertEqual(
    delta(before.selfVendor.bookingCount, after.selfVendor.bookingCount),
    1,
    "Self-booking increments bookingCount exactly once",
  );

  assertEqual(
    after.selfVendor.balance,
    before.selfVendor.balance,
    "Self-booking does not deduct Vendor balance",
  );

  assertEqual(
    after.selfVendor.pending,
    before.selfVendor.pending,
    "Self-booking does not increment customer pending",
  );

  assertEqual(
    after.selfVendor.completed,
    before.selfVendor.completed,
    "Self-booking creation does not increment completed",
  );

  assertEqual(
    after.selfVendor.canceled,
    before.selfVendor.canceled,
    "Self-booking creation does not increment canceled",
  );

  assertEqual(
    after.selfVendor.bookingCountVendor,
    before.selfVendor.bookingCountVendor,
    "Self-booking does not increment bookingCountVendor",
  );

  assertEqual(
    after.selfVendor.pendingVendor,
    before.selfVendor.pendingVendor,
    "Self-booking does not increment pendingVendor",
  );

  assertEqual(
    after.selfVendor.completedVendor,
    before.selfVendor.completedVendor,
    "Self-booking creation does not increment completedVendor",
  );

  assertEqual(
    after.selfVendor.canceledVendor,
    before.selfVendor.canceledVendor,
    "Self-booking creation does not increment canceledVendor",
  );

  assertEqual(
    after.selfVendor.pendingShareBy,
    before.selfVendor.pendingShareBy,
    "Self-booking does not mutate Vendor pendingShareBy",
  );

  assertEqual(
    after.selfVendor.completedShareBy,
    before.selfVendor.completedShareBy,
    "Self-booking does not mutate Vendor completedShareBy",
  );

  assertEqual(
    after.selfVendor.canceledShareBy,
    before.selfVendor.canceledShareBy,
    "Self-booking does not mutate Vendor canceledShareBy",
  );

  assertEqual(
    after.selfVendor.earning,
    before.selfVendor.earning,
    "Self-booking does not mutate Vendor earning",
  );

  assertEqual(
    after.referrer.pendingShareBy,
    before.referrer.pendingShareBy,
    "Self-booking does not increment referrer pendingShareBy",
  );

  assertEqual(
    after.referrer.completedShareBy,
    before.referrer.completedShareBy,
    "Self-booking does not mutate referrer completedShareBy",
  );

  assertEqual(
    after.referrer.canceledShareBy,
    before.referrer.canceledShareBy,
    "Self-booking does not mutate referrer canceledShareBy",
  );

  assertEqual(
    after.referrer.earning,
    before.referrer.earning,
    "Self-booking does not credit referral earning",
  );

  assertEqual(
    after.referrer.balance,
    before.referrer.balance,
    "Self-booking does not mutate referrer balance",
  );

  return {
    before,
    after,
  };
}

/**
 * ============================================================
 * POST-CREATION DUPLICATE
 * ============================================================
 */

async function testDuplicateSelfBooking() {
  section("POST-CONCURRENCY SELF-BOOKING DUPLICATE");

  const before = await getState();

  const result = await post({
    url: CREATE_API,
    token: selfVendorToken,
    body: legitimateSelfBookingBody(),
    prefix: "self-booking-duplicate",
  });

  console.log({
    status: result.status,
    data: result.data,
  });

  assert(
    result.status === 409 || result.status === 400,
    "Additional self-booking for occupied vendor/date is rejected",
    `[HTTP ${result.status}]`,
  );

  assert(result.status !== 500, "Duplicate self-booking does not produce HTTP 500");

  const after = await getState();

  const activeBookings = await Bookings.countDocuments({
    vendorId: selfVendor._id,
    bookingDate: BOOKING_DATE,
    cancelOrder: false,
    orderCompleted: false,
  });

  assertEqual(activeBookings, 1, "Duplicate attempt cannot create second active self-booking");

  assertEqual(
    after.selfVendor.bookingCount,
    before.selfVendor.bookingCount,
    "Rejected duplicate does not increment bookingCount again",
  );

  assertEqual(
    after.selfVendor.balance,
    before.selfVendor.balance,
    "Rejected duplicate does not mutate balance",
  );

  assertEqual(
    after.selfVendor.pending,
    before.selfVendor.pending,
    "Rejected duplicate does not mutate pending",
  );

  assertEqual(
    after.selfVendor.pendingVendor,
    before.selfVendor.pendingVendor,
    "Rejected duplicate does not mutate pendingVendor",
  );

  assertEqual(
    after.referrer.pendingShareBy,
    before.referrer.pendingShareBy,
    "Rejected duplicate does not mutate referral pendingShareBy",
  );

  assertEqual(
    after.referrer.earning,
    before.referrer.earning,
    "Rejected duplicate does not mutate referral earning",
  );
}

/**
 * ============================================================
 * CONCURRENT SELF-BOOKING COMPLETION
 * ============================================================
 */

async function testConcurrentCompletion() {
  section(`${CONCURRENCY}-WAY SELF-BOOKING COMPLETION CONCURRENCY`);

  if (!createdBookingId) {
    throw new Error("createdBookingId is missing");
  }

  const before = await getState();

  const bookingBefore = await Bookings.findById(createdBookingId).lean();

  if (!bookingBefore) {
    throw new Error("Created self-booking not found");
  }

  assertEqual(bookingBefore.cancelOrder, false, "Self-booking is not cancelled before completion");

  assertEqual(
    bookingBefore.orderCompleted,
    false,
    "Self-booking is not completed before completion race",
  );

  console.log(`Sending ${CONCURRENCY} concurrent self-booking completion requests...`);

  const start = Date.now();

  const results = await Promise.all(
    Array.from({ length: CONCURRENCY }, (_, index) =>
      patch({
        url: COMPLETE_API,
        token: selfVendorToken,

        body: {
          bookingId: createdBookingId,
        },

        prefix: "self-booking-complete",
        index,
      }),
    ),
  );

  const elapsedMs = Date.now() - start;

  const successes = results.filter((result) => result.status >= 200 && result.status < 300);

  const serverErrors = results.filter(
    (result) => typeof result.status === "number" && result.status >= 500,
  );

  const networkErrors = results.filter((result) => result.status === "NETWORK_ERROR");

  const statusCounts = results.reduce((acc, result) => {
    const key = String(result.status);

    acc[key] = (acc[key] || 0) + 1;

    return acc;
  }, {});

  console.log({
    elapsedMs,
    requests: results.length,
    successful: successes.length,
    serverErrors: serverErrors.length,
    networkErrors: networkErrors.length,
    statusCounts,
  });

  console.log({
    elapsedMs,
    requests: results.length,
    successful: successes.length,
    serverErrors: serverErrors.length,
    networkErrors: networkErrors.length,
    statusCounts,
  });

  // DEBUG: print the first failed completion response
  const firstFailure = results.find((result) => !(result.status >= 200 && result.status < 300));

  console.log("FIRST COMPLETION FAILURE:");
  console.dir(firstFailure, {
    depth: null,
  });

  assertEqual(
    results.length,
    CONCURRENCY,
    `Received results for all ${CONCURRENCY} completion requests`,
  );

  assertEqual(successes.length, 1, "Exactly one concurrent self-booking completion succeeds");

  assertEqual(serverErrors.length, 0, "Self-booking completion concurrency produces no HTTP 500");

  assertEqual(
    networkErrors.length,
    0,
    "Self-booking completion concurrency produces no network errors",
  );

  const after = await getState();

  const bookingAfter = await Bookings.findById(createdBookingId).lean();

  if (!bookingAfter) {
    throw new Error("Self-booking disappeared after completion");
  }

  assertEqual(bookingAfter.orderCompleted, true, "Self-booking becomes completed");

  assertEqual(bookingAfter.cancelOrder, false, "Completed self-booking is not cancelled");

  /**
   * ==========================================================
   * SELF-BOOKING COMPLETION ACCOUNTING
   * ==========================================================
   *
   * completeBooking() calls markBookingCompleted() and then
   * returns immediately for self-booking.
   *
   * Therefore NONE of the normal completion accounting/referral
   * mutations should occur.
   */

  assertEqual(
    after.selfVendor.bookingCount,
    before.selfVendor.bookingCount,
    "Completion does not increment bookingCount again",
  );

  assertEqual(
    after.selfVendor.balance,
    before.selfVendor.balance,
    "Self-booking completion does not mutate balance",
  );

  assertEqual(
    after.selfVendor.pending,
    before.selfVendor.pending,
    "Self-booking completion does not decrement pending",
  );

  assertEqual(
    after.selfVendor.completed,
    before.selfVendor.completed,
    "Self-booking completion does not increment customer completed",
  );

  assertEqual(
    after.selfVendor.canceled,
    before.selfVendor.canceled,
    "Self-booking completion does not mutate customer canceled",
  );

  assertEqual(
    after.selfVendor.bookingCountVendor,
    before.selfVendor.bookingCountVendor,
    "Self-booking completion does not mutate bookingCountVendor",
  );

  assertEqual(
    after.selfVendor.pendingVendor,
    before.selfVendor.pendingVendor,
    "Self-booking completion does not decrement pendingVendor",
  );

  assertEqual(
    after.selfVendor.completedVendor,
    before.selfVendor.completedVendor,
    "Self-booking completion does not increment completedVendor",
  );

  assertEqual(
    after.selfVendor.canceledVendor,
    before.selfVendor.canceledVendor,
    "Self-booking completion does not mutate canceledVendor",
  );

  assertEqual(
    after.selfVendor.pendingShareBy,
    before.selfVendor.pendingShareBy,
    "Self-booking completion does not mutate Vendor pendingShareBy",
  );

  assertEqual(
    after.selfVendor.completedShareBy,
    before.selfVendor.completedShareBy,
    "Self-booking completion does not mutate Vendor completedShareBy",
  );

  assertEqual(
    after.selfVendor.canceledShareBy,
    before.selfVendor.canceledShareBy,
    "Self-booking completion does not mutate Vendor canceledShareBy",
  );

  assertEqual(
    after.selfVendor.earning,
    before.selfVendor.earning,
    "Self-booking completion does not mutate Vendor earning",
  );

  assertEqual(
    after.referrer.pendingShareBy,
    before.referrer.pendingShareBy,
    "Self-booking completion does not decrement referrer pendingShareBy",
  );

  assertEqual(
    after.referrer.completedShareBy,
    before.referrer.completedShareBy,
    "Self-booking completion does not increment referrer completedShareBy",
  );

  assertEqual(
    after.referrer.canceledShareBy,
    before.referrer.canceledShareBy,
    "Self-booking completion does not mutate referrer canceledShareBy",
  );

  assertEqual(
    after.referrer.earning,
    before.referrer.earning,
    "Self-booking completion does not credit referral earning",
  );

  assertEqual(
    after.referrer.balance,
    before.referrer.balance,
    "Self-booking completion does not mutate referrer balance",
  );

  return {
    before,
    after,
  };
}

/**
 * ============================================================
 * COMPLETION REPLAY
 * ============================================================
 */

async function testCompletionReplay() {
  section("SELF-BOOKING COMPLETION REPLAY SAFETY");

  const before = await getState();

  const results = await Promise.all(
    Array.from({ length: 10 }, (_, index) =>
      patch({
        url: COMPLETE_API,
        token: selfVendorToken,

        body: {
          bookingId: createdBookingId,
        },

        prefix: "self-booking-completion-replay",
        index,
      }),
    ),
  );

  console.log({
    statuses: results.map((result) => result.status),
  });

  const successes = results.filter((result) => result.status >= 200 && result.status < 300);

  const serverErrors = results.filter(
    (result) => typeof result.status === "number" && result.status >= 500,
  );

  const networkErrors = results.filter((result) => result.status === "NETWORK_ERROR");

  assertEqual(successes.length, 0, "No self-booking completion replay succeeds");

  assertEqual(serverErrors.length, 0, "Completion replay produces no HTTP 500");

  assertEqual(networkErrors.length, 0, "Completion replay produces no network errors");

  const after = await getState();

  const booking = await Bookings.findById(createdBookingId).lean();

  if (!booking) {
    throw new Error("Self-booking disappeared during replay test");
  }

  assertEqual(booking.orderCompleted, true, "Self-booking remains completed after replay");

  assertEqual(booking.cancelOrder, false, "Replay cannot cancel completed self-booking");

  assertEqual(
    after.selfVendor.bookingCount,
    before.selfVendor.bookingCount,
    "Replay cannot increment bookingCount again",
  );

  assertEqual(
    after.selfVendor.balance,
    before.selfVendor.balance,
    "Replay cannot mutate Vendor balance",
  );

  assertEqual(
    after.selfVendor.pending,
    before.selfVendor.pending,
    "Replay cannot mutate Vendor pending",
  );

  assertEqual(
    after.selfVendor.completed,
    before.selfVendor.completed,
    "Replay cannot mutate Vendor completed",
  );

  assertEqual(
    after.selfVendor.pendingVendor,
    before.selfVendor.pendingVendor,
    "Replay cannot mutate pendingVendor",
  );

  assertEqual(
    after.selfVendor.completedVendor,
    before.selfVendor.completedVendor,
    "Replay cannot mutate completedVendor",
  );

  assertEqual(
    after.referrer.pendingShareBy,
    before.referrer.pendingShareBy,
    "Replay cannot mutate referrer pendingShareBy",
  );

  assertEqual(
    after.referrer.completedShareBy,
    before.referrer.completedShareBy,
    "Replay cannot mutate referrer completedShareBy",
  );

  assertEqual(
    after.referrer.earning,
    before.referrer.earning,
    "Replay cannot mutate referral earning",
  );

  assertEqual(
    after.referrer.balance,
    before.referrer.balance,
    "Replay cannot mutate referral balance",
  );
}

/**
 * ============================================================
 * FINAL INVARIANTS
 * ============================================================
 */

async function testFinalInvariants(initialState) {
  section("FINAL SELF-BOOKING DATABASE INVARIANTS");

  const finalState = await getState();

  const booking = await Bookings.findById(createdBookingId).lean();

  if (!booking) {
    throw new Error("Final self-booking not found");
  }

  const matchingBookings = await Bookings.find({
    vendorId: selfVendor._id,
    bookingDate: BOOKING_DATE,
  }).lean();

  assertEqual(matchingBookings.length, 1, "Exactly one self-booking document exists");

  assert(
    booking.userId.toString() === booking.vendorId.toString(),
    "Final booking remains a true self-booking",
  );

  assertEqual(
    booking.userId.toString(),
    selfVendor._id.toString(),
    "Final self-booking belongs to authenticated Vendor",
  );

  assertEqual(booking.orderCompleted, true, "Final self-booking state is COMPLETED");

  assertEqual(booking.cancelOrder, false, "Final self-booking is not cancelled");

  assertEqual(
    finalState.selfVendor.bookingCount,
    number(initialState.selfVendor.bookingCount) + 1,
    "Final bookingCount increased exactly once",
  );

  assertEqual(
    finalState.selfVendor.balance,
    initialState.selfVendor.balance,
    "Final Vendor balance is unchanged",
  );

  assertEqual(
    finalState.selfVendor.pending,
    initialState.selfVendor.pending,
    "Final customer pending is unchanged",
  );

  assertEqual(
    finalState.selfVendor.completed,
    initialState.selfVendor.completed,
    "Final customer completed is unchanged",
  );

  assertEqual(
    finalState.selfVendor.canceled,
    initialState.selfVendor.canceled,
    "Final customer canceled is unchanged",
  );

  assertEqual(
    finalState.selfVendor.bookingCountVendor,
    initialState.selfVendor.bookingCountVendor,
    "Final bookingCountVendor is unchanged",
  );

  assertEqual(
    finalState.selfVendor.pendingVendor,
    initialState.selfVendor.pendingVendor,
    "Final pendingVendor is unchanged",
  );

  assertEqual(
    finalState.selfVendor.completedVendor,
    initialState.selfVendor.completedVendor,
    "Final completedVendor is unchanged",
  );

  assertEqual(
    finalState.selfVendor.canceledVendor,
    initialState.selfVendor.canceledVendor,
    "Final canceledVendor is unchanged",
  );

  assertEqual(
    finalState.selfVendor.earning,
    initialState.selfVendor.earning,
    "Final Vendor earning is unchanged",
  );

  assertEqual(
    finalState.referrer.pendingShareBy,
    initialState.referrer.pendingShareBy,
    "Final referrer pendingShareBy is unchanged",
  );

  assertEqual(
    finalState.referrer.completedShareBy,
    initialState.referrer.completedShareBy,
    "Final referrer completedShareBy is unchanged",
  );

  assertEqual(
    finalState.referrer.canceledShareBy,
    initialState.referrer.canceledShareBy,
    "Final referrer canceledShareBy is unchanged",
  );

  assertEqual(
    finalState.referrer.earning,
    initialState.referrer.earning,
    "Final referrer earning is unchanged",
  );

  assertEqual(
    finalState.referrer.balance,
    initialState.referrer.balance,
    "Final referrer balance is unchanged",
  );

  assert(number(finalState.selfVendor.pending) >= 0, "Vendor pending remains non-negative");

  assert(
    number(finalState.selfVendor.pendingVendor) >= 0,
    "Vendor pendingVendor remains non-negative",
  );

  assert(
    number(finalState.selfVendor.pendingShareBy) >= 0,
    "Vendor pendingShareBy remains non-negative",
  );

  assert(
    number(finalState.referrer.pendingShareBy) >= 0,
    "Referrer pendingShareBy remains non-negative",
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
  let usersDeleted = 0;

  try {
    if (selfVendor?._id) {
      const bookingResult = await Bookings.deleteMany({
        $or: [
          {
            userId: selfVendor._id,
          },
          {
            vendorId: selfVendor._id,
          },
        ],
        bookingDate: BOOKING_DATE,
      });

      bookingsDeleted += bookingResult.deletedCount || 0;
    }

    if (fixtureIds.vendors.length > 0) {
      const vendorResult = await Vendor.deleteMany({
        _id: {
          $in: fixtureIds.vendors,
        },
      });

      vendorsDeleted += vendorResult.deletedCount || 0;
    }

    if (fixtureIds.users.length > 0) {
      const userResult = await User.deleteMany({
        _id: {
          $in: fixtureIds.users,
        },
      });

      usersDeleted += userResult.deletedCount || 0;
    }

    console.log({
      bookingsDeleted,
      vendorsDeleted,
      usersDeleted,
    });
  } catch (error) {
    console.error("Cleanup failed:", error);
  }
}

/**
 * ============================================================
 * MAIN
 * ============================================================
 */

async function run() {
  if (process.env.NODE_ENV !== "development" || process.env.ALLOW_AUTHORIZATION_TEST !== "1") {
    throw new Error(
      "Safety guard: run only with NODE_ENV=development and ALLOW_AUTHORIZATION_TEST=1",
    );
  }

  section("VENDOR SELF-BOOKING INVARIANT E2E TEST");

  console.log({
    createApi: CREATE_API,
    completeApi: COMPLETE_API,
    nodeEnv: process.env.NODE_ENV,
    concurrency: CONCURRENCY,
    bookingDate: BOOKING_DATE,
  });

  let initialState;

  try {
    await connectDatabase();

    await createFixtures();

    /**
     * Snapshot BEFORE any attack or legitimate booking.
     */
    initialState = await getState();

    section("PRE-TEST DATABASE STATE");

    assertEqual(initialState.bookings.length, 0, "No self-booking exists before test");

    assertEqual(initialState.selfVendor.balance, 10000, "Self Vendor starts with expected balance");

    assertEqual(
      initialState.selfVendor.bookingCount,
      10,
      "Self Vendor starts with expected bookingCount",
    );

    assertEqual(initialState.selfVendor.pending, 3, "Self Vendor starts with expected pending");

    assertEqual(
      initialState.selfVendor.bookingCountVendor,
      15,
      "Self Vendor starts with expected bookingCountVendor",
    );

    assertEqual(
      initialState.selfVendor.pendingVendor,
      4,
      "Self Vendor starts with expected pendingVendor",
    );

    assertEqual(
      initialState.referrer.pendingShareBy,
      6,
      "Referrer starts with expected pendingShareBy",
    );

    assertEqual(initialState.referrer.earning, 100, "Referrer starts with expected earning");

    /**
     * Security boundary.
     */
    await testForgedSelfBooking();

    /**
     * Creation concurrency + accounting.
     */
    await testConcurrentSelfBookingCreation();

    /**
     * Duplicate after successful creation.
     */
    await testDuplicateSelfBooking();

    /**
     * Completion concurrency.
     */
    await testConcurrentCompletion();

    /**
     * Replay/idempotency.
     */
    await testCompletionReplay();

    /**
     * End-to-end exact state.
     */
    await testFinalInvariants(initialState);
  } finally {
    await cleanup();

    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();

      console.log("MongoDB disconnected.");
    }
  }

  section("FINAL SELF-BOOKING INVARIANT TEST SUMMARY");

  console.log(`Assertions: ${assertions}`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);

  if (failed > 0) {
    throw new Error(`SELF-BOOKING INVARIANT TEST FAILED: ${failed} assertion(s) failed`);
  }

  console.log("");
  console.log("PASS: VENDOR SELF-BOOKING INVARIANTS PASSED");

  console.log("");
  console.log("Verified:");
  console.log("");
  console.log("✓ Forged self-booking where userId !== vendorId is rejected");
  console.log("✓ Forged self-booking causes no accounting mutation");
  console.log(`✓ ${CONCURRENCY} concurrent self-booking requests create exactly one booking`);
  console.log("✓ Self-booking has userId === vendorId");
  console.log("✓ Self-booking increments bookingCount exactly once");
  console.log("✓ Self-booking does not deduct Vendor balance");
  console.log("✓ Self-booking does not increment normal pending counters");
  console.log("✓ Self-booking does not perform provider-side accounting");
  console.log("✓ Self-booking does not create referral pending state");
  console.log("✓ Self-booking does not credit referral earning");
  console.log(`✓ ${CONCURRENCY} concurrent completion requests produce exactly one success`);
  console.log("✓ Self-booking completes exactly once");
  console.log("✓ Self-booking completion performs no normal accounting");
  console.log("✓ Self-booking completion performs no referral accounting");
  console.log("✓ Completion replay cannot mutate state twice");
  console.log("✓ Pending counters remain non-negative");
  console.log("✓ Concurrent operations produce no HTTP 500 responses");
  console.log("✓ Concurrent operations produce no network errors");
}

/**
 * ============================================================
 * RUN
 * ============================================================
 */

run().catch((error) => {
  console.error("");

  section("TEST FAILED");

  console.error(error);

  process.exitCode = 1;
});
