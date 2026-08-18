/**
 * ============================================================
 * BOOKING AUTHORIZATION / IDOR E2E SECURITY TEST
 * ============================================================
 *
 * PURPOSE
 *
 * Verify that an authenticated account cannot read or mutate
 * another customer's bookings simply by knowing:
 *
 *   - userId/vendorId
 *   - bookingId
 *
 * REAL APPLICATION FLOW
 *
 * signup
 *   ↓
 * login
 *   ↓
 * JWT
 *   ↓
 * create booking
 *   ↓
 * getOrdersU / getOrdersV
 *   ↓
 * obtain bookingId
 *   ↓
 * attempt authorized + unauthorized operations
 *   ↓
 * verify HTTP response
 *   ↓
 * verify MongoDB state
 *
 * IMPORTANT
 *
 * This test intentionally uses REAL authentication middleware.
 *
 * DO NOT remove:
 *
 *   is_user
 *   is_vendor
 *
 * from the routes.
 *
 * RUN:
 *
 * NODE_ENV=development ALLOW_AUTHORIZATION_TEST=1 \
 * node tests/booking-authorization-e2e-test.js
 */

const mongoose = require("mongoose");

const User = require("../models/user");
const Vendor = require("../models/vendor");
const Bookings = require("../models/bookings");

const ENV = require("../src/config/env");
const { createVerifiedSignupOtp } = require("./helpers/otp-auth-test-helper");
// ============================================================
// CONFIGURATION
// ============================================================

const API_BASE =
  process.env.TEST_API_BASE_URL || process.env.API_BASE_URL || "http://localhost:3000/api";

const USER_PREFIX = `${API_BASE}/user`;
const VENDOR_PREFIX = `${API_BASE}/vendor`;
const BOOKING_PREFIX = `${API_BASE}/bookings`;

const PASSWORD = "Test@123456";

const BOOKING_TYPE = "four wheeler";
const PINCODE = "274001";

const createdUsers = [];
const createdVendors = [];
const createdBookings = [];

let assertions = 0;
let passed = 0;
let failed = 0;

let sequence = 0;

// ============================================================
// OUTPUT
// ============================================================

function section(title) {
  console.log("\n========================================");
  console.log(title);
  console.log("========================================");
}

function ok(condition, message, details = undefined) {
  assertions++;

  if (condition) {
    passed++;
    console.log(`✓ ${message}`);
    return;
  }

  failed++;

  console.error(`✗ ${message}`);

  if (details !== undefined) {
    console.dir(details, {
      depth: null,
    });
  }
}

function expectStatus(response, allowedStatuses, message) {
  const statuses = Array.isArray(allowedStatuses) ? allowedStatuses : [allowedStatuses];

  ok(statuses.includes(response.status), `${message} [HTTP ${response.status}]`, response.data);
}

// ============================================================
// SAFETY
// ============================================================

function assertSafeEnvironment() {
  if (process.env.ALLOW_AUTHORIZATION_TEST !== "1") {
    throw new Error("REFUSING TO RUN: set ALLOW_AUTHORIZATION_TEST=1 explicitly.");
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error("REFUSING TO RUN: authorization test must not run with NODE_ENV=production.");
  }
}

// ============================================================
// UTILITIES
// ============================================================

function uniqueSuffix() {
  sequence++;

  return `${Date.now()}${sequence}`;
}

function nextPhone() {
  const raw = 7000000000 + ((Date.now() + sequence * 7919) % 1999999999);

  sequence++;

  return String(raw).slice(0, 10);
}

function nextEmail(role) {
  return `security-${role}-${uniqueSuffix()}@example.com`;
}

function pastDate(days = 2) {
  const date = new Date();

  date.setDate(date.getDate() - days);

  return date.toDateString();
}

function futureDate(days = 10) {
  const date = new Date();

  date.setDate(date.getDate() + days);

  return date.toDateString();
}

function bearer(token) {
  return {
    Authorization: `Bearer ${token}`,
  };
}

// ============================================================
// HTTP
// ============================================================

