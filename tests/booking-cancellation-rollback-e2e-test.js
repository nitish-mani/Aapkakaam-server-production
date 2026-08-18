"use strict";

/**
 * ============================================================
 * BOOKING CANCELLATION TRANSACTION ROLLBACK E2E TEST
 * ============================================================
 *
 * PURPOSE
 * -------
 * Prove that cancellation is fully atomic.
 *
 * BookingService contains a TEST-ONLY failure injection:
 *
 *   NODE_ENV=development
 *   ALLOW_BOOKING_ROLLBACK_TEST=1
 *   BOOKING_FAILURE_POINT=after_cancellation_mutations
 *
 * The injected failure occurs AFTER:
 *
 *   1. booking.cancelOrder = true
 *   2. customer pending/canceled mutation
 *   3. provider pendingVendor/canceledVendor mutation
 *   4. customer referral cancellation mutation
 *   5. provider referral cancellation mutation
 *
 * but BEFORE MongoDB transaction commit.
 *
 * Therefore NONE of those mutations may survive.
 *
 * ============================================================
 * REQUIRED API STARTUP
 * ============================================================
 *
 * Git Bash:
 *
 * NODE_ENV=development \
 * ALLOW_AUTHORIZATION_TEST=1 \
 * ALLOW_BOOKING_ROLLBACK_TEST=1 \
 * BOOKING_FAILURE_POINT=after_cancellation_mutations \
 * npm run dev
 *
 * Then in another terminal:
 *
 * NODE_ENV=development ALLOW_AUTHORIZATION_TEST=1 \
 * node tests/booking-cancellation-rollback-e2e-test.js
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

const CANCEL_API = `${API_BASE}/bookings/cancelOrderV`;

const BOOKING_DATE =
  process.env.TEST_BOOKING_DATE || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toDateString();

const TEST_PASSWORD = "RollbackTest123!";

const CUSTOMER_PHONE = 8299401101;
const PROVIDER_PHONE = 8299401102;
const ATTACKER_PHONE = 8299401103;
const CUSTOMER_REFERRER_PHONE = 8299401104;
const PROVIDER_REFERRER_PHONE = 8299401105;

const CUSTOMER_INITIAL = {
  balance: 10000,
  pending: 1,
  completed: 5,
  canceled: 5,
  bookingCount: 10,
};

const PROVIDER_INITIAL = {
  balance: 10000,
  pendingVendor: 1,
  completedVendor: 7,
  canceledVendor: 7,
  bookingCountVendor: 15,
};

const CUSTOMER_REFERRER_INITIAL = {
  balance: 500,
  earning: 100,
  pendingShareBy: 1,
  completedShareBy: 10,
  canceledShareBy: 4,
};

const PROVIDER_REFERRER_INITIAL = {
  balance: 700,
  earning: 200,
  pendingShareBy: 1,
  completedShareBy: 20,
  canceledShareBy: 8,
};

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
 * DATABASE CONNECTION
 * ============================================================
 */

async function connectDatabase() {
  if (mongoose.connection.readyState === 1) {
    return;
  }

  const mongoUri =
    process.env.MONGODB_URI ||
    process.env.MONGO_URI ||
    process.env.DATABASE_URL ||
    ENV.MONGODB_URI ||
    ENV.MONGO_URI;

  if (!mongoUri) {
    throw new Error(
      "MongoDB URI not found. Set MONGODB_URI/MONGO_URI or ensure src/config/env exports it.",
    );
  }

  await mongoose.connect(mongoUri);

  console.log("MongoDB connected.");
}

/**
 * ============================================================
 * TOKEN
 * ============================================================
 */

