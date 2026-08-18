/**
 * ============================================================
 * BOOKING PROVIDER AUTHORIZATION / IDOR E2E SECURITY TEST
 * ============================================================
 *
 * PURPOSE
 *
 * Verify authorization for the SERVICE PROVIDER side of
 * the booking lifecycle.
 *
 * This suite specifically protects:
 *
 * 1. Provider monthly booking retrieval
 *
 *    GET /api/vendor/getBookings/:vendorId/:month/:year
 *
 * 2. Rating permission
 *
 *    PATCH /api/bookings/ratingPermission
 *
 * SECURITY RULES
 *
 * - A Vendor may read ONLY its own provider bookings.
 * - A Vendor may grant rating permission ONLY for a booking
 *   where that Vendor is booking.vendorId.
 * - Being the customer of a booking does NOT make a Vendor
 *   the service provider.
 * - User JWT must not access Vendor-only provider operations.
 * - Missing/invalid JWT must be rejected.
 * - Unauthorized operations must not mutate booking/accounting.
 *
 * IMPORTANT
 *
 * This test intentionally uses REAL:
 *
 * signup
 * login
 * JWT
 * is_user
 * is_vendor
 * routes
 * controllers
 * services
 * MongoDB
 *
 * DO NOT remove authentication middleware.
 *
 * EXPECTED INITIAL RESULT
 *
 * Based on the implementation inspected before this test was
 * written, the application may currently fail:
 *
 * - provider monthly booking IDOR
 * - ratingPermission provider ownership authorization
 *
 * Those failures are SECURITY FINDINGS.
 *
 * DO NOT change the test to accept HTTP 200.
 *
 * RUN SERVER:
 *
 * NODE_ENV=development ALLOW_AUTHORIZATION_TEST=1 npm run dev
 *
 * RUN TEST:
 *
 * NODE_ENV=development ALLOW_AUTHORIZATION_TEST=1 \
 * node tests/booking-provider-authorization-e2e-test.js
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
    throw new Error(
      "REFUSING TO RUN: provider authorization test must not run with NODE_ENV=production.",
    );
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
  return `provider-security-${role}-${uniqueSuffix()}@example.com`;
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

/**
 * VendorService currently uses:
 *
 * monthNames[parseInt(month)]
 *
 * Therefore:
 *
 * 0 = Jan
 * 1 = Feb
 * ...
 * 11 = Dec
 *
 * This helper deliberately returns the zero-based month
 * expected by the current service implementation.
 */