async function requestJson(method, url, options = {}) {
  const headers = {
    Accept: "application/json",
    ...(options.headers || {}),
  };

  const normalizedMethod = String(method).toUpperCase();

  const config = {
    method: normalizedMethod,
    headers,
  };

  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    config.body = JSON.stringify(options.body);
  }

  try {
    const response = await fetch(url, config);

    const text = await response.text();

    let data;

    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }

    return {
      status: response.status,
      data,
      headers: response.headers,
    };
  } catch (error) {
    throw new Error(`HTTP request failed: ${normalizedMethod} ${url}\n${error.message}`);
  }
}

// ============================================================
// AUTH HELPERS
// ============================================================

async function signupAndLoginUser(label) {
  const phoneNo = nextPhone();
  const validPhoneNoId = await createVerifiedSignupOtp({
    phoneNo,
    accountType: "user",
  });
  const signup = await requestJson("post", `${USER_PREFIX}/signup`, {
    body: {
      name: label,
      phoneNo,
      email: nextEmail("user"),
      password: PASSWORD,
      gender: "male",
      fcmToken: "",
      agreedToTnCnP: true,
      validPhoneNoId,
    },
  });

  if (signup.status !== 201) {
    throw new Error(
      `User signup failed.\n` +
        `Status: ${signup.status}\n` +
        `Response: ${JSON.stringify(signup.data)}`,
    );
  }

  const userId = signup.data?.userId || signup.data?.data?.userId;

  if (!userId) {
    throw new Error(`Unable to extract userId: ${JSON.stringify(signup.data)}`);
  }

  createdUsers.push(String(userId));

  // Give deterministic test state.

  await User.updateOne(
    {
      _id: userId,
    },
    {
      $set: {
        balance: 2000,

        pending: 0,
        completed: 0,
        canceled: 0,

        pendingShareBy: 0,
        completedShareBy: 0,
        canceledShareBy: 0,
      },
    },
  );

  const login = await requestJson("post", `${USER_PREFIX}/login`, {
    body: {
      phoneNo,
      password: PASSWORD,
    },
  });

  if (login.status !== 200) {
    throw new Error(`User login failed: ${JSON.stringify(login.data)}`);
  }

  if (!login.data?.token) {
    throw new Error("User login did not return JWT token.");
  }

  return {
    kind: "user",

    id: String(userId),

    phoneNo,

    token: login.data.token,
  };
}

async function signupAndLoginVendor(label) {
  const phoneNo = nextPhone();
  const validPhoneNoId = await createVerifiedSignupOtp({
    phoneNo,
    accountType: "vendor",
  });
  const signup = await requestJson("post", `${VENDOR_PREFIX}/signup`, {
    body: {
      name: label,

      phoneNo,

      email: nextEmail("vendor"),

      password: PASSWORD,

      type: BOOKING_TYPE,

      experience: 1,

      gender: "male",

      fcmToken: "",

      agreedToTnCnP: true,
      validPhoneNoId,
    },
  });

  if (signup.status !== 201) {
    throw new Error(
      `Vendor signup failed.\n` +
        `Status: ${signup.status}\n` +
        `Response: ${JSON.stringify(signup.data)}`,
    );
  }

  const vendorId = signup.data?.vendorId || signup.data?.data?.vendorId;

  if (!vendorId) {
    throw new Error(`Unable to extract vendorId: ${JSON.stringify(signup.data)}`);
  }

  createdVendors.push(String(vendorId));

  await Vendor.updateOne(
    {
      _id: vendorId,
    },
    {
      $set: {
        balance: 2000,

        pending: 0,
        completed: 0,
        canceled: 0,

        pendingVendor: 0,
        completedVendor: 0,
        canceledVendor: 0,

        pendingShareBy: 0,
        completedShareBy: 0,
        canceledShareBy: 0,
      },
    },
  );

  const login = await requestJson("post", `${VENDOR_PREFIX}/login`, {
    body: {
      phoneNo,
      password: PASSWORD,
    },
  });

  if (login.status !== 200) {
    throw new Error(`Vendor login failed: ${JSON.stringify(login.data)}`);
  }

  if (!login.data?.token) {
    throw new Error("Vendor login did not return JWT token.");
  }

  return {
    kind: "vendor",

    id: String(vendorId),

    phoneNo,

    token: login.data.token,
  };
}

