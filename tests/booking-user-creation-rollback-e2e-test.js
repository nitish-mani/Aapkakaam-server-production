"use strict";

/**
 * ============================================================
 * USER BOOKING CREATION TRANSACTION ROLLBACK E2E TEST
 * ============================================================
 *
 * Purpose:
 *
 * Prove that createUserBooking() is fully atomic.
 *
 * The API must be started with:
 *
 * NODE_ENV=development
 * ALLOW_BOOKING_ROLLBACK_TEST=1
 * BOOKING_FAILURE_POINT=after_user_creation_mutations
 *
 * Expected flow:
 *
 * 1. Booking document created
 * 2. User charged
 * 3. User bookingCount incremented
 * 4. User pending incremented
 * 5. Provider charged
 * 6. Provider bookingCountVendor incremented
 * 7. Provider pendingVendor incremented
 * 8. Customer referrer pendingShareBy incremented
 * 9. Provider referrer pendingShareBy incremented
 * 10. Injected failure occurs
 * 11. MongoDB transaction aborts
 *
 * FINAL REQUIREMENT:
 *
 * Every mutation above MUST be rolled back.
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
 * CONFIGURATION
 * ============================================================
 */

const BASE_URL = process.env.TEST_API_BASE_URL || "http://localhost:3000";

const CREATE_API = `${BASE_URL}/api/bookings/postToBookingsU`;

const BOOKING_TYPE = process.env.TEST_BOOKING_TYPE || "electrician";
const PINCODE = process.env.TEST_BOOKING_PINCODE || "274201";

/**
 * Pick a future date so it cannot conflict with completion logic
 * and normalize exactly as BookingService does.
 */
const BOOKING_DATE =
  process.env.TEST_BOOKING_DATE || new Date(Date.now() + 11 * 24 * 60 * 60 * 1000).toDateString();

const CUSTOMER_START_BALANCE = 10000;
const PROVIDER_START_BALANCE = 10000;

const CUSTOMER_BOOKING_COUNT = 10;
const CUSTOMER_PENDING = 3;
const CUSTOMER_COMPLETED = 5;
const CUSTOMER_CANCELED = 2;

const PROVIDER_BOOKING_COUNT = 15;
const PROVIDER_PENDING = 4;
const PROVIDER_COMPLETED = 7;
const PROVIDER_CANCELED = 3;

const CUSTOMER_REFERRER_PENDING = 6;
const CUSTOMER_REFERRER_COMPLETED = 10;
const CUSTOMER_REFERRER_CANCELED = 4;
const CUSTOMER_REFERRER_EARNING = 100;
const CUSTOMER_REFERRER_BALANCE = 500;

const PROVIDER_REFERRER_PENDING = 8;
const PROVIDER_REFERRER_COMPLETED = 20;
const PROVIDER_REFERRER_CANCELED = 9;
const PROVIDER_REFERRER_EARNING = 200;
const PROVIDER_REFERRER_BALANCE = 700;

/**
 * Provider commission intentionally non-zero so rollback proves
 * that provider financial mutation is reverted.
 */
const PROVIDER_COMMISSION = 100;

/**
 * ============================================================
 * TEST STATE
 * ============================================================
 */

let assertions = 0;
let passed = 0;
let failed = 0;

let customerUser;
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
  /**
   * Test-only unique Indian-looking 10-digit number.
   */
  const base = 8100000000;

  return base + offset + Math.floor(Math.random() * 100000);
}

function calculateDiscountMultiplier(totalDiscount, transactionCount) {
  const discount = Number(totalDiscount) || 0;
  const count = Number(transactionCount) || 0;

  if (count <= 0 || discount <= 0) {
    return 1;
  }

  const discountRate = discount / count / 100;

  return Math.max(0, Math.min(1, 1 - discountRate));
}

function calculateCharges(customer, provider) {
  const customerMultiplier = calculateDiscountMultiplier(
    customer.totalDiscount,
    customer.transactionCount,
  );

  const vendorMultiplier = calculateDiscountMultiplier(
    provider.totalDiscount,
    provider.transactionCount,
  );

  return {
    customerCharge: 10 * customerMultiplier,

    providerCharge: number(provider.commission) * vendorMultiplier,
  };
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
    ENV.MONGODB_URI || ENV.MONGO_URI || process.env.MONGODB_URI || process.env.MONGO_URI;

  if (!mongoUri) {
    throw new Error("MongoDB URI not found. Expected ENV.MONGODB_URI / ENV.MONGO_URI.");
  }

  await mongoose.connect(mongoUri);

  console.log("MongoDB connected.");
}

/**
 * ============================================================
 * FIXTURE CREATION
 * ============================================================
 */