function getVendorBookingMonthParams(dateString) {
  const date = new Date(dateString);

  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid booking date: ${dateString}`);
  }

  return {
    month: date.getMonth(),
    year: date.getFullYear(),
  };
}

function sameState(before, after) {
  return JSON.stringify(before) === JSON.stringify(after);
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

  await User.updateOne(
    {
      _id: userId,
    },
    {
      $set: {
        balance: 2000,
        earning: 0,

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
        earning: 0,

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

  const returnedIds = orders
    .map((order) => order.bookingId || order._id)
    .filter(Boolean)
    .map(String);

  if (!returnedIds.length) {
    throw new Error(`getOrders response contains no bookingId: ` + JSON.stringify(response.data));
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

  registerBooking(booking._id);

  return String(booking._id);
}

function registerBooking(id) {
  const value = String(id);

  if (!createdBookings.includes(value)) {
    createdBookings.push(value);
  }
}

// ============================================================
// PROVIDER BOOKING ROUTE
// ============================================================

async function getProviderBookings(authenticatedVendor, targetVendorId, bookingDate) {
  const { month, year } = getVendorBookingMonthParams(bookingDate);

  return requestJson("get", `${VENDOR_PREFIX}/getBookings/${targetVendorId}/${month}/${year}`, {
    headers: bearer(authenticatedVendor.token),
  });
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

    pendingShareBy: Number(user.pendingShareBy || 0),
    completedShareBy: Number(user.completedShareBy || 0),
    canceledShareBy: Number(user.canceledShareBy || 0),

    transactionCount: Number(user.transactionCount || 0),
    totalDiscount: Number(user.totalDiscount || 0),

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

    pendingShareBy: Number(vendor.pendingShareBy || 0),
    completedShareBy: Number(vendor.completedShareBy || 0),
    canceledShareBy: Number(vendor.canceledShareBy || 0),

    transactionCount: Number(vendor.transactionCount || 0),
    totalDiscount: Number(vendor.totalDiscount || 0),

    earning: Number(vendor.earning || 0),
    balance: Number(vendor.balance || 0),
  };
}

// ============================================================
// FORCE BOOKING INTO A CONTROLLED COMPLETED STATE
// ============================================================

/**
 * Rating-permission authorization is the thing under test.
 *
 * We do NOT need to retest the entire completion accounting
 * lifecycle here.
 *
 * Therefore this helper puts the booking directly into the
 * valid state required by grantRatingPermission():
 *
 * cancelOrder      = false
 * orderCompleted   = true
 * ratingPermission = false
 *
 * This isolates authorization from unrelated completion
 * business logic.
 */
async function prepareCompletedBooking(bookingId) {
  const result = await Bookings.updateOne(
    {
      _id: bookingId,
    },
    {
      $set: {
        cancelOrder: false,
        orderCompleted: true,
        ratingPermission: false,
        rating: 0,
      },
    },
  );

  if (result.matchedCount !== 1) {
    throw new Error(`Unable to prepare completed booking: ${bookingId}`);
  }
}

async function prepareIncompleteBooking(bookingId) {
  const result = await Bookings.updateOne(
    {
      _id: bookingId,
    },
    {
      $set: {
        cancelOrder: false,
        orderCompleted: false,
        ratingPermission: false,
        rating: 0,
      },
    },
  );

  if (result.matchedCount !== 1) {
    throw new Error(`Unable to prepare incomplete booking: ${bookingId}`);
  }
}

async function prepareCancelledBooking(bookingId) {
  const result = await Bookings.updateOne(
    {
      _id: bookingId,
    },
    {
      $set: {
        cancelOrder: true,
        orderCompleted: false,
        ratingPermission: false,
        rating: 0,
      },
    },
  );

  if (result.matchedCount !== 1) {
    throw new Error(`Unable to prepare cancelled booking: ${bookingId}`);
  }
}

// ============================================================
// CREATE USER BOOKING AND RETURN ID
// ============================================================

async function createTrackedUserBooking({ customer, provider, bookingDate }) {
  await createUserBooking(customer, provider, bookingDate);

  return findBookingIdThroughOrders({
    account: customer,
    flowType: "user",
    providerId: provider.id,
  });
}

// ============================================================
// CREATE VENDOR-CUSTOMER BOOKING AND RETURN ID
// ============================================================

async function createTrackedVendorBooking({ customer, provider, bookingDate }) {
  await createVendorBooking(customer, provider, bookingDate);

  return findBookingIdThroughOrders({
    account: customer,
    flowType: "vendor",
    providerId: provider.id,
  });
}

// ============================================================
// TEST: PROVIDER CAN READ OWN MONTHLY BOOKINGS
// ============================================================

async function testProviderCanReadOwnBookings() {
  section("PROVIDER BOOKINGS - LEGITIMATE READ");

  const customer = await signupAndLoginUser("PROVIDER READ OWN CUSTOMER");

  const provider = await signupAndLoginVendor("PROVIDER READ OWN SERVICE PROVIDER");

  const bookingDate = futureDate(15);

  const bookingId = await createTrackedUserBooking({
    customer,
    provider,
    bookingDate,
  });

  const response = await getProviderBookings(provider, provider.id, bookingDate);

  expectStatus(response, 200, "Provider can retrieve own monthly bookings");

  const bookings = Array.isArray(response.data) ? response.data : response.data?.data || [];

  ok(Array.isArray(bookings), "Provider bookings response contains booking array", response.data);

  const containsBooking =
    Array.isArray(bookings) &&
    bookings.some((booking) => String(booking._id || booking.bookingId) === bookingId);

  ok(containsBooking, "Provider's own booking is present in monthly results", response.data);
}

// ============================================================
// TEST: PROVIDER READ IDOR
// ============================================================

async function testVendorCannotReadAnotherProvidersBookings() {
  section("PROVIDER BOOKINGS - IDOR READ ATTACK");

  const customer = await signupAndLoginUser("PROVIDER READ IDOR CUSTOMER");

  const victimProvider = await signupAndLoginVendor("PROVIDER READ IDOR VICTIM");

  const attacker = await signupAndLoginVendor("PROVIDER READ IDOR ATTACKER");

  const bookingDate = futureDate(18);

  await createTrackedUserBooking({
    customer,
    provider: victimProvider,
    bookingDate,
  });

  const response = await getProviderBookings(attacker, victimProvider.id, bookingDate);

  expectStatus(response, [403, 404], "Vendor cannot retrieve another provider's monthly bookings");
}

// ============================================================
// TEST: USER JWT ON PROVIDER BOOKING ROUTE
// ============================================================

async function testUserCannotReadProviderBookings() {
  section("PROVIDER BOOKINGS - CROSS ROLE USER JWT");

  const user = await signupAndLoginUser("PROVIDER CROSS ROLE USER");

  const provider = await signupAndLoginVendor("PROVIDER CROSS ROLE TARGET");

  const bookingDate = futureDate(20);

  const { month, year } = getVendorBookingMonthParams(bookingDate);

  const response = await requestJson(
    "get",
    `${VENDOR_PREFIX}/getBookings/${provider.id}/${month}/${year}`,
    {
      headers: bearer(user.token),
    },
  );

  expectStatus(response, [401, 403], "User JWT cannot access provider monthly booking route");
}

// ============================================================
// TEST: MISSING JWT PROVIDER READ
// ============================================================

async function testProviderReadMissingJwt() {
  section("PROVIDER BOOKINGS - MISSING JWT");

  const fakeVendorId = new mongoose.Types.ObjectId().toString();

  const date = futureDate(22);

  const { month, year } = getVendorBookingMonthParams(date);

  const response = await requestJson(
    "get",
    `${VENDOR_PREFIX}/getBookings/${fakeVendorId}/${month}/${year}`,
  );

  expectStatus(response, 401, "Provider booking route rejects missing JWT");
}

// ============================================================
// TEST: INVALID JWT PROVIDER READ
// ============================================================

async function testProviderReadInvalidJwt() {
  section("PROVIDER BOOKINGS - INVALID JWT");

  const fakeVendorId = new mongoose.Types.ObjectId().toString();

  const date = futureDate(24);

  const { month, year } = getVendorBookingMonthParams(date);

  const response = await requestJson(
    "get",
    `${VENDOR_PREFIX}/getBookings/${fakeVendorId}/${month}/${year}`,
    {
      headers: {
        Authorization: "Bearer this-is-not-a-valid-jwt",
      },
    },
  );

  expectStatus(response, 401, "Provider booking route rejects invalid JWT");
}

// ============================================================
// TEST: LEGITIMATE RATING PERMISSION
// ============================================================

async function testProviderCanGrantOwnRatingPermission() {
  section("RATING PERMISSION - LEGITIMATE PROVIDER");

  const customer = await signupAndLoginUser("RATING PERMISSION CUSTOMER");

  const provider = await signupAndLoginVendor("RATING PERMISSION PROVIDER");

  const bookingId = await createTrackedUserBooking({
    customer,
    provider,
    bookingDate: pastDate(10),
  });

  await prepareCompletedBooking(bookingId);

  const before = await snapshotBooking(bookingId);

  ok(before.ratingPermission === false, "Rating permission starts disabled", before);

  const response = await requestJson("patch", `${BOOKING_PREFIX}/ratingPermission`, {
    headers: bearer(provider.token),

    body: {
      bookingId,
    },
  });

  expectStatus(response, 200, "Service provider can grant rating permission on own booking");

  const after = await snapshotBooking(bookingId);

  ok(after.ratingPermission === true, "Legitimate provider enables ratingPermission", {
    before,
    after,
  });
}

// ============================================================
// TEST: RATING PERMISSION PROVIDER IDOR
// ============================================================

async function testVendorCannotGrantAnotherProvidersRatingPermission() {
  section("RATING PERMISSION - PROVIDER IDOR ATTACK");

  const customer = await signupAndLoginUser("RATING IDOR CUSTOMER");

  const victimProvider = await signupAndLoginVendor("RATING IDOR VICTIM PROVIDER");

  const attacker = await signupAndLoginVendor("RATING IDOR ATTACKER");

  const bookingId = await createTrackedUserBooking({
    customer,
    provider: victimProvider,
    bookingDate: pastDate(12),
  });

  await prepareCompletedBooking(bookingId);

  const bookingBefore = await snapshotBooking(bookingId);

  const customerBefore = await snapshotUser(customer.id);

  const providerBefore = await snapshotVendor(victimProvider.id);

  const attackerBefore = await snapshotVendor(attacker.id);

  const response = await requestJson("patch", `${BOOKING_PREFIX}/ratingPermission`, {
    headers: bearer(attacker.token),

    body: {
      bookingId,
    },
  });

  expectStatus(
    response,
    [403, 404],
    "Different Vendor cannot grant rating permission on another provider's booking",
  );

  const bookingAfter = await snapshotBooking(bookingId);

  const customerAfter = await snapshotUser(customer.id);

  const providerAfter = await snapshotVendor(victimProvider.id);

  const attackerAfter = await snapshotVendor(attacker.id);

  ok(
    sameState(bookingBefore, bookingAfter),
    "Unauthorized rating permission leaves booking unchanged",
    {
      before: bookingBefore,
      after: bookingAfter,
    },
  );

  ok(
    bookingAfter.ratingPermission === false,
    "Unauthorized Vendor cannot enable ratingPermission",
    bookingAfter,
  );

  ok(
    sameState(customerBefore, customerAfter),
    "Unauthorized rating permission leaves customer accounting unchanged",
  );

  ok(
    sameState(providerBefore, providerAfter),
    "Unauthorized rating permission leaves provider accounting unchanged",
  );

  ok(
    sameState(attackerBefore, attackerAfter),
    "Unauthorized rating permission leaves attacker accounting unchanged",
  );
}

// ============================================================
// TEST: VENDOR CUSTOMER IS NOT THE SERVICE PROVIDER
// ============================================================

async function testVendorCustomerCannotGrantPermission() {
  section("RATING PERMISSION - VENDOR CUSTOMER IS NOT PROVIDER");

  const vendorCustomer = await signupAndLoginVendor("RATING VENDOR CUSTOMER");

  const provider = await signupAndLoginVendor("RATING VENDOR CUSTOMER PROVIDER");

  const bookingId = await createTrackedVendorBooking({
    customer: vendorCustomer,
    provider,
    bookingDate: pastDate(14),
  });

  await prepareCompletedBooking(bookingId);

  const bookingBefore = await snapshotBooking(bookingId);

  const customerBefore = await snapshotVendor(vendorCustomer.id);

  const providerBefore = await snapshotVendor(provider.id);

  const response = await requestJson("patch", `${BOOKING_PREFIX}/ratingPermission`, {
    headers: bearer(vendorCustomer.token),

    body: {
      bookingId,
    },
  });

  expectStatus(
    response,
    [403, 404],
    "Vendor acting as customer cannot grant provider rating permission",
  );

  const bookingAfter = await snapshotBooking(bookingId);

  const customerAfter = await snapshotVendor(vendorCustomer.id);

  const providerAfter = await snapshotVendor(provider.id);

  ok(
    sameState(bookingBefore, bookingAfter),
    "Vendor-customer unauthorized request leaves booking unchanged",
    {
      before: bookingBefore,
      after: bookingAfter,
    },
  );

  ok(
    bookingAfter.ratingPermission === false,
    "Vendor customer cannot enable ratingPermission",
    bookingAfter,
  );

  ok(sameState(customerBefore, customerAfter), "Vendor customer accounting remains unchanged");

  ok(
    sameState(providerBefore, providerAfter),
    "Provider accounting remains unchanged after Vendor-customer attack",
  );
}

// ============================================================
// TEST: USER JWT ON RATING PERMISSION
// ============================================================

async function testUserCannotGrantRatingPermission() {
  section("RATING PERMISSION - USER JWT");

  const customer = await signupAndLoginUser("RATING USER JWT CUSTOMER");

  const provider = await signupAndLoginVendor("RATING USER JWT PROVIDER");

  const bookingId = await createTrackedUserBooking({
    customer,
    provider,
    bookingDate: pastDate(16),
  });

  await prepareCompletedBooking(bookingId);

  const before = await snapshotBooking(bookingId);

  const response = await requestJson("patch", `${BOOKING_PREFIX}/ratingPermission`, {
    headers: bearer(customer.token),

    body: {
      bookingId,
    },
  });

  expectStatus(response, [401, 403], "User JWT cannot grant provider rating permission");

  const after = await snapshotBooking(bookingId);

  ok(sameState(before, after), "User JWT rating-permission attempt leaves booking unchanged", {
    before,
    after,
  });
}

// ============================================================
// TEST: MISSING JWT RATING PERMISSION
// ============================================================

async function testRatingPermissionMissingJwt() {
  section("RATING PERMISSION - MISSING JWT");

  const fakeBookingId = new mongoose.Types.ObjectId().toString();

  const response = await requestJson("patch", `${BOOKING_PREFIX}/ratingPermission`, {
    body: {
      bookingId: fakeBookingId,
    },
  });

  expectStatus(response, 401, "Rating permission rejects missing JWT");
}

// ============================================================
// TEST: INVALID JWT RATING PERMISSION
// ============================================================

async function testRatingPermissionInvalidJwt() {
  section("RATING PERMISSION - INVALID JWT");

  const fakeBookingId = new mongoose.Types.ObjectId().toString();

  const response = await requestJson("patch", `${BOOKING_PREFIX}/ratingPermission`, {
    headers: {
      Authorization: "Bearer this-is-not-a-valid-jwt",
    },

    body: {
      bookingId: fakeBookingId,
    },
  });

  expectStatus(response, 401, "Rating permission rejects invalid JWT");
}

// ============================================================
// TEST: INCOMPLETE BOOKING
// ============================================================

async function testIncompleteBookingCannotReceivePermission() {
  section("RATING PERMISSION - INCOMPLETE BOOKING");

  const customer = await signupAndLoginUser("RATING INCOMPLETE CUSTOMER");

  const provider = await signupAndLoginVendor("RATING INCOMPLETE PROVIDER");

  const bookingId = await createTrackedUserBooking({
    customer,
    provider,
    bookingDate: futureDate(25),
  });

  await prepareIncompleteBooking(bookingId);

  const before = await snapshotBooking(bookingId);

  const response = await requestJson("patch", `${BOOKING_PREFIX}/ratingPermission`, {
    headers: bearer(provider.token),

    body: {
      bookingId,
    },
  });

  expectStatus(response, [400, 409], "Incomplete booking cannot receive rating permission");

  const after = await snapshotBooking(bookingId);

  ok(sameState(before, after), "Rejected incomplete-booking request leaves booking unchanged", {
    before,
    after,
  });
}

// ============================================================
// TEST: CANCELLED BOOKING
// ============================================================

async function testCancelledBookingCannotReceivePermission() {
  section("RATING PERMISSION - CANCELLED BOOKING");

  const customer = await signupAndLoginUser("RATING CANCELLED CUSTOMER");

  const provider = await signupAndLoginVendor("RATING CANCELLED PROVIDER");

  const bookingId = await createTrackedUserBooking({
    customer,
    provider,
    bookingDate: futureDate(28),
  });

  await prepareCancelledBooking(bookingId);

  const before = await snapshotBooking(bookingId);

  const response = await requestJson("patch", `${BOOKING_PREFIX}/ratingPermission`, {
    headers: bearer(provider.token),

    body: {
      bookingId,
    },
  });

  expectStatus(response, [400, 409], "Cancelled booking cannot receive rating permission");

  const after = await snapshotBooking(bookingId);

  ok(sameState(before, after), "Rejected cancelled-booking request leaves booking unchanged", {
    before,
    after,
  });
}

// ============================================================
// TEST: NONEXISTENT BOOKING
// ============================================================

async function testNonexistentBookingRatingPermission() {
  section("RATING PERMISSION - NONEXISTENT BOOKING");

  const provider = await signupAndLoginVendor("RATING NONEXISTENT PROVIDER");

  const fakeBookingId = new mongoose.Types.ObjectId().toString();

  const response = await requestJson("patch", `${BOOKING_PREFIX}/ratingPermission`, {
    headers: bearer(provider.token),

    body: {
      bookingId: fakeBookingId,
    },
  });

  expectStatus(response, 404, "Nonexistent booking cannot receive rating permission");
}

// ============================================================
// TEST: MALFORMED BOOKING ID
// ============================================================

async function testMalformedBookingIdRatingPermission() {
  section("RATING PERMISSION - MALFORMED BOOKING ID");

  const provider = await signupAndLoginVendor("RATING MALFORMED PROVIDER");

  const response = await requestJson("patch", `${BOOKING_PREFIX}/ratingPermission`, {
    headers: bearer(provider.token),

    body: {
      bookingId: "not-a-valid-object-id",
    },
  });

  expectStatus(response, [400, 422], "Malformed bookingId is rejected");
}

// ============================================================
// TEST: DUPLICATE LEGITIMATE PERMISSION
// ============================================================

async function testDuplicateRatingPermissionIsSafe() {
  section("RATING PERMISSION - DUPLICATE REQUEST");

  const customer = await signupAndLoginUser("RATING DUPLICATE CUSTOMER");

  const provider = await signupAndLoginVendor("RATING DUPLICATE PROVIDER");

  const bookingId = await createTrackedUserBooking({
    customer,
    provider,
    bookingDate: pastDate(18),
  });

  await prepareCompletedBooking(bookingId);

  const first = await requestJson("patch", `${BOOKING_PREFIX}/ratingPermission`, {
    headers: bearer(provider.token),

    body: {
      bookingId,
    },
  });

  expectStatus(first, 200, "First legitimate rating-permission request succeeds");

  const afterFirst = await snapshotBooking(bookingId);

  ok(afterFirst.ratingPermission === true, "First request enables ratingPermission", afterFirst);

  const customerBeforeSecond = await snapshotUser(customer.id);

  const providerBeforeSecond = await snapshotVendor(provider.id);

  const second = await requestJson("patch", `${BOOKING_PREFIX}/ratingPermission`, {
    headers: bearer(provider.token),

    body: {
      bookingId,
    },
  });

  /*
   * Current service intentionally returns successfully when
   * ratingPermission is already true.
   *
   * 200 is therefore the expected idempotent behavior.
   */
  expectStatus(second, 200, "Duplicate legitimate rating-permission request is idempotent");

  const afterSecond = await snapshotBooking(bookingId);

  const customerAfterSecond = await snapshotUser(customer.id);

  const providerAfterSecond = await snapshotVendor(provider.id);

  ok(
    afterSecond.ratingPermission === true,
    "Duplicate request keeps ratingPermission enabled",
    afterSecond,
  );

  ok(
    sameState(afterFirst, afterSecond),
    "Duplicate request does not further mutate booking state",
    {
      afterFirst,
      afterSecond,
    },
  );

  ok(
    sameState(customerBeforeSecond, customerAfterSecond),
    "Duplicate permission request does not mutate customer accounting",
  );

  ok(
    sameState(providerBeforeSecond, providerAfterSecond),
    "Duplicate permission request does not mutate provider accounting",
  );
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
   * Crash-safe cleanup.
   *
   * Delete bookings related to test accounts even if a test
   * crashed before registerBooking() was reached.
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
  section("FINAL PROVIDER AUTHORIZATION SECURITY TEST SUMMARY");

  console.log(`Assertions: ${assertions}`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);

  if (crashed) {
    console.log("\nTEST SUITE CRASHED BEFORE COMPLETION.");

    return;
  }

  if (failed === 0 && assertions > 0) {
    section("PASS: PROVIDER AUTHORIZATION SECURITY TESTS PASSED");

    console.log(`
Verified:

✓ Real signup/login/JWT flow works

✓ Provider can read own monthly bookings

✓ Vendor cannot read another provider's monthly bookings

✓ User cannot access provider monthly booking route

✓ Missing JWT cannot access provider bookings

✓ Invalid JWT cannot access provider bookings

✓ Service provider can grant rating permission on own booking

✓ Different Vendor cannot grant another provider's rating permission

✓ Vendor acting as customer is not treated as service provider

✓ User cannot grant provider rating permission

✓ Missing JWT cannot grant rating permission

✓ Invalid JWT cannot grant rating permission

✓ Incomplete booking cannot receive rating permission

✓ Cancelled booking cannot receive rating permission

✓ Nonexistent booking is rejected

✓ Malformed bookingId is rejected

✓ Duplicate legitimate permission request is safe

✓ Unauthorized rating-permission request leaves booking unchanged

✓ Unauthorized rating-permission request leaves accounting unchanged

✓ booking.vendorId determines provider ownership
`);

    return;
  }

  section(`FAIL: ${failed} PROVIDER AUTHORIZATION SECURITY TEST(S) FAILED`);

  console.log(`
IMPORTANT:

A failed assertion here may indicate an IDOR /
Broken Object Level Authorization vulnerability.

Two particularly serious failures are:

1.

Vendor A JWT
+
Vendor B vendorId
+
GET /vendor/getBookings/...

must NOT return Vendor B's provider bookings.


2.

Vendor A JWT
+
Vendor B bookingId
+
PATCH /bookings/ratingPermission

must NOT modify Vendor B's booking.


The authoritative provider identity is:

    JWT vendorId

and booking ownership must be established using:

    booking.vendorId


DO NOT weaken this test to accept unauthorized HTTP 200.

Fix the authorization boundary in the application instead.
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
  section("BOOKING PROVIDER AUTHORIZATION / IDOR E2E SECURITY TEST");

  console.log({
    api: API_BASE,
    nodeEnv: process.env.NODE_ENV,
  });

  assertSafeEnvironment();

  await connectMongo();

  /*
   * --------------------------------------------------------
   * PROVIDER BOOKING READ AUTHORIZATION
   * --------------------------------------------------------
   */

  await testProviderReadMissingJwt();

  await testProviderReadInvalidJwt();

  await testUserCannotReadProviderBookings();

  await testProviderCanReadOwnBookings();

  await testVendorCannotReadAnotherProvidersBookings();

  /*
   * --------------------------------------------------------
   * RATING PERMISSION AUTHORIZATION
   * --------------------------------------------------------
   */

  await testRatingPermissionMissingJwt();

  await testRatingPermissionInvalidJwt();

  await testUserCannotGrantRatingPermission();

  await testProviderCanGrantOwnRatingPermission();

  await testVendorCannotGrantAnotherProvidersRatingPermission();

  await testVendorCustomerCannotGrantPermission();

  /*
   * --------------------------------------------------------
   * RATING PERMISSION STATE VALIDATION
   * --------------------------------------------------------
   */

  await testIncompleteBookingCannotReceivePermission();

  await testCancelledBookingCannotReceivePermission();

  await testNonexistentBookingRatingPermission();

  await testMalformedBookingIdRatingPermission();

  /*
   * --------------------------------------------------------
   * IDEMPOTENCY
   * --------------------------------------------------------
   */

  await testDuplicateRatingPermissionIsSafe();
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
     * Security failures MUST fail the process.
     */
    if (crashed || failed > 0 || assertions === 0) {
      process.exitCode = 1;
    }
  }
})();