// ============================================================
// BOOKING HELPERS
// ============================================================

async function createUserBooking(customer, provider, bookingDate) {
  const response = await requestJson("post", `${BOOKING_PREFIX}/postToBookingsU`, {
    headers: bearer(customer.token),

    body: {
      userId: customer.id,

      vendorId: provider.id,

      bookingDate,

      type: BOOKING_TYPE,

      pincode: PINCODE,
    },
  });

  if (response.status !== 201) {
    throw new Error(
      `User booking creation failed (${response.status}): ` + JSON.stringify(response.data),
    );
  }

  return response;
}

async function createVendorBooking(customer, provider, bookingDate) {
  const response = await requestJson("post", `${BOOKING_PREFIX}/postToBookingsV`, {
    headers: bearer(customer.token),

    body: {
      userId: customer.id,

      vendorId: provider.id,

      bookingDate,

      type: BOOKING_TYPE,

      pincode: PINCODE,
    },
  });

  if (response.status !== 201) {
    throw new Error(
      `Vendor booking creation failed (${response.status}): ` + JSON.stringify(response.data),
    );
  }

  return response;
}

// ============================================================
// GET BOOKING ID THROUGH REAL APPLICATION FLOW
// ============================================================

async function getUserOrders(account) {
  return requestJson("get", `${BOOKING_PREFIX}/getOrdersU/${account.id}/1`, {
    headers: bearer(account.token),
  });
}

async function getVendorCustomerOrders(account) {
  return requestJson("get", `${BOOKING_PREFIX}/getOrdersV/${account.id}/1`, {
    headers: bearer(account.token),
  });
}

function extractOrders(response) {
  if (Array.isArray(response.data)) {
    return response.data;
  }

  if (Array.isArray(response.data?.orders)) {
    return response.data.orders;
  }

  if (Array.isArray(response.data?.data?.orders)) {
    return response.data.data.orders;
  }

  return [];
}

async function findBookingIdThroughOrders({ account, flowType, providerId }) {
  const response =
    flowType === "user" ? await getUserOrders(account) : await getVendorCustomerOrders(account);

  if (response.status !== 200) {
    throw new Error(
      `getOrders${flowType === "user" ? "U" : "V"} failed: ` + JSON.stringify(response.data),
    );
  }

  const orders = extractOrders(response);

  if (!orders.length) {
    throw new Error(`No booking returned from getOrders for ${account.id}`);
  }

  /*
   * The service currently returns bookingId but not vendorId.
   *
   * Therefore find the newest matching DB booking among the
   * IDs actually returned by the authenticated API.
   */

  const returnedIds = orders
    .map((order) => order.bookingId || order._id)
    .filter(Boolean)
    .map(String);

  if (!returnedIds.length) {
    throw new Error(`getOrders response contains no bookingId: ${JSON.stringify(response.data)}`);
  }

  const booking = await Bookings.findOne({
    _id: {
      $in: returnedIds,
    },

    userId: account.id,

    vendorId: providerId,
  })
    .sort({
      bookedOn: -1,
    })
    .lean();

  if (!booking) {
    throw new Error("Could not correlate getOrders bookingId with created booking.");
  }

  createdBookings.push(String(booking._id));

  return String(booking._id);
}

// ============================================================
// SNAPSHOTS
// ============================================================

async function snapshotBooking(bookingId) {
  const booking = await Bookings.findById(bookingId).lean();

  if (!booking) {
    throw new Error(`Booking not found: ${bookingId}`);
  }

  return {
    id: String(booking._id),

    userId: String(booking.userId),

    vendorId: String(booking.vendorId),

    cancelOrder: Boolean(booking.cancelOrder),

    orderCompleted: Boolean(booking.orderCompleted),

    rating: Number(booking.rating || 0),

    ratingPermission: Boolean(booking.ratingPermission),
  };
}

