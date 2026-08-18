"use strict";

/**
 * ============================================================
 * VENDOR BOOKING CREATION TRANSACTION ROLLBACK E2E TEST
 * ============================================================
 *
 * Proves createVendorBooking() is transactionally atomic.
 *
 * API SERVER MUST RUN WITH:
 *
 * NODE_ENV=development
 * ALLOW_BOOKING_ROLLBACK_TEST=1
 * BOOKING_FAILURE_POINT=after_vendor_creation_mutations
 *
 * Expected transactional mutations before injected failure:
 *
 * 1. Booking inserted
 * 2. Customer Vendor balance deducted
 * 3. Customer Vendor bookingCount +1
 * 4. Customer Vendor pending +1
 * 5. Provider Vendor balance deducted
 * 6. Provider Vendor bookingCountVendor +1
 * 7. Provider Vendor pendingVendor +1
 * 8. Customer referrer pendingShareBy +1
 * 9. Provider referrer pendingShareBy +1
 * 10. Injected failure
 *
 * ALL mutations must rollback.
 */

const mongoose = require("mongoose");
const axios = require("axios");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");

const User = require("../models/user");
const Vendor = require("../models/vendor");
const Bookings = require("../models/bookings");
const ENV = require("../src/config/env");

/**
 * ============================================================
 * CONFIG
 * ============================================================
 */

const BASE_URL = process.env.TEST_API_BASE_URL || "http://localhost:3000";

const CREATE_API = `${BASE_URL}/api/bookings/postToBookingsV`;

const BOOKING_TYPE = process.env.TEST_BOOKING_TYPE || "electrician";

const PINCODE = process.env.TEST_BOOKING_PINCODE || "274201";

const BOOKING_DATE =
  process.env.TEST_BOOKING_DATE || new Date(Date.now() + 11 * 24 * 60 * 60 * 1000).toDateString();

/**
 * Customer Vendor state.
 */
const CUSTOMER_BALANCE = 10000;
const CUSTOMER_BOOKING_COUNT = 10;
const CUSTOMER_PENDING = 3;
const CUSTOMER_COMPLETED = 5;
const CUSTOMER_CANCELED = 2;

/**
 * Provider Vendor state.
 */
const PROVIDER_BALANCE = 10000;
const PROVIDER_BOOKING_COUNT = 15;
const PROVIDER_PENDING = 4;
const PROVIDER_COMPLETED = 7;
const PROVIDER_CANCELED = 3;

const PROVIDER_COMMISSION = 100;

/**
 * Customer referrer state.
 */
const CUSTOMER_REFERRER_PENDING = 6;
const CUSTOMER_REFERRER_COMPLETED = 10;
const CUSTOMER_REFERRER_CANCELED = 4;
const CUSTOMER_REFERRER_EARNING = 100;
const CUSTOMER_REFERRER_BALANCE = 500;

/**
 * Provider referrer state.
 */
const PROVIDER_REFERRER_PENDING = 8;
const PROVIDER_REFERRER_COMPLETED = 20;
const PROVIDER_REFERRER_CANCELED = 9;
const PROVIDER_REFERRER_EARNING = 200;
const PROVIDER_REFERRER_BALANCE = 700;

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

let customerReferrer;
let providerReferrer;

let authToken;

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

function assert(condition, message, details = "") {
  assertions += 1;

  if (condition) {
    passed += 1;

    console.log(`✓ ${message}${details ? ` ${details}` : ""}`);

    return;
  }

  failed += 1;

  console.error(`✗ ${message}${details ? ` ${details}` : ""}`);
}

function assertEqual(actual, expected, message) {
  assert(actual === expected, message, `[expected=${expected}, actual=${actual}]`);
}

function number(value) {
  return Number(value || 0);
}