async function createFixtures() {
  section("CREATE TEST FIXTURES");

  const password = await bcrypt.hash("RollbackTest123!", 12);

  /**
   * ------------------------------------------------------------
   * CUSTOMER REFERRER
   * ------------------------------------------------------------
   */

  customerReferrer = await User.create({
    name: "Rollback Customer Referrer",

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
   * ------------------------------------------------------------
   * PROVIDER REFERRER
   * ------------------------------------------------------------
   */

  providerReferrer = await Vendor.create({
    name: "Rollback Provider Referrer",

    phoneNo: makePhone(200),

    password,

    type: "electrician",

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
   * ------------------------------------------------------------
   * CUSTOMER USER
   * ------------------------------------------------------------
   *
   * cd describes the MODEL containing shareBy.
   *
   * customerReferrer is a User, therefore:
   *
   * cd = "user"
   */

  customerUser = await User.create({
    name: "Rollback Booking Customer",

    phoneNo: makePhone(300),

    password,

    verifyPhoneNo: true,

    balance: CUSTOMER_START_BALANCE,

    pending: CUSTOMER_PENDING,

    completed: CUSTOMER_COMPLETED,

    canceled: CUSTOMER_CANCELED,

    bookingCount: CUSTOMER_BOOKING_COUNT,

    transactionCount: 0,

    totalDiscount: 0,

    shareBy: customerReferrer._id.toString(),

    cd: "user",

    pincode: PINCODE,
  });

  /**
   * ------------------------------------------------------------
   * PROVIDER VENDOR
   * ------------------------------------------------------------
   *
   * providerReferrer is a Vendor, therefore cd="vendor".
   */

  providerVendor = await Vendor.create({
    name: "Rollback Booking Provider",

    phoneNo: makePhone(400),

    password,

    type: BOOKING_TYPE,

    verifyPhoneNo: true,

    isVerified: true,

    balance: PROVIDER_START_BALANCE,

    commission: PROVIDER_COMMISSION,

    pendingVendor: PROVIDER_PENDING,

    completedVendor: PROVIDER_COMPLETED,

    canceledVendor: PROVIDER_CANCELED,

    bookingCountVendor: PROVIDER_BOOKING_COUNT,

    transactionCount: 0,

    totalDiscount: 0,

    shareBy: providerReferrer._id.toString(),

    cd: "vendor",

    pincode: PINCODE,
  });

  /**
   * User auth middleware expects:
   *
   * payloadKey = userId
   */

  authToken = jwt.sign(
    {
      userId: customerUser._id.toString(),
      phoneNo: customerUser.phoneNo,
    },

    ENV.JWT_USER_SECRET,

    {
      expiresIn: "1h",
    },
  );

  console.log({
    customerUser: customerUser._id.toString(),

    providerVendor: providerVendor._id.toString(),

    customerReferrer: customerReferrer._id.toString(),

    providerReferrer: providerReferrer._id.toString(),

    bookingDate: BOOKING_DATE,

    commission: PROVIDER_COMMISSION,
  });
}

/**
 * ============================================================
 * LOAD COMPLETE DATABASE STATE
 * ============================================================
 */

async function getState() {
  const [customer, provider, customerReferralAccount, providerReferralAccount, bookings] =
    await Promise.all([
      User.findById(customerUser._id).lean(),

      Vendor.findById(providerVendor._id).lean(),

      User.findById(customerReferrer._id).lean(),

      Vendor.findById(providerReferrer._id).lean(),

      Bookings.find({
        userId: customerUser._id,
        vendorId: providerVendor._id,
        bookingDate: BOOKING_DATE,
      }).lean(),
    ]);

  if (!customer) {
    throw new Error("Customer fixture disappeared");
  }

  if (!provider) {
    throw new Error("Provider fixture disappeared");
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
 * SEND BOOKING REQUEST
 * ============================================================
 */

async function sendBookingRequest() {
  const requestId = `user-create-rollback-${Date.now()}`;

  try {
    const response = await axios.post(
      CREATE_API,

      {
        userId: customerUser._id.toString(),

        vendorId: providerVendor._id.toString(),

        bookingDate: BOOKING_DATE,

        type: BOOKING_TYPE,

        pincode: PINCODE,
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
 * PRE-FAILURE ASSERTIONS
 * ============================================================
 */

function assertInitialState(state) {
  section("PRE-FAILURE DATABASE STATE");

  assertEqual(state.bookings.length, 0, "No test booking exists before request");

  assertEqual(
    number(state.customer.balance),
    CUSTOMER_START_BALANCE,
    "Customer starts with expected balance",
  );

  assertEqual(
    number(state.customer.bookingCount),
    CUSTOMER_BOOKING_COUNT,
    "Customer starts with expected bookingCount",
  );

  assertEqual(
    number(state.customer.pending),
    CUSTOMER_PENDING,
    "Customer starts with expected pending",
  );

  assertEqual(
    number(state.customer.completed),
    CUSTOMER_COMPLETED,
    "Customer starts with expected completed",
  );

  assertEqual(
    number(state.customer.canceled),
    CUSTOMER_CANCELED,
    "Customer starts with expected canceled",
  );

  assertEqual(
    number(state.provider.balance),
    PROVIDER_START_BALANCE,
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
   * ------------------------------------------------------------
   * BOOKING INSERT
   * ------------------------------------------------------------
   */

  assertEqual(
    after.bookings.length,
    before.bookings.length,
    "Booking document insertion is rolled back",
  );

  /**
   * ------------------------------------------------------------
   * CUSTOMER ACCOUNTING
   * ------------------------------------------------------------
   */

  assertEqual(
    number(after.customer.balance),
    number(before.customer.balance),
    "Customer balance deduction is rolled back",
  );

  assertEqual(
    number(after.customer.bookingCount),
    number(before.customer.bookingCount),
    "Customer bookingCount increment is rolled back",
  );

  assertEqual(
    number(after.customer.pending),
    number(before.customer.pending),
    "Customer pending increment is rolled back",
  );

  assertEqual(
    number(after.customer.completed),
    number(before.customer.completed),
    "Customer completed remains unchanged",
  );

  assertEqual(
    number(after.customer.canceled),
    number(before.customer.canceled),
    "Customer canceled remains unchanged",
  );

  /**
   * ------------------------------------------------------------
   * PROVIDER ACCOUNTING
   * ------------------------------------------------------------
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
   * ------------------------------------------------------------
   * CUSTOMER REFERRAL
   * ------------------------------------------------------------
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
   * ------------------------------------------------------------
   * PROVIDER REFERRAL
   * ------------------------------------------------------------
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
   * ------------------------------------------------------------
   * NON-NEGATIVE INVARIANTS
   * ------------------------------------------------------------
   */

  assert(number(after.customer.pending) >= 0, "Customer pending remains non-negative");

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
 * EXACT STATE ASSERTIONS
 * ============================================================
 */

function assertExactFinalState(state) {
  section("EXACT DATABASE INVARIANTS");

  assertEqual(state.bookings.length, 0, "No booking exists after aborted creation transaction");

  assertEqual(
    number(state.customer.balance),
    CUSTOMER_START_BALANCE,
    "Customer balance exactly restored",
  );

  assertEqual(
    number(state.customer.bookingCount),
    CUSTOMER_BOOKING_COUNT,
    "Customer bookingCount exactly restored",
  );

  assertEqual(
    number(state.customer.pending),
    CUSTOMER_PENDING,
    "Customer pending exactly restored",
  );

  assertEqual(
    number(state.customer.completed),
    CUSTOMER_COMPLETED,
    "Customer completed exactly preserved",
  );

  assertEqual(
    number(state.customer.canceled),
    CUSTOMER_CANCELED,
    "Customer canceled exactly preserved",
  );

  assertEqual(
    number(state.provider.balance),
    PROVIDER_START_BALANCE,
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
}

/**
 * ============================================================
 * CLEANUP
 * ============================================================
 */

async function cleanup() {
  section("CLEANUP");

  if (!customerUser && !providerVendor && !customerReferrer && !providerReferrer) {
    return;
  }

  const userIds = [customerUser?._id, customerReferrer?._id].filter(Boolean);

  const vendorIds = [providerVendor?._id, providerReferrer?._id].filter(Boolean);

  const bookingFilter = {};

  if (customerUser?._id) {
    bookingFilter.userId = customerUser._id;
  }

  if (providerVendor?._id) {
    bookingFilter.vendorId = providerVendor._id;
  }

  const [bookingResult, userResult, vendorResult] = await Promise.all([
    Object.keys(bookingFilter).length > 0
      ? Bookings.deleteMany(bookingFilter)
      : Promise.resolve({ deletedCount: 0 }),

    userIds.length > 0
      ? User.deleteMany({
          _id: {
            $in: userIds,
          },
        })
      : Promise.resolve({ deletedCount: 0 }),

    vendorIds.length > 0
      ? Vendor.deleteMany({
          _id: {
            $in: vendorIds,
          },
        })
      : Promise.resolve({ deletedCount: 0 }),
  ]);

  console.log({
    bookingsDeleted: bookingResult.deletedCount || 0,
    usersDeleted: userResult.deletedCount || 0,
    vendorsDeleted: vendorResult.deletedCount || 0,
  });
}

/**
 * ============================================================
 * MAIN TEST
 * ============================================================
 */

async function run() {
  section("USER BOOKING CREATION TRANSACTION ROLLBACK E2E TEST");

  console.log({
    createApi: CREATE_API,

    nodeEnv: process.env.NODE_ENV,

    bookingDate: BOOKING_DATE,

    expectedApiEnvironment: {
      NODE_ENV: "development",

      ALLOW_BOOKING_ROLLBACK_TEST: "1",

      BOOKING_FAILURE_POINT: "after_user_creation_mutations",
    },
  });

  /**
   * Guard against accidentally running this test in production.
   */

  if (process.env.NODE_ENV === "production") {
    throw new Error("Rollback injection test must NEVER run in production");
  }

  await connectDatabase();

  try {
    await createFixtures();

    const before = await getState();

    assertInitialState(before);

    const charges = calculateCharges(before.customer, before.provider);

    section("EXPECTED TRANSACTION MUTATIONS");

    console.log({
      customerCharge: charges.customerCharge,

      providerCharge: charges.providerCharge,

      mutationsThatMustRollback: [
        "booking insert",

        `customer balance -${charges.customerCharge}`,

        "customer bookingCount +1",

        "customer pending +1",

        `provider balance -${charges.providerCharge}`,

        "provider bookingCountVendor +1",

        "provider pendingVendor +1",

        "customer referrer pendingShareBy +1",

        "provider referrer pendingShareBy +1",
      ],
    });

    section("INJECTED USER BOOKING CREATION FAILURE");

    console.log(
      "Sending booking request. API should perform transactional mutations and then throw the injected failure...",
    );

    const response = await sendBookingRequest();

    console.log(response);

    assert(response.status !== "NETWORK_ERROR", "Injected creation request reaches API");

    assertEqual(response.status, 500, "Injected user booking creation failure returns HTTP 500");

    /**
     * A 500 by itself isn't enough to prove the failure injection
     * was actually reached, so verify the response where possible.
     */

    const responseText = JSON.stringify(response.data || {});

    assert(
      responseText.includes("BOOKING_TEST_INJECTED_USER_CREATION_FAILURE"),
      "API failure was caused by configured transaction injection",
    );

    /**
     * Read directly from MongoDB AFTER the transaction abort.
     */

    const after = await getState();

    assertRollback(before, after);

    assertExactFinalState(after);

    /**
     * ========================================================
     * RETRYABILITY / UNIQUENESS
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

    const anyBookingCount = await Bookings.countDocuments({
      userId: customerUser._id,

      vendorId: providerVendor._id,

      bookingDate: BOOKING_DATE,
    });

    assertEqual(anyBookingCount, 0, "No historical/test booking leaks from aborted transaction");

    assert(
      number(after.customer.balance) >= charges.customerCharge,
      "Customer still has balance for legitimate retry",
    );

    assert(
      number(after.provider.balance) >= charges.providerCharge,
      "Provider still has balance for legitimate retry",
    );

    assert(activeBookingCount === 0, "Vendor/date remains available for future legitimate retry");
  } finally {
    await cleanup();

    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();

      console.log("MongoDB disconnected.");
    }
  }

  /**
   * ============================================================
   * SUMMARY
   * ============================================================
   */

  section("FINAL USER BOOKING CREATION ROLLBACK TEST SUMMARY");

  console.log(`Assertions: ${assertions}`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);

  console.log("");

  if (failed > 0) {
    console.error("FAIL: USER BOOKING CREATION ROLLBACK INVARIANTS FAILED");

    process.exitCode = 1;

    return;
  }

  console.log("PASS: USER BOOKING CREATION ROLLBACK INVARIANTS PASSED");

  console.log(`
Verified:

✓ Injected failure occurs after User booking creation mutations
✓ Booking insertion rolls back
✓ Customer balance deduction rolls back
✓ Customer bookingCount increment rolls back
✓ Customer pending increment rolls back
✓ Provider commission deduction rolls back
✓ Provider bookingCountVendor increment rolls back
✓ Provider pendingVendor increment rolls back
✓ Customer referrer pendingShareBy increment rolls back
✓ Provider referrer pendingShareBy increment rolls back
✓ Completed/canceled counters remain unchanged
✓ Referral completed/canceled counters remain unchanged
✓ Referral earnings remain unchanged
✓ Referral balances remain unchanged
✓ Pending counters remain non-negative
✓ No active booking leaks from aborted transaction
✓ Vendor/date remains available after rollback
✓ Customer/provider balances remain sufficient for retry
✓ Failed booking creation remains safely retryable
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
    // Ignore disconnect errors during fatal cleanup.
  }

  process.exitCode = 1;
});