async function snapshotUser(id) {
  const user = await User.findById(id).lean();

  if (!user) {
    throw new Error(`User not found: ${id}`);
  }

  return {
    pending: Number(user.pending || 0),

    completed: Number(user.completed || 0),

    canceled: Number(user.canceled || 0),

    earning: Number(user.earning || 0),

    balance: Number(user.balance || 0),
  };
}

async function snapshotVendor(id) {
  const vendor = await Vendor.findById(id).lean();

  if (!vendor) {
    throw new Error(`Vendor not found: ${id}`);
  }

  return {
    pending: Number(vendor.pending || 0),

    completed: Number(vendor.completed || 0),

    canceled: Number(vendor.canceled || 0),

    pendingVendor: Number(vendor.pendingVendor || 0),

    completedVendor: Number(vendor.completedVendor || 0),

    canceledVendor: Number(vendor.canceledVendor || 0),

    earning: Number(vendor.earning || 0),

    balance: Number(vendor.balance || 0),
  };
}

function sameState(before, after) {
  return JSON.stringify(before) === JSON.stringify(after);
}

// ============================================================
// USER IDOR READ TEST
// ============================================================

async function testUserCannotReadAnotherUsersOrders() {
  section("USER IDOR - READ ANOTHER USER'S ORDERS");

  const victim = await signupAndLoginUser("SECURITY USER READ VICTIM");

  const attacker = await signupAndLoginUser("SECURITY USER READ ATTACKER");

  const provider = await signupAndLoginVendor("SECURITY USER READ PROVIDER");

  await createUserBooking(victim, provider, futureDate(20));

  const victimOrders = await getUserOrders(victim);

  expectStatus(victimOrders, 200, "Victim can retrieve own bookings");

  const attack = await requestJson("get", `${BOOKING_PREFIX}/getOrdersU/${victim.id}/1`, {
    headers: bearer(attacker.token),
  });

  /*
   * Correct secure behavior:
   *
   * 403 Forbidden
   *
   * 404 is also acceptable if your API intentionally hides
   * resource existence.
   */

  expectStatus(attack, [403, 404], "User cannot retrieve another user's bookings");
}

// ============================================================
// USER UNAUTHORIZED COMPLETION
// ============================================================

async function testUserCannotCompleteAnotherUsersBooking() {
  section("USER IDOR - UNAUTHORIZED COMPLETION");

  const victim = await signupAndLoginUser("SECURITY COMPLETE VICTIM");

  const attacker = await signupAndLoginUser("SECURITY COMPLETE ATTACKER");

  const provider = await signupAndLoginVendor("SECURITY COMPLETE PROVIDER");

  await createUserBooking(victim, provider, pastDate(10));

  const bookingId = await findBookingIdThroughOrders({
    account: victim,

    flowType: "user",

    providerId: provider.id,
  });

  const bookingBefore = await snapshotBooking(bookingId);

  const victimBefore = await snapshotUser(victim.id);

  const providerBefore = await snapshotVendor(provider.id);

  const response = await requestJson("patch", `${BOOKING_PREFIX}/orderCompletedU`, {
    headers: bearer(attacker.token),

    body: {
      bookingId,
    },
  });

  expectStatus(response, [403, 404], "Attacker cannot complete victim booking");

  const bookingAfter = await snapshotBooking(bookingId);

  const victimAfter = await snapshotUser(victim.id);

  const providerAfter = await snapshotVendor(provider.id);

  ok(sameState(bookingBefore, bookingAfter), "Unauthorized completion leaves booking unchanged", {
    before: bookingBefore,
    after: bookingAfter,
  });

  ok(
    sameState(victimBefore, victimAfter),
    "Unauthorized completion leaves customer accounting unchanged",
  );

  ok(
    sameState(providerBefore, providerAfter),
    "Unauthorized completion leaves provider accounting unchanged",
  );
}

// ============================================================
// USER UNAUTHORIZED CANCELLATION
// ============================================================