function makePhone(offset) {
  return 8200000000 + offset + Math.floor(Math.random() * 100000);
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
    throw new Error("MongoDB URI not found. Expected MONGODB_URI / MONGO_URI.");
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

  const password = await bcrypt.hash("RollbackTest123!", 12);

  /**
   * ----------------------------------------------------------
   * CUSTOMER REFERRER
   * ----------------------------------------------------------
   *
   * Deliberately User so we test cross-model referral lookup.
   */

  customerReferrer = await User.create({
    name: "Vendor Booking Customer Referrer",

    phoneNo: makePhone(100),

    password,

    verifyPhoneNo: true,

    balance: CUSTOMER_REFERRER_BALANCE,

    pendingShareBy: CUSTOMER_REFERRER_PENDING,

    completedShareBy: CUSTOMER_REFERRER_COMPLETED,

    canceledShareBy: CUSTOMER_REFERRER_CANCELED,

    earning: CUSTOMER_REFERRER_EARNING,

    pending: 0,
    completed: 0,
    canceled: 0,

    bookingCount: 0,

    cd: "user",

    pincode: PINCODE,
  });

  /**
   * ----------------------------------------------------------
   * PROVIDER REFERRER
   * ----------------------------------------------------------
   */

  providerReferrer = await Vendor.create({
    name: "Vendor Booking Provider Referrer",

    phoneNo: makePhone(200),

    password,

    type: BOOKING_TYPE,

    verifyPhoneNo: true,

    isVerified: true,

    balance: PROVIDER_REFERRER_BALANCE,

    pendingShareBy: PROVIDER_REFERRER_PENDING,

    completedShareBy: PROVIDER_REFERRER_COMPLETED,

    canceledShareBy: PROVIDER_REFERRER_CANCELED,

    earning: PROVIDER_REFERRER_EARNING,

    commission: 50,

    pending: 0,
    completed: 0,
    canceled: 0,

    pendingVendor: 0,
    completedVendor: 0,
    canceledVendor: 0,

    bookingCount: 0,
    bookingCountVendor: 0,

    cd: "vendor",

    pincode: PINCODE,
  });

  /**
   * ----------------------------------------------------------
   * CUSTOMER VENDOR
   * ----------------------------------------------------------
   *
   * This Vendor acts as the CUSTOMER.
   *
   * Therefore booking.userId contains a Vendor _id.
   */

  customerVendor = await Vendor.create({
    name: "Rollback Customer Vendor",

    phoneNo: makePhone(300),

    password,

    type: "plumber",

    verifyPhoneNo: true,

    isVerified: true,

    balance: CUSTOMER_BALANCE,

    pending: CUSTOMER_PENDING,

    completed: CUSTOMER_COMPLETED,

    canceled: CUSTOMER_CANCELED,

    bookingCount: CUSTOMER_BOOKING_COUNT,

    pendingVendor: 0,
    completedVendor: 0,
    canceledVendor: 0,

    bookingCountVendor: 0,

    transactionCount: 0,

    totalDiscount: 0,

    shareBy: customerReferrer._id.toString(),

    /**
     * shareBy points to User.
     */
    cd: "user",

    commission: 50,

    pincode: PINCODE,
  });

  /**
   * ----------------------------------------------------------
   * SERVICE PROVIDER VENDOR
   * ----------------------------------------------------------
   */

  providerVendor = await Vendor.create({
    name: "Rollback Provider Vendor",

    phoneNo: makePhone(400),

    password,

    type: BOOKING_TYPE,

    verifyPhoneNo: true,

    isVerified: true,

    balance: PROVIDER_BALANCE,

    commission: PROVIDER_COMMISSION,

    pending: 0,
    completed: 0,
    canceled: 0,

    bookingCount: 0,

    pendingVendor: PROVIDER_PENDING,

    completedVendor: PROVIDER_COMPLETED,

    canceledVendor: PROVIDER_CANCELED,

    bookingCountVendor: PROVIDER_BOOKING_COUNT,

    transactionCount: 0,

    totalDiscount: 0,

    shareBy: providerReferrer._id.toString(),

    /**
     * shareBy points to Vendor.
     */
    cd: "vendor",

    pincode: PINCODE,
  });

  /**
   * Vendor auth middleware uses vendorId.
   */

  authToken = jwt.sign(
    {
      vendorId: customerVendor._id.toString(),

      phoneNo: customerVendor.phoneNo,

      type: customerVendor.type,
    },

    ENV.JWT_VENDOR_SECRET,

    {
      expiresIn: "1h",
    },
  );

  console.log({
    customerVendor: customerVendor._id.toString(),

    providerVendor: providerVendor._id.toString(),

    customerReferrer: customerReferrer._id.toString(),

    providerReferrer: providerReferrer._id.toString(),

    bookingDate: BOOKING_DATE,

    commission: PROVIDER_COMMISSION,
  });
}

/**
 * ============================================================
 * DATABASE STATE
 * ============================================================
 */