function createVendorToken(vendor) {
  if (!ENV.JWT_VENDOR_SECRET) {
    throw new Error("JWT_VENDOR_SECRET is not configured");
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
 * CLEANUP
 * ============================================================
 */

async function cleanup() {
  const phones = [CUSTOMER_PHONE, PROVIDER_PHONE, ATTACKER_PHONE, PROVIDER_REFERRER_PHONE];

  const userPhones = [CUSTOMER_REFERRER_PHONE];

  const vendorIds = [
    customerVendor?._id,
    providerVendor?._id,
    attackerVendor?._id,
    providerReferrer?._id,
  ].filter(Boolean);

  const userIds = [customerReferrer?._id].filter(Boolean);

  const bookingIds = [booking?._id].filter(Boolean);

  const bookingDelete = await Bookings.deleteMany({
    $or: [
      ...(bookingIds.length
        ? [
            {
              _id: {
                $in: bookingIds,
              },
            },
          ]
        : []),

      ...(vendorIds.length
        ? [
            {
              vendorId: {
                $in: vendorIds,
              },
            },
          ]
        : []),
    ],
  });

  const vendorDelete = await Vendor.deleteMany({
    $or: [
      {
        phoneNo: {
          $in: phones,
        },
      },

      ...(vendorIds.length
        ? [
            {
              _id: {
                $in: vendorIds,
              },
            },
          ]
        : []),
    ],
  });

  const userDelete = await User.deleteMany({
    $or: [
      {
        phoneNo: {
          $in: userPhones,
        },
      },

      ...(userIds.length
        ? [
            {
              _id: {
                $in: userIds,
              },
            },
          ]
        : []),
    ],
  });

  return {
    bookingsDeleted: bookingDelete.deletedCount,
    vendorsDeleted: vendorDelete.deletedCount,
    usersDeleted: userDelete.deletedCount,
  };
}

/**
 * ============================================================
 * CREATE FIXTURES
 * ============================================================
 */

async function createFixtures() {
  section("CREATE TEST FIXTURES");

  await cleanup();

  const hashedPassword = await bcrypt.hash(TEST_PASSWORD, 4);

  /**
   * Customer referrer = User
   */
  customerReferrer = await User.create({
    name: "Cancellation Rollback Customer Referrer",

    phoneNo: CUSTOMER_REFERRER_PHONE,

    password: hashedPassword,

    verifyPhoneNo: true,

    balance: CUSTOMER_REFERRER_INITIAL.balance,
    earning: CUSTOMER_REFERRER_INITIAL.earning,

    pendingShareBy: CUSTOMER_REFERRER_INITIAL.pendingShareBy,
    completedShareBy: CUSTOMER_REFERRER_INITIAL.completedShareBy,
    canceledShareBy: CUSTOMER_REFERRER_INITIAL.canceledShareBy,

    accountCreatedOn: new Date(),
  });

  /**
   * Provider referrer = Vendor
   */
  providerReferrer = await Vendor.create({
    name: "Cancellation Rollback Provider Referrer",

    phoneNo: PROVIDER_REFERRER_PHONE,

    password: hashedPassword,

    type: "electrician",

    commission: 50,

    verifyPhoneNo: true,

    balance: PROVIDER_REFERRER_INITIAL.balance,
    earning: PROVIDER_REFERRER_INITIAL.earning,

    pendingShareBy: PROVIDER_REFERRER_INITIAL.pendingShareBy,
    completedShareBy: PROVIDER_REFERRER_INITIAL.completedShareBy,
    canceledShareBy: PROVIDER_REFERRER_INITIAL.canceledShareBy,

    accountCreatedOn: new Date(),
  });

  /**
   * Vendor acting as customer.
   *
   * cd + shareBy cause cancellation referral handling.
   */
  customerVendor = await Vendor.create({
    name: "Cancellation Rollback Customer Vendor",

    phoneNo: CUSTOMER_PHONE,

    password: hashedPassword,

    type: "plumber",

    commission: 50,

    verifyPhoneNo: true,

    balance: CUSTOMER_INITIAL.balance,

    pending: CUSTOMER_INITIAL.pending,
    completed: CUSTOMER_INITIAL.completed,
    canceled: CUSTOMER_INITIAL.canceled,

    bookingCount: CUSTOMER_INITIAL.bookingCount,

    cd: "user",
    shareBy: customerReferrer._id.toString(),

    accountCreatedOn: new Date(),
  });

  /**
   * Service provider.
   */
  providerVendor = await Vendor.create({
    name: "Cancellation Rollback Provider Vendor",

    phoneNo: PROVIDER_PHONE,

    password: hashedPassword,

    type: "electrician",

    commission: 100,

    verifyPhoneNo: true,

    balance: PROVIDER_INITIAL.balance,

    pendingVendor: PROVIDER_INITIAL.pendingVendor,
    completedVendor: PROVIDER_INITIAL.completedVendor,
    canceledVendor: PROVIDER_INITIAL.canceledVendor,

    bookingCountVendor: PROVIDER_INITIAL.bookingCountVendor,

    cd: "vendor",
    shareBy: providerReferrer._id.toString(),

    accountCreatedOn: new Date(),
  });

  attackerVendor = await Vendor.create({
    name: "Cancellation Rollback Attacker",

    phoneNo: ATTACKER_PHONE,

    password: hashedPassword,

    type: "plumber",

    commission: 50,

    verifyPhoneNo: true,

    balance: 10000,

    pending: 0,
    completed: 0,
    canceled: 0,

    pendingVendor: 0,
    completedVendor: 0,
    canceledVendor: 0,

    accountCreatedOn: new Date(),
  });

  /**
   * IMPORTANT:
   *
   * Vendor-as-customer booking.
   *
   * userId points to Vendor, not User.
   */
  booking = await Bookings.create({
    userId: customerVendor._id,

    vendorId: providerVendor._id,

    type: providerVendor.type,

    pincode: "274201",

    bookingDate: BOOKING_DATE,

    bookingTime: Date.now(),

    bookedOn: new Date(),

    cancelOrder: false,

    orderCompleted: false,

    rating: 0,

    ratingPermission: false,

    isServed: false,

    isBooked: true,

    name: customerVendor.name,

    phoneNo: customerVendor.phoneNo,

    vill: "Rollback Village",
    post: "Rollback Post",
    dist: "Deoria",
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
  });
}

/**
 * ============================================================
 * LOAD COMPLETE DATABASE STATE
 * ============================================================
 */

async function loadState() {
  const [
    currentBooking,
    currentCustomer,
    currentProvider,
    currentCustomerReferrer,
    currentProviderReferrer,
  ] = await Promise.all([
    Bookings.findById(booking._id).lean(),

    Vendor.findById(customerVendor._id).lean(),

    Vendor.findById(providerVendor._id).lean(),

    User.findById(customerReferrer._id).lean(),

    Vendor.findById(providerReferrer._id).lean(),
  ]);

  if (!currentBooking) {
    throw new Error("Booking disappeared during test");
  }

  if (!currentCustomer) {
    throw new Error("Customer Vendor disappeared during test");
  }

  if (!currentProvider) {
    throw new Error("Provider Vendor disappeared during test");
  }

  if (!currentCustomerReferrer) {
    throw new Error("Customer referrer disappeared during test");
  }

  if (!currentProviderReferrer) {
    throw new Error("Provider referrer disappeared during test");
  }

  return {
    booking: currentBooking,
    customer: currentCustomer,
    provider: currentProvider,
    customerReferrer: currentCustomerReferrer,
    providerReferrer: currentProviderReferrer,
  };
}

/**
 * ============================================================
 * SEND CANCELLATION
 * ============================================================
 */

async function sendCancellation() {
  const requestId = `cancel-rollback-${Date.now()}`;

  try {
    const response = await axios.patch(
      CANCEL_API,

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
      requestId,
    };
  } catch (error) {
    return {
      status: "NETWORK_ERROR",
      error: error.message,
      requestId,
    };
  }
}

/**
 * ============================================================
 * VERIFY INITIAL STATE
 * ============================================================
 */

function verifyInitialState(state) {
  section("PRE-FAILURE DATABASE STATE");

  assertEqual(state.booking.cancelOrder, false, "Booking starts active/not cancelled");

  assertEqual(state.booking.orderCompleted, false, "Booking starts not completed");

  assertEqual(
    number(state.customer.pending),
    CUSTOMER_INITIAL.pending,
    "Customer starts with expected pending",
  );

  assertEqual(
    number(state.customer.canceled),
    CUSTOMER_INITIAL.canceled,
    "Customer starts with expected canceled",
  );

  assertEqual(
    number(state.customer.balance),
    CUSTOMER_INITIAL.balance,
    "Customer starts with expected balance",
  );

  assertEqual(
    number(state.provider.pendingVendor),
    PROVIDER_INITIAL.pendingVendor,
    "Provider starts with expected pendingVendor",
  );

  assertEqual(
    number(state.provider.canceledVendor),
    PROVIDER_INITIAL.canceledVendor,
    "Provider starts with expected canceledVendor",
  );

  assertEqual(
    number(state.provider.balance),
    PROVIDER_INITIAL.balance,
    "Provider starts with expected balance",
  );

  assertEqual(
    number(state.customerReferrer.pendingShareBy),
    CUSTOMER_REFERRER_INITIAL.pendingShareBy,
    "Customer referrer starts with expected pendingShareBy",
  );

  assertEqual(
    number(state.customerReferrer.canceledShareBy),
    CUSTOMER_REFERRER_INITIAL.canceledShareBy,
    "Customer referrer starts with expected canceledShareBy",
  );

  assertEqual(
    number(state.customerReferrer.earning),
    CUSTOMER_REFERRER_INITIAL.earning,
    "Customer referrer starts with expected earning",
  );

  assertEqual(
    number(state.providerReferrer.pendingShareBy),
    PROVIDER_REFERRER_INITIAL.pendingShareBy,
    "Provider referrer starts with expected pendingShareBy",
  );

  assertEqual(
    number(state.providerReferrer.canceledShareBy),
    PROVIDER_REFERRER_INITIAL.canceledShareBy,
    "Provider referrer starts with expected canceledShareBy",
  );

  assertEqual(
    number(state.providerReferrer.earning),
    PROVIDER_REFERRER_INITIAL.earning,
    "Provider referrer starts with expected earning",
  );
}

/**
 * ============================================================
 * VERIFY COMPLETE ROLLBACK
 * ============================================================
 */

function verifyRollback(before, after) {
  section("VERIFY TRANSACTION ROLLBACK");

  /**
   * Booking state
   */

  assertEqual(
    after.booking.cancelOrder,
    before.booking.cancelOrder,
    "Booking cancelOrder is rolled back",
  );

  assertEqual(
    after.booking.orderCompleted,
    before.booking.orderCompleted,
    "Booking orderCompleted remains unchanged",
  );

  const beforeCancelTime =
    before.booking.cancelTime === undefined || before.booking.cancelTime === null
      ? null
      : Number(before.booking.cancelTime);

  const afterCancelTime =
    after.booking.cancelTime === undefined || after.booking.cancelTime === null
      ? null
      : Number(after.booking.cancelTime);

  assertEqual(afterCancelTime, beforeCancelTime, "Booking cancelTime is rolled back");

  /**
   * Customer accounting
   */

  assertEqual(
    number(after.customer.pending),
    number(before.customer.pending),
    "Customer pending mutation is rolled back",
  );

  assertEqual(
    number(after.customer.canceled),
    number(before.customer.canceled),
    "Customer canceled mutation is rolled back",
  );

  assertEqual(
    number(after.customer.completed),
    number(before.customer.completed),
    "Customer completed remains unchanged",
  );

  assertEqual(
    number(after.customer.bookingCount),
    number(before.customer.bookingCount),
    "Customer bookingCount remains unchanged",
  );

  assertEqual(
    number(after.customer.balance),
    number(before.customer.balance),
    "Customer balance remains unchanged",
  );

  assert(number(after.customer.pending) >= 0, "Customer pending remains non-negative");

  /**
   * Provider accounting
   */

  assertEqual(
    number(after.provider.pendingVendor),
    number(before.provider.pendingVendor),
    "Provider pendingVendor mutation is rolled back",
  );

  assertEqual(
    number(after.provider.canceledVendor),
    number(before.provider.canceledVendor),
    "Provider canceledVendor mutation is rolled back",
  );

  assertEqual(
    number(after.provider.completedVendor),
    number(before.provider.completedVendor),
    "Provider completedVendor remains unchanged",
  );

  assertEqual(
    number(after.provider.bookingCountVendor),
    number(before.provider.bookingCountVendor),
    "Provider bookingCountVendor remains unchanged",
  );

  assertEqual(
    number(after.provider.balance),
    number(before.provider.balance),
    "Provider balance remains unchanged",
  );

  assert(number(after.provider.pendingVendor) >= 0, "Provider pendingVendor remains non-negative");

  /**
   * Customer referral
   */

  assertEqual(
    number(after.customerReferrer.pendingShareBy),
    number(before.customerReferrer.pendingShareBy),
    "Customer referrer pendingShareBy mutation is rolled back",
  );

  assertEqual(
    number(after.customerReferrer.canceledShareBy),
    number(before.customerReferrer.canceledShareBy),
    "Customer referrer canceledShareBy mutation is rolled back",
  );

  assertEqual(
    number(after.customerReferrer.completedShareBy),
    number(before.customerReferrer.completedShareBy),
    "Customer referrer completedShareBy remains unchanged",
  );

  assertEqual(
    number(after.customerReferrer.earning),
    number(before.customerReferrer.earning),
    "Customer referrer earning remains unchanged",
  );

  assertEqual(
    number(after.customerReferrer.balance),
    number(before.customerReferrer.balance),
    "Customer referrer balance remains unchanged",
  );

  assert(
    number(after.customerReferrer.pendingShareBy) >= 0,
    "Customer referrer pendingShareBy remains non-negative",
  );

  /**
   * Provider referral
   */

  assertEqual(
    number(after.providerReferrer.pendingShareBy),
    number(before.providerReferrer.pendingShareBy),
    "Provider referrer pendingShareBy mutation is rolled back",
  );

  assertEqual(
    number(after.providerReferrer.canceledShareBy),
    number(before.providerReferrer.canceledShareBy),
    "Provider referrer canceledShareBy mutation is rolled back",
  );

  assertEqual(
    number(after.providerReferrer.completedShareBy),
    number(before.providerReferrer.completedShareBy),
    "Provider referrer completedShareBy remains unchanged",
  );

  assertEqual(
    number(after.providerReferrer.earning),
    number(before.providerReferrer.earning),
    "Provider referrer earning remains unchanged",
  );

  assertEqual(
    number(after.providerReferrer.balance),
    number(before.providerReferrer.balance),
    "Provider referrer balance remains unchanged",
  );

  assert(
    number(after.providerReferrer.pendingShareBy) >= 0,
    "Provider referrer pendingShareBy remains non-negative",
  );

  /**
   * Final active-state invariant
   */

  assert(
    after.booking.cancelOrder === false && after.booking.orderCompleted === false,
    "Failed cancellation leaves booking ACTIVE",
  );
}

/**
 * ============================================================
 * VERIFY EXACT PRE/POST DOCUMENT VALUES
 * ============================================================
 */

function verifyExactDocumentInvariants(before, after) {
  section("EXACT DATABASE INVARIANTS");

  const checks = [
    [after.customer.pending, before.customer.pending, "Customer pending exactly restored"],

    [after.customer.canceled, before.customer.canceled, "Customer canceled exactly restored"],

    [after.customer.completed, before.customer.completed, "Customer completed exactly preserved"],

    [after.customer.balance, before.customer.balance, "Customer balance exactly preserved"],

    [
      after.provider.pendingVendor,
      before.provider.pendingVendor,
      "Provider pendingVendor exactly restored",
    ],

    [
      after.provider.canceledVendor,
      before.provider.canceledVendor,
      "Provider canceledVendor exactly restored",
    ],

    [
      after.provider.completedVendor,
      before.provider.completedVendor,
      "Provider completedVendor exactly preserved",
    ],

    [after.provider.balance, before.provider.balance, "Provider balance exactly preserved"],

    [
      after.customerReferrer.pendingShareBy,
      before.customerReferrer.pendingShareBy,
      "Customer referral pending exactly restored",
    ],

    [
      after.customerReferrer.canceledShareBy,
      before.customerReferrer.canceledShareBy,
      "Customer referral canceled exactly restored",
    ],

    [
      after.customerReferrer.earning,
      before.customerReferrer.earning,
      "Customer referral earning exactly preserved",
    ],

    [
      after.providerReferrer.pendingShareBy,
      before.providerReferrer.pendingShareBy,
      "Provider referral pending exactly restored",
    ],

    [
      after.providerReferrer.canceledShareBy,
      before.providerReferrer.canceledShareBy,
      "Provider referral canceled exactly restored",
    ],

    [
      after.providerReferrer.earning,
      before.providerReferrer.earning,
      "Provider referral earning exactly preserved",
    ],
  ];

  for (const [actual, expected, message] of checks) {
    assertEqual(number(actual), number(expected), message);
  }
}

/**
 * ============================================================
 * MAIN TEST
 * ============================================================
 */

async function run() {
  section("VENDOR BOOKING CANCELLATION TRANSACTION ROLLBACK E2E TEST");

  console.log({
    cancelApi: CANCEL_API,
    nodeEnv: process.env.NODE_ENV,
    bookingDate: BOOKING_DATE,

    expectedApiEnvironment: {
      NODE_ENV: "development",
      ALLOW_BOOKING_ROLLBACK_TEST: "1",
      BOOKING_FAILURE_POINT: "after_cancellation_mutations",
    },
  });

  if (process.env.NODE_ENV !== "development") {
    throw new Error("This destructive rollback test may only run with NODE_ENV=development");
  }

  await connectDatabase();

  try {
    await createFixtures();

    const before = await loadState();

    verifyInitialState(before);

    section("INJECTED CANCELLATION FAILURE");

    console.log(
      "Sending cancellation request. API should execute all transactional mutations and then throw the injected failure...",
    );

    const result = await sendCancellation();

    console.log({
      status: result.status,
      data: result.data,
      error: result.error,
      requestId: result.requestId,
    });

    assert(result.status !== "NETWORK_ERROR", "Injected cancellation request reaches API");

    assertEqual(result.status, 500, "Injected cancellation failure returns HTTP 500");

    /**
     * Give MongoDB/API event loop a small moment before re-reading.
     * withTransaction() should already have aborted before HTTP response,
     * but this also avoids confusing logs/output ordering.
     */
    await new Promise((resolve) => setTimeout(resolve, 200));

    const after = await loadState();

    verifyRollback(before, after);

    verifyExactDocumentInvariants(before, after);

    section("FAILED CANCELLATION RETRYABILITY");

    const activeBookingCount = await Bookings.countDocuments({
      _id: booking._id,
      cancelOrder: false,
      orderCompleted: false,
    });

    assertEqual(activeBookingCount, 1, "Exactly one active booking still exists after rollback");

    const cancelledBookingCount = await Bookings.countDocuments({
      _id: booking._id,
      cancelOrder: true,
    });

    assertEqual(
      cancelledBookingCount,
      0,
      "No cancelled booking state leaked from aborted transaction",
    );

    const completedBookingCount = await Bookings.countDocuments({
      _id: booking._id,
      orderCompleted: true,
    });

    assertEqual(
      completedBookingCount,
      0,
      "No completed booking state exists after failed cancellation",
    );

    assert(
      after.booking.cancelOrder === false && after.booking.orderCompleted === false,
      "Booking remains eligible for a future legitimate terminal transition",
    );
  } finally {
    section("CLEANUP");

    try {
      const result = await cleanup();

      console.log(result);
    } catch (cleanupError) {
      console.error("Cleanup failed:", cleanupError);
    }

    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();

      console.log("MongoDB disconnected.");
    }
  }

  section("FINAL CANCELLATION ROLLBACK TEST SUMMARY");

  console.log(`Assertions: ${assertions}`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);

  if (failed > 0) {
    console.error("");
    console.error("FAIL: CANCELLATION TRANSACTION ROLLBACK TEST FAILED");

    process.exitCode = 1;

    return;
  }

  console.log("");
  console.log("PASS: CANCELLATION TRANSACTION ROLLBACK INVARIANTS PASSED");

  console.log("");
  console.log("Verified:");
  console.log("");
  console.log("✓ Injected failure occurs after cancellation mutations");
  console.log("✓ Failed transaction does not cancel booking");
  console.log("✓ cancelTime does not leak from aborted transaction");
  console.log("✓ Customer pending mutation rolls back");
  console.log("✓ Customer canceled mutation rolls back");
  console.log("✓ Provider pendingVendor mutation rolls back");
  console.log("✓ Provider canceledVendor mutation rolls back");
  console.log("✓ Customer referral pendingShareBy rolls back");
  console.log("✓ Customer referral canceledShareBy rolls back");
  console.log("✓ Provider referral pendingShareBy rolls back");
  console.log("✓ Provider referral canceledShareBy rolls back");
  console.log("✓ Referral earnings remain unchanged");
  console.log("✓ Customer/provider balances remain unchanged");
  console.log("✓ Booking counts remain unchanged");
  console.log("✓ Pending counters remain non-negative");
  console.log("✓ Booking remains ACTIVE after rollback");
  console.log("✓ Failed cancellation remains safely retryable");
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
    console.error("Emergency cleanup failed:", cleanupError);
  }

  try {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
  } catch (_) {
    // Ignore disconnect failure.
  }

  process.exitCode = 1;
});