async function testUserCannotCancelAnotherUsersBooking() {
  section("USER IDOR - UNAUTHORIZED CANCELLATION");

  const victim = await signupAndLoginUser("SECURITY CANCEL VICTIM");

  const attacker = await signupAndLoginUser("SECURITY CANCEL ATTACKER");

  const provider = await signupAndLoginVendor("SECURITY CANCEL PROVIDER");

  await createUserBooking(victim, provider, futureDate(30));

  const bookingId = await findBookingIdThroughOrders({
    account: victim,

    flowType: "user",

    providerId: provider.id,
  });

  const bookingBefore = await snapshotBooking(bookingId);

  const victimBefore = await snapshotUser(victim.id);

  const providerBefore = await snapshotVendor(provider.id);

  const response = await requestJson("patch", `${BOOKING_PREFIX}/cancelOrderU`, {
    headers: bearer(attacker.token),

    body: {
      bookingId,
    },
  });

  expectStatus(response, [403, 404], "Attacker cannot cancel victim booking");

  const bookingAfter = await snapshotBooking(bookingId);

  const victimAfter = await snapshotUser(victim.id);

  const providerAfter = await snapshotVendor(provider.id);

  ok(sameState(bookingBefore, bookingAfter), "Unauthorized cancellation leaves booking unchanged");

  ok(
    sameState(victimBefore, victimAfter),
    "Unauthorized cancellation leaves customer accounting unchanged",
  );

  ok(
    sameState(providerBefore, providerAfter),
    "Unauthorized cancellation leaves provider accounting unchanged",
  );
}

// ============================================================
// VENDOR CUSTOMER READ IDOR
// ============================================================

async function testVendorCannotReadAnotherVendorCustomerOrders() {
  section("VENDOR CUSTOMER IDOR - READ");

  const victim = await signupAndLoginVendor("SECURITY VENDOR READ VICTIM");

  const attacker = await signupAndLoginVendor("SECURITY VENDOR READ ATTACKER");

  const provider = await signupAndLoginVendor("SECURITY VENDOR READ PROVIDER");

  await createVendorBooking(victim, provider, futureDate(40));

  const ownOrders = await getVendorCustomerOrders(victim);

  expectStatus(ownOrders, 200, "Vendor customer can retrieve own orders");

  const attack = await requestJson("get", `${BOOKING_PREFIX}/getOrdersV/${victim.id}/1`, {
    headers: bearer(attacker.token),
  });

  expectStatus(attack, [403, 404], "Vendor cannot retrieve another vendor customer's orders");
}

// ============================================================
// VENDOR CUSTOMER UNAUTHORIZED COMPLETION
// ============================================================

async function testVendorCannotCompleteAnotherVendorBooking() {
  section("VENDOR CUSTOMER IDOR - UNAUTHORIZED COMPLETION");

  const victim = await signupAndLoginVendor("SECURITY VENDOR COMPLETE VICTIM");

  const attacker = await signupAndLoginVendor("SECURITY VENDOR COMPLETE ATTACKER");

  const provider = await signupAndLoginVendor("SECURITY VENDOR COMPLETE PROVIDER");

  await createVendorBooking(victim, provider, pastDate(20));

  const bookingId = await findBookingIdThroughOrders({
    account: victim,

    flowType: "vendor",

    providerId: provider.id,
  });

  const bookingBefore = await snapshotBooking(bookingId);

  const victimBefore = await snapshotVendor(victim.id);

  const providerBefore = await snapshotVendor(provider.id);

  const response = await requestJson("patch", `${BOOKING_PREFIX}/orderCompletedV`, {
    headers: bearer(attacker.token),

    body: {
      bookingId,
    },
  });

  expectStatus(response, [403, 404], "Vendor attacker cannot complete victim vendor booking");

  const bookingAfter = await snapshotBooking(bookingId);

  const victimAfter = await snapshotVendor(victim.id);

  const providerAfter = await snapshotVendor(provider.id);

  ok(
    sameState(bookingBefore, bookingAfter),
    "Unauthorized vendor completion leaves booking unchanged",
  );

  ok(
    sameState(victimBefore, victimAfter),
    "Unauthorized vendor completion leaves customer accounting unchanged",
  );

  ok(
    sameState(providerBefore, providerAfter),
    "Unauthorized vendor completion leaves provider accounting unchanged",
  );
}

// ============================================================
// VENDOR CUSTOMER UNAUTHORIZED CANCELLATION
// ============================================================