async function getState() {
  const [customer, provider, customerReferralAccount, providerReferralAccount, bookings] =
    await Promise.all([
      Vendor.findById(customerVendor._id).lean(),

      Vendor.findById(providerVendor._id).lean(),

      User.findById(customerReferrer._id).lean(),

      Vendor.findById(providerReferrer._id).lean(),

      Bookings.find({
        userId: customerVendor._id,

        vendorId: providerVendor._id,

        bookingDate: BOOKING_DATE,
      }).lean(),
    ]);

  if (!customer) {
    throw new Error("Customer Vendor fixture disappeared");
  }

  if (!provider) {
    throw new Error("Provider Vendor fixture disappeared");
  }

  if (!customerReferralAccount) {
    throw new Error("Customer referrer fixture disappeared");
  }

  if (!providerReferralAccount) {
    throw new Error("Provider referrer fixture disappeared");
  }

  return {
    customer,
    provider,

    customerReferrer: customerReferralAccount,

    providerReferrer: providerReferralAccount,

    bookings,
  };
}

/**
 * ============================================================
 * REQUEST
 * ============================================================
 */

async function sendBookingRequest() {
  const requestId = `vendor-create-rollback-${Date.now()}`;

  try {
    const response = await axios.post(
      CREATE_API,

      {
        /**
         * This must match authenticated Vendor.
         */
        userId: customerVendor._id.toString(),

        vendorId: providerVendor._id.toString(),

        bookingDate: BOOKING_DATE,

        type: BOOKING_TYPE,

        pincode: PINCODE,

        isSelfBooking: false,
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
 * INITIAL STATE
 * ============================================================
 */

function assertInitialState(state) {
  section("PRE-FAILURE DATABASE STATE");

  assertEqual(state.bookings.length, 0, "No test booking exists before request");

  /**
   * Customer Vendor
   */

  assertEqual(
    number(state.customer.balance),
    CUSTOMER_BALANCE,
    "Customer Vendor starts with expected balance",
  );

  assertEqual(
    number(state.customer.bookingCount),
    CUSTOMER_BOOKING_COUNT,
    "Customer Vendor starts with expected bookingCount",
  );

  assertEqual(
    number(state.customer.pending),
    CUSTOMER_PENDING,
    "Customer Vendor starts with expected pending",
  );

  assertEqual(
    number(state.customer.completed),
    CUSTOMER_COMPLETED,
    "Customer Vendor starts with expected completed",
  );

  assertEqual(
    number(state.customer.canceled),
    CUSTOMER_CANCELED,
    "Customer Vendor starts with expected canceled",
  );

  /**
   * Provider
   */

  assertEqual(
    number(state.provider.balance),
    PROVIDER_BALANCE,
    "Provider starts with expected balance",
  );

  assertEqual(
    number(state.provider.bookingCountVendor),
    PROVIDER_BOOKING_COUNT,
    "Provider starts with expected bookingCountVendor",
  );

  assertEqual(
    number(state.provider.pendingVendor),
    PROVIDER_PENDING,
    "Provider starts with expected pendingVendor",
  );

  assertEqual(
    number(state.provider.completedVendor),
    PROVIDER_COMPLETED,
    "Provider starts with expected completedVendor",
  );

  assertEqual(
    number(state.provider.canceledVendor),
    PROVIDER_CANCELED,
    "Provider starts with expected canceledVendor",
  );

  /**
   * Customer referrer
   */

  assertEqual(
    number(state.customerReferrer.pendingShareBy),
    CUSTOMER_REFERRER_PENDING,
    "Customer referrer starts with expected pendingShareBy",
  );

  assertEqual(
    number(state.customerReferrer.completedShareBy),
    CUSTOMER_REFERRER_COMPLETED,
    "Customer referrer starts with expected completedShareBy",
  );

  assertEqual(
    number(state.customerReferrer.canceledShareBy),
    CUSTOMER_REFERRER_CANCELED,
    "Customer referrer starts with expected canceledShareBy",
  );

  assertEqual(
    number(state.customerReferrer.earning),
    CUSTOMER_REFERRER_EARNING,
    "Customer referrer starts with expected earning",
  );

  /**
   * Provider referrer
   */

  assertEqual(
    number(state.providerReferrer.pendingShareBy),
    PROVIDER_REFERRER_PENDING,
    "Provider referrer starts with expected pendingShareBy",
  );

  assertEqual(
    number(state.providerReferrer.completedShareBy),
    PROVIDER_REFERRER_COMPLETED,
    "Provider referrer starts with expected completedShareBy",
  );

  assertEqual(
    number(state.providerReferrer.canceledShareBy),
    PROVIDER_REFERRER_CANCELED,
    "Provider referrer starts with expected canceledShareBy",
  );

  assertEqual(
    number(state.providerReferrer.earning),
    PROVIDER_REFERRER_EARNING,
    "Provider referrer starts with expected earning",
  );
}

/**
 * ============================================================
 * ROLLBACK ASSERTIONS
 * ============================================================
 */

function assertRollback(before, after) {
  section("VERIFY TRANSACTION ROLLBACK");

  /**
   * Booking
   */

  assertEqual(
    after.bookings.length,
    before.bookings.length,
    "Booking document insertion is rolled back",
  );

  /**
   * Customer Vendor
   */

  assertEqual(
    number(after.customer.balance),
    number(before.customer.balance),
    "Customer Vendor balance deduction is rolled back",
  );

  assertEqual(
    number(after.customer.bookingCount),
    number(before.customer.bookingCount),
    "Customer Vendor bookingCount increment is rolled back",
  );

  assertEqual(
    number(after.customer.pending),
    number(before.customer.pending),
    "Customer Vendor pending increment is rolled back",
  );

  assertEqual(
    number(after.customer.completed),
    number(before.customer.completed),
    "Customer Vendor completed remains unchanged",
  );

  assertEqual(
    number(after.customer.canceled),
    number(before.customer.canceled),
    "Customer Vendor canceled remains unchanged",
  );

  /**
   * Provider Vendor
   */

  assertEqual(
    number(after.provider.balance),
    number(before.provider.balance),
    "Provider commission deduction is rolled back",
  );

  assertEqual(
    number(after.provider.bookingCountVendor),
    number(before.provider.bookingCountVendor),
    "Provider bookingCountVendor increment is rolled back",
  );

  assertEqual(
    number(after.provider.pendingVendor),
    number(before.provider.pendingVendor),
    "Provider pendingVendor increment is rolled back",
  );

  assertEqual(
    number(after.provider.completedVendor),
    number(before.provider.completedVendor),
    "Provider completedVendor remains unchanged",
  );

  assertEqual(
    number(after.provider.canceledVendor),
    number(before.provider.canceledVendor),
    "Provider canceledVendor remains unchanged",
  );

  /**
   * Customer referral
   */

  assertEqual(
    number(after.customerReferrer.pendingShareBy),
    number(before.customerReferrer.pendingShareBy),
    "Customer referrer pendingShareBy increment is rolled back",
  );

  assertEqual(
    number(after.customerReferrer.completedShareBy),
    number(before.customerReferrer.completedShareBy),
    "Customer referrer completedShareBy remains unchanged",
  );

  assertEqual(
    number(after.customerReferrer.canceledShareBy),
    number(before.customerReferrer.canceledShareBy),
    "Customer referrer canceledShareBy remains unchanged",
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

  /**
   * Provider referral
   */

  assertEqual(
    number(after.providerReferrer.pendingShareBy),
    number(before.providerReferrer.pendingShareBy),
    "Provider referrer pendingShareBy increment is rolled back",
  );

  assertEqual(
    number(after.providerReferrer.completedShareBy),
    number(before.providerReferrer.completedShareBy),
    "Provider referrer completedShareBy remains unchanged",
  );

  assertEqual(
    number(after.providerReferrer.canceledShareBy),
    number(before.providerReferrer.canceledShareBy),
    "Provider referrer canceledShareBy remains unchanged",
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

  /**
   * Non-negative invariants
   */

  assert(number(after.customer.pending) >= 0, "Customer Vendor pending remains non-negative");

  assert(number(after.provider.pendingVendor) >= 0, "Provider pendingVendor remains non-negative");

  assert(
    number(after.customerReferrer.pendingShareBy) >= 0,
    "Customer referrer pendingShareBy remains non-negative",
  );

  assert(
    number(after.providerReferrer.pendingShareBy) >= 0,
    "Provider referrer pendingShareBy remains non-negative",
  );
}

/**
 * ============================================================
 * EXACT FINAL STATE
 * ============================================================
 */

function assertExactState(state) {
  section("EXACT DATABASE INVARIANTS");

  assertEqual(
    state.bookings.length,
    0,
    "No booking exists after aborted Vendor creation transaction",
  );

  /**
   * Customer Vendor
   */

  assertEqual(
    number(state.customer.balance),
    CUSTOMER_BALANCE,
    "Customer Vendor balance exactly restored",
  );

  assertEqual(
    number(state.customer.bookingCount),
    CUSTOMER_BOOKING_COUNT,
    "Customer Vendor bookingCount exactly restored",
  );

  assertEqual(
    number(state.customer.pending),
    CUSTOMER_PENDING,
    "Customer Vendor pending exactly restored",
  );

  assertEqual(
    number(state.customer.completed),
    CUSTOMER_COMPLETED,
    "Customer Vendor completed exactly preserved",
  );

  assertEqual(
    number(state.customer.canceled),
    CUSTOMER_CANCELED,
    "Customer Vendor canceled exactly preserved",
  );

  /**
   * Provider
   */

  assertEqual(
    number(state.provider.balance),
    PROVIDER_BALANCE,
    "Provider balance exactly restored",
  );

  assertEqual(
    number(state.provider.bookingCountVendor),
    PROVIDER_BOOKING_COUNT,
    "Provider bookingCountVendor exactly restored",
  );

  assertEqual(
    number(state.provider.pendingVendor),
    PROVIDER_PENDING,
    "Provider pendingVendor exactly restored",
  );

  assertEqual(
    number(state.provider.completedVendor),
    PROVIDER_COMPLETED,
    "Provider completedVendor exactly preserved",
  );

  assertEqual(
    number(state.provider.canceledVendor),
    PROVIDER_CANCELED,
    "Provider canceledVendor exactly preserved",
  );

  /**
   * Customer referrer
   */

  assertEqual(
    number(state.customerReferrer.pendingShareBy),
    CUSTOMER_REFERRER_PENDING,
    "Customer referral pending exactly restored",
  );

  assertEqual(
    number(state.customerReferrer.completedShareBy),
    CUSTOMER_REFERRER_COMPLETED,
    "Customer referral completed exactly preserved",
  );

  assertEqual(
    number(state.customerReferrer.canceledShareBy),
    CUSTOMER_REFERRER_CANCELED,
    "Customer referral canceled exactly preserved",
  );

  assertEqual(
    number(state.customerReferrer.earning),
    CUSTOMER_REFERRER_EARNING,
    "Customer referral earning exactly preserved",
  );

  assertEqual(
    number(state.customerReferrer.balance),
    CUSTOMER_REFERRER_BALANCE,
    "Customer referral balance exactly preserved",
  );

  /**
   * Provider referrer
   */

  assertEqual(
    number(state.providerReferrer.pendingShareBy),
    PROVIDER_REFERRER_PENDING,
    "Provider referral pending exactly restored",
  );

  assertEqual(
    number(state.providerReferrer.completedShareBy),
    PROVIDER_REFERRER_COMPLETED,
    "Provider referral completed exactly preserved",
  );

  assertEqual(
    number(state.providerReferrer.canceledShareBy),
    PROVIDER_REFERRER_CANCELED,
    "Provider referral canceled exactly preserved",
  );

  assertEqual(
    number(state.providerReferrer.earning),
    PROVIDER_REFERRER_EARNING,
    "Provider referral earning exactly preserved",
  );

  assertEqual(
    number(state.providerReferrer.balance),
    PROVIDER_REFERRER_BALANCE,
    "Provider referral balance exactly preserved",
  );
}

/**
 * ============================================================
 * CLEANUP
 * ============================================================
 */

async function cleanup() {
  section("CLEANUP");

  const userIds = [customerReferrer?._id].filter(Boolean);

  const vendorIds = [customerVendor?._id, providerVendor?._id, providerReferrer?._id].filter(
    Boolean,
  );

  let bookingResult = {
    deletedCount: 0,
  };

  if (customerVendor?._id && providerVendor?._id) {
    bookingResult = await Bookings.deleteMany({
      userId: customerVendor._id,

      vendorId: providerVendor._id,
    });
  }

  const [userResult, vendorResult] = await Promise.all([
    userIds.length
      ? User.deleteMany({
          _id: {
            $in: userIds,
          },
        })
      : Promise.resolve({
          deletedCount: 0,
        }),

    vendorIds.length
      ? Vendor.deleteMany({
          _id: {
            $in: vendorIds,
          },
        })
      : Promise.resolve({
          deletedCount: 0,
        }),
  ]);

  console.log({
    bookingsDeleted: bookingResult.deletedCount || 0,

    usersDeleted: userResult.deletedCount || 0,

    vendorsDeleted: vendorResult.deletedCount || 0,
  });
}

/**
 * ============================================================
 * MAIN
 * ============================================================
 */

async function run() {
  section("VENDOR BOOKING CREATION TRANSACTION ROLLBACK E2E TEST");

  console.log({
    createApi: CREATE_API,

    nodeEnv: process.env.NODE_ENV,

    bookingDate: BOOKING_DATE,

    expectedApiEnvironment: {
      NODE_ENV: "development",

      ALLOW_BOOKING_ROLLBACK_TEST: "1",

      BOOKING_FAILURE_POINT: "after_vendor_creation_mutations",
    },
  });

  /**
   * Never run fault injection against production.
   */

  if (process.env.NODE_ENV === "production") {
    throw new Error("Rollback injection test must NEVER run in production");
  }

  await connectDatabase();

  try {
    await createFixtures();

    const before = await getState();

    assertInitialState(before);

    section("INJECTED VENDOR BOOKING CREATION FAILURE");

    console.log(
      "Sending Vendor booking request. API should execute transactional mutations and then throw the injected failure...",
    );

    const response = await sendBookingRequest();

    console.log(response);

    assert(response.status !== "NETWORK_ERROR", "Injected Vendor creation request reaches API");

    assertEqual(response.status, 500, "Injected Vendor booking creation failure returns HTTP 500");

    const responseText = JSON.stringify(response.data || {});

    assert(
      responseText.includes("BOOKING_TEST_INJECTED_VENDOR_CREATION_FAILURE"),
      "API failure was caused by configured Vendor transaction injection",
    );

    /**
     * Load database after transaction abort.
     */

    const after = await getState();

    assertRollback(before, after);

    assertExactState(after);

    /**
     * ========================================================
     * RETRYABILITY
     * ========================================================
     */

    section("FAILED CREATION RETRYABILITY");

    const activeBookingCount = await Bookings.countDocuments({
      vendorId: providerVendor._id,

      bookingDate: BOOKING_DATE,

      cancelOrder: false,

      orderCompleted: false,
    });

    assertEqual(activeBookingCount, 0, "No active booking leaks from aborted transaction");

    const exactBookingCount = await Bookings.countDocuments({
      userId: customerVendor._id,

      vendorId: providerVendor._id,

      bookingDate: BOOKING_DATE,
    });

    assertEqual(exactBookingCount, 0, "No Vendor booking document leaks from aborted transaction");

    assert(number(after.customer.balance) > 0, "Customer Vendor retains balance after rollback");

    assert(number(after.provider.balance) > 0, "Provider retains balance after rollback");

    assert(activeBookingCount === 0, "Provider/date remains available for legitimate retry");
  } finally {
    await cleanup();

    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();

      console.log("MongoDB disconnected.");
    }
  }

  /**
   * ==========================================================
   * SUMMARY
   * ==========================================================
   */

  section("FINAL VENDOR BOOKING CREATION ROLLBACK TEST SUMMARY");

  console.log(`Assertions: ${assertions}`);

  console.log(`Passed: ${passed}`);

  console.log(`Failed: ${failed}`);

  console.log("");

  if (failed > 0) {
    console.error("FAIL: VENDOR BOOKING CREATION ROLLBACK INVARIANTS FAILED");

    process.exitCode = 1;

    return;
  }

  console.log("PASS: VENDOR BOOKING CREATION ROLLBACK INVARIANTS PASSED");

  console.log(`
Verified:

✓ Injected failure occurs after Vendor booking creation mutations
✓ Booking insertion rolls back
✓ Customer Vendor balance deduction rolls back
✓ Customer Vendor bookingCount increment rolls back
✓ Customer Vendor pending increment rolls back
✓ Provider commission deduction rolls back
✓ Provider bookingCountVendor increment rolls back
✓ Provider pendingVendor increment rolls back
✓ Customer referrer pendingShareBy increment rolls back
✓ Provider referrer pendingShareBy increment rolls back
✓ Customer completed/canceled counters remain unchanged
✓ Provider completed/canceled counters remain unchanged
✓ Referral completed/canceled counters remain unchanged
✓ Referral earnings remain unchanged
✓ Referral balances remain unchanged
✓ Pending counters remain non-negative
✓ No active booking leaks from aborted transaction
✓ Provider/date remains available after rollback
✓ Failed Vendor booking creation remains safely retryable
`);
}

/**
 * ============================================================
 * PROCESS
 * ============================================================
 */

run().catch(async (error) => {
  console.error("");

  section("TEST FAILED");

  console.error(error);

  try {
    await cleanup();
  } catch (cleanupError) {
    console.error("Cleanup failed:", cleanupError);
  }

  try {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
  } catch (_) {
    // Ignore shutdown error.
  }

  process.exitCode = 1;
});