async function testVendorCannotCancelAnotherVendorBooking() {
  section("VENDOR CUSTOMER IDOR - UNAUTHORIZED CANCELLATION");

  const victim = await signupAndLoginVendor("SECURITY VENDOR CANCEL VICTIM");

  const attacker = await signupAndLoginVendor("SECURITY VENDOR CANCEL ATTACKER");

  const provider = await signupAndLoginVendor("SECURITY VENDOR CANCEL PROVIDER");

  await createVendorBooking(victim, provider, futureDate(50));

  const bookingId = await findBookingIdThroughOrders({
    account: victim,

    flowType: "vendor",

    providerId: provider.id,
  });

  const bookingBefore = await snapshotBooking(bookingId);

  const victimBefore = await snapshotVendor(victim.id);

  const providerBefore = await snapshotVendor(provider.id);

  const response = await requestJson("patch", `${BOOKING_PREFIX}/cancelOrderV`, {
    headers: bearer(attacker.token),

    body: {
      bookingId,
    },
  });

  expectStatus(response, [403, 404], "Vendor attacker cannot cancel victim vendor booking");

  const bookingAfter = await snapshotBooking(bookingId);

  const victimAfter = await snapshotVendor(victim.id);

  const providerAfter = await snapshotVendor(provider.id);

  ok(
    sameState(bookingBefore, bookingAfter),
    "Unauthorized vendor cancellation leaves booking unchanged",
  );

  ok(
    sameState(victimBefore, victimAfter),
    "Unauthorized vendor cancellation leaves customer accounting unchanged",
  );

  ok(
    sameState(providerBefore, providerAfter),
    "Unauthorized vendor cancellation leaves provider accounting unchanged",
  );
}

// ============================================================
// CROSS ROLE AUTHORIZATION
// ============================================================

async function testCrossRoleAuthorization() {
  section("CROSS ROLE AUTHORIZATION");

  const user = await signupAndLoginUser("SECURITY CROSS ROLE USER");

  const vendor = await signupAndLoginVendor("SECURITY CROSS ROLE VENDOR");

  const userOnVendorRoute = await requestJson(
    "get",
    `${BOOKING_PREFIX}/getOrdersV/${vendor.id}/1`,
    {
      headers: bearer(user.token),
    },
  );

  expectStatus(userOnVendorRoute, [401, 403], "User JWT cannot access vendor-only booking route");

  const vendorOnUserRoute = await requestJson("get", `${BOOKING_PREFIX}/getOrdersU/${user.id}/1`, {
    headers: bearer(vendor.token),
  });

  expectStatus(vendorOnUserRoute, [401, 403], "Vendor JWT cannot access user-only booking route");
}

// ============================================================
// NO TOKEN
// ============================================================

async function testMissingAuthentication() {
  section("MISSING AUTHENTICATION");

  const fakeId = new mongoose.Types.ObjectId().toString();

  const response = await requestJson("get", `${BOOKING_PREFIX}/getOrdersU/${fakeId}/1`);

  expectStatus(response, 401, "Booking route rejects request without JWT");
}

// ============================================================
// INVALID TOKEN
// ============================================================

async function testInvalidToken() {
  section("INVALID JWT");

  const fakeId = new mongoose.Types.ObjectId().toString();

  const response = await requestJson("get", `${BOOKING_PREFIX}/getOrdersU/${fakeId}/1`, {
    headers: {
      Authorization: "Bearer this-is-not-a-valid-jwt",
    },
  });

  expectStatus(response, 401, "Booking route rejects invalid JWT");
}

// ============================================================
// CLEANUP
// ============================================================

async function cleanup() {
  section("CLEANUP");

  let bookingsDeleted = 0;
  let usersDeleted = 0;
  let vendorsDeleted = 0;

  if (createdBookings.length) {
    const result = await Bookings.deleteMany({
      _id: {
        $in: createdBookings,
      },
    });

    bookingsDeleted += result.deletedCount || 0;
  }

  /*
   * Also delete bookings associated with test accounts in case
   * a test crashed before its bookingId was registered.
   */

  if (createdUsers.length || createdVendors.length) {
    const accountIds = [...createdUsers, ...createdVendors];

    const result = await Bookings.deleteMany({
      $or: [
        {
          userId: {
            $in: accountIds,
          },
        },
        {
          vendorId: {
            $in: accountIds,
          },
        },
      ],
    });

    bookingsDeleted += result.deletedCount || 0;
  }

  if (createdUsers.length) {
    const result = await User.deleteMany({
      _id: {
        $in: createdUsers,
      },
    });

    usersDeleted = result.deletedCount || 0;
  }

  if (createdVendors.length) {
    const result = await Vendor.deleteMany({
      _id: {
        $in: createdVendors,
      },
    });

    vendorsDeleted = result.deletedCount || 0;
  }

  console.log({
    bookingsDeleted,
    usersDeleted,
    vendorsDeleted,
  });
}

// ============================================================
// REPORT
// ============================================================

function printReport(crashed = false) {
  section("FINAL SECURITY TEST SUMMARY");

  console.log(`Assertions: ${assertions}`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);

  if (crashed) {
    console.log("\nTEST SUITE CRASHED BEFORE COMPLETION.");

    return;
  }

  if (failed === 0 && assertions > 0) {
    section("PASS: BOOKING AUTHORIZATION SECURITY TESTS PASSED");

    console.log(`
Verified:

✓ Real signup/login/JWT flow works
✓ User cannot read another user's bookings
✓ User cannot complete another user's booking
✓ User cannot cancel another user's booking
✓ Vendor cannot read another vendor customer's bookings
✓ Vendor cannot complete another vendor customer's booking
✓ Vendor cannot cancel another vendor customer's booking
✓ User token cannot access vendor booking routes
✓ Vendor token cannot access user booking routes
✓ Missing JWT is rejected
✓ Invalid JWT is rejected
✓ Unauthorized mutations leave database state unchanged
`);

    return;
  }

  section(`FAIL: ${failed} BOOKING AUTHORIZATION SECURITY TEST(S) FAILED`);

  console.log(`
IMPORTANT:

A failed authorization assertion can indicate an IDOR /
Broken Object Level Authorization vulnerability.

Do NOT fix the test to accept HTTP 200.

The application must reject unauthorized access and the
booking/accounting state must remain unchanged.
`);
}

// ============================================================
// DATABASE
// ============================================================

async function connectMongo() {
  const uri =
    process.env.MONGODB_URL_1 ||
    process.env.MONGODB_URI ||
    process.env.DB_URI ||
    ENV.MONGODB_URL_1 ||
    ENV.MONGODB_URI;

  if (!uri) {
    throw new Error("MongoDB URI is missing.");
  }

  await mongoose.connect(uri);

  console.log("MongoDB connected.");
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  section("BOOKING AUTHORIZATION / IDOR E2E SECURITY TEST");

  console.log({
    api: API_BASE,
    nodeEnv: process.env.NODE_ENV,
  });

  assertSafeEnvironment();

  await connectMongo();

  await testMissingAuthentication();

  await testInvalidToken();

  await testCrossRoleAuthorization();

  await testUserCannotReadAnotherUsersOrders();

  await testUserCannotCompleteAnotherUsersBooking();

  await testUserCannotCancelAnotherUsersBooking();

  await testVendorCannotReadAnotherVendorCustomerOrders();

  await testVendorCannotCompleteAnotherVendorBooking();

  await testVendorCannotCancelAnotherVendorBooking();
}

// ============================================================
// EXECUTION
// ============================================================

(async () => {
  let crashed = false;

  try {
    await main();
  } catch (error) {
    crashed = true;

    section("TEST CRASHED");

    console.error(error);
  } finally {
    if (mongoose.connection.readyState !== 0) {
      try {
        await cleanup();
      } catch (error) {
        console.error("Cleanup failed:", error);

        crashed = true;
      }

      await mongoose.disconnect();

      console.log("\nMongoDB disconnected.");
    }

    printReport(crashed);

    /*
     * Security failures MUST produce a failing process.
     */

    if (crashed || failed > 0 || assertions === 0) {
      process.exitCode = 1;
    }
  }
})();
