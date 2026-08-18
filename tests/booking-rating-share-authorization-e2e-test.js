"use strict";

/**
 * ============================================================
 * BOOKING RATING + SHARE AUTHORIZATION / IDOR E2E TEST
 * ============================================================
 *
 * PURPOSE
 * -------
 * Verify authorization boundaries around:
 *
 *   PATCH /api/bookings/ratingU
 *   PATCH /api/bookings/ratingV
 *
 *   GET /api/user/getShare/:userId/:skip
 *   GET /api/vendor/getShare/:vendorId/:skip
 *
 * This is a REAL E2E test:
 *
 *   - real HTTP API
 *   - real signup
 *   - real login
 *   - real JWT
 *   - real authentication middleware
 *   - real controllers/services
 *   - real MongoDB
 *
 * It directly seeds bookings/shares only where controlled state
 * is necessary for authorization testing.
 *
 * IMPORTANT
 * ---------
 * Run ONLY against development/test infrastructure.
 *
 * Example:
 *
 * NODE_ENV=development \
 * ALLOW_AUTHORIZATION_TEST=1 \
 * node tests/booking-rating-share-authorization-e2e-test.js
 *
 * ============================================================
 */

require("dotenv").config();

const mongoose = require("mongoose");
const { ObjectId } = require("mongodb");

const User = require("../models/user");
const Vendor = require("../models/vendor");
const Bookings = require("../models/bookings");
const Share = require("../models/share");
const { createVerifiedSignupOtp } = require("./helpers/otp-auth-test-helper");
/*
 * ============================================================
 * CONFIG
 * ============================================================
 */

const API =
  process.env.AUTHORIZATION_TEST_API || process.env.TEST_API || "http://localhost:3000/api";

const DEFAULT_PASSWORD = process.env.AUTHORIZATION_TEST_PASSWORD || "Test@123456";

const BOOKING_TYPE = process.env.AUTHORIZATION_TEST_BOOKING_TYPE || "four wheeler";

const PINCODE = process.env.AUTHORIZATION_TEST_PINCODE || "274001";

const TEST_PREFIX = `RATING_SHARE_SECURITY_${Date.now()}`;

const createdUsers = [];
const createdVendors = [];
const createdBookings = [];
const createdShares = [];

let assertions = 0;
let passed = 0;
let failed = 0;
let suiteCrashed = false;

let phoneSequence = 0;
let emailSequence = 0;

/*
 * ============================================================
 * BASIC HELPERS
 * ============================================================
 */

function section(title) {
  console.log("\n========================================");
  console.log(title);
  console.log("========================================");
}

function n(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function id(value) {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "object" && value._id) {
    return String(value._id);
  }

  return String(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function is2xx(status) {
  return status >= 200 && status < 300;
}

function isRejected(status) {
  return (
    status === 400 ||
    status === 401 ||
    status === 403 ||
    status === 404 ||
    status === 409 ||
    status === 422
  );
}

function ok(condition, message, details = undefined) {
  assertions += 1;

  if (condition) {
    passed += 1;
    console.log(`✓ ${message}`);
    return true;
  }

  failed += 1;
  console.log(`✗ ${message}`);

  if (details !== undefined) {
    console.dir(details, {
      depth: null,
    });
  }

  return false;
}

function httpOk(condition, message, response) {
  return ok(
    condition,
    `${message} [HTTP ${response.status}]`,
    condition ? undefined : response.data,
  );
}

function nextPhone() {
  phoneSequence += 1;

  /*
   * Generate a valid-looking Indian mobile number.
   * Keep this in a range unlikely to collide with normal data.
   */
  const suffix = ((Date.now() % 1000000) + phoneSequence * 97) % 1000000;

  return Number(`84${String(suffix).padStart(8, "0")}`);
}

function nextEmail(role) {
  emailSequence += 1;

  return `${role}.${Date.now()}.${emailSequence}@security-test.invalid`;
}

function futureBookingDate(days = 20) {
  const date = new Date();
  date.setDate(date.getDate() + days);

  return date.toDateString();
}

function safeJsonParse(text) {
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/*
 * ============================================================
 * HTTP
 * ============================================================
 */

async function requestJson(method, path, { token = null, body = undefined, headers = {} } = {}) {
  const normalizedMethod = String(method).toUpperCase();

  const requestHeaders = {
    Accept: "application/json",
    ...headers,
  };

  if (body !== undefined) {
    requestHeaders["Content-Type"] = "application/json";
  }

  if (token) {
    requestHeaders.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`${API}${path}`, {
    method: normalizedMethod,
    headers: requestHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();

  return {
    status: response.status,
    data: safeJsonParse(text),
    headers: response.headers,
  };
}

/*
 * ============================================================
 * ENVIRONMENT SAFETY
 * ============================================================
 */

function assertSafeEnvironment() {
  if (process.env.NODE_ENV === "production") {
    throw new Error("REFUSING TO RUN: authorization test must not run with NODE_ENV=production.");
  }

  if (process.env.ALLOW_AUTHORIZATION_TEST !== "1") {
    throw new Error("REFUSING TO RUN: set ALLOW_AUTHORIZATION_TEST=1 explicitly.");
  }
}

/*
 * ============================================================
 * MONGODB
 * ============================================================
 */

async function connectMongo() {
  const uri = process.env.MONGODB_URL_1 || process.env.MONGODB_URI || process.env.DB_URI;

  if (!uri) {
    throw new Error("MongoDB URI missing. Expected MONGODB_URL_1, MONGODB_URI or DB_URI.");
  }

  await mongoose.connect(uri);

  console.log("MongoDB connected.");
}

/*
 * ============================================================
 * AUTH RESPONSE HELPERS
 * ============================================================
 */

function extractToken(response) {
  return (
    response?.data?.token ||
    response?.data?.data?.token ||
    response?.data?.accessToken ||
    response?.data?.data?.accessToken ||
    null
  );
}

function extractId(response, kind) {
  const data = response?.data;

  const candidates = [
    data?._id,
    data?.id,

    data?.data?._id,
    data?.data?.id,

    data?.userId,
    data?.vendorId,

    data?.data?.userId,
    data?.data?.vendorId,

    data?.user?._id,
    data?.vendor?._id,

    data?.data?.user?._id,
    data?.data?.vendor?._id,
  ];

  const found = candidates.find(Boolean);

  if (!found) {
    throw new Error(`Unable to extract ${kind} ID from signup response: ${JSON.stringify(data)}`);
  }

  return String(found);
}

/*
 * ============================================================
 * USER AUTH
 * ============================================================
 */

async function signupAndLoginUser({ label } = {}) {
  const phoneNo = nextPhone();
  const email = nextEmail("user");
  const validPhoneNoId = await createVerifiedSignupOtp({
    phoneNo,
    accountType: "user",
  });

  const signupBody = {
    name: label || `${TEST_PREFIX}_USER`,
    phoneNo,
    email,
    password: DEFAULT_PASSWORD,
    fcmToken: "",
    agreedToTnCnP: true,
    validPhoneNoId,
  };

  const signupRes = await requestJson("POST", "/user/signup", {
    body: signupBody,
  });

  if (!is2xx(signupRes.status)) {
    throw new Error(
      [
        "User signup failed.",
        `Status: ${signupRes.status}`,
        `Response: ${JSON.stringify(signupRes.data)}`,
      ].join("\n"),
    );
  }

  const userId = extractId(signupRes, "user");

  createdUsers.push(userId);

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

        transactionCount: 0,
        totalDiscount: 0,
      },
    },
  );

  const loginRes = await requestJson("POST", "/user/login", {
    body: {
      phoneNo,
      password: DEFAULT_PASSWORD,
    },
  });

  if (!is2xx(loginRes.status)) {
    throw new Error(
      [
        "User login failed.",
        `Status: ${loginRes.status}`,
        `Response: ${JSON.stringify(loginRes.data)}`,
      ].join("\n"),
    );
  }

  const token = extractToken(loginRes);

  if (!token) {
    throw new Error(`User login returned no token: ${JSON.stringify(loginRes.data)}`);
  }

  return {
    kind: "user",
    id: userId,
    phoneNo,
    email,
    token,
  };
}

/*
 * ============================================================
 * VENDOR AUTH
 * ============================================================
 */

async function signupAndLoginVendor({ label, type = BOOKING_TYPE } = {}) {
  const phoneNo = nextPhone();
  const email = nextEmail("vendor");
  const validPhoneNoId = await createVerifiedSignupOtp({
    phoneNo,
    accountType: "vendor",
  });
  const signupBody = {
    name: label || `${TEST_PREFIX}_VENDOR`,
    phoneNo,
    email,
    password: DEFAULT_PASSWORD,

    type,
    experience: 1,
    gender: "male",

    fcmToken: "",
    agreedToTnCnP: true,
    validPhoneNoId,
  };

  const signupRes = await requestJson("POST", "/vendor/signup", {
    body: signupBody,
  });

  if (!is2xx(signupRes.status)) {
    throw new Error(
      [
        "Vendor signup failed.",
        `Status: ${signupRes.status}`,
        `Response: ${JSON.stringify(signupRes.data)}`,
      ].join("\n"),
    );
  }

  const vendorId = extractId(signupRes, "vendor");

  createdVendors.push(vendorId);

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

        transactionCount: 0,
        totalDiscount: 0,

        commission: 100,
        type,
      },
    },
  );

  const loginRes = await requestJson("POST", "/vendor/login", {
    body: {
      phoneNo,
      password: DEFAULT_PASSWORD,
    },
  });

  if (!is2xx(loginRes.status)) {
    throw new Error(
      [
        "Vendor login failed.",
        `Status: ${loginRes.status}`,
        `Response: ${JSON.stringify(loginRes.data)}`,
      ].join("\n"),
    );
  }

  const token = extractToken(loginRes);

  if (!token) {
    throw new Error(`Vendor login returned no token: ${JSON.stringify(loginRes.data)}`);
  }

  return {
    kind: "vendor",
    id: vendorId,
    phoneNo,
    email,
    token,
    type,
  };
}

/*
 * ============================================================
 * STATE HELPERS
 * ============================================================
 */

async function loadUserState(userId) {
  const doc = await User.findById(userId).lean();

  if (!doc) {
    throw new Error(`User not found: ${userId}`);
  }

  return {
    id: String(doc._id),

    balance: n(doc.balance),
    earning: n(doc.earning),

    pending: n(doc.pending),
    completed: n(doc.completed),
    canceled: n(doc.canceled),

    pendingShareBy: n(doc.pendingShareBy),
    completedShareBy: n(doc.completedShareBy),
    canceledShareBy: n(doc.canceledShareBy),

    transactionCount: n(doc.transactionCount),
    totalDiscount: n(doc.totalDiscount),
  };
}

async function loadVendorState(vendorId) {
  const doc = await Vendor.findById(vendorId).lean();

  if (!doc) {
    throw new Error(`Vendor not found: ${vendorId}`);
  }

  return {
    id: String(doc._id),

    rating: n(doc.rating),
    ratingCount: n(doc.ratingCount),

    balance: n(doc.balance),
    earning: n(doc.earning),

    pending: n(doc.pending),
    completed: n(doc.completed),
    canceled: n(doc.canceled),

    pendingVendor: n(doc.pendingVendor),
    completedVendor: n(doc.completedVendor),
    canceledVendor: n(doc.canceledVendor),

    pendingShareBy: n(doc.pendingShareBy),
    completedShareBy: n(doc.completedShareBy),
    canceledShareBy: n(doc.canceledShareBy),

    transactionCount: n(doc.transactionCount),
    totalDiscount: n(doc.totalDiscount),
  };
}

async function loadBookingState(bookingId) {
  const booking = await Bookings.findById(bookingId).lean();

  if (!booking) {
    throw new Error(`Booking not found: ${bookingId}`);
  }

  return {
    id: String(booking._id),
    userId: id(booking.userId),
    vendorId: id(booking.vendorId),

    cancelOrder: Boolean(booking.cancelOrder),
    orderCompleted: Boolean(booking.orderCompleted),

    rating: n(booking.rating),
    ratingPermission: Boolean(booking.ratingPermission),
  };
}

/*
 * ============================================================
 * CONTROLLED BOOKING CREATION
 * ============================================================
 *
 * We directly create booking records because these tests target
 * rating authorization, not booking creation.
 *
 * customerId may be either User._id or Vendor._id depending on
 * ratingU/ratingV scenario.
 * ============================================================
 */

async function seedBooking({
  customerId,
  providerId,
  completed = true,
  cancelled = false,
  ratingPermission = true,
  rating = 0,
  days = 20,
}) {
  const booking = await Bookings.create({
    userId: customerId,
    vendorId: providerId,

    type: BOOKING_TYPE,
    pincode: PINCODE,

    bookingDate: futureBookingDate(days),
    bookingTime: Date.now(),
    bookedOn: new Date(),

    cancelOrder: cancelled,
    orderCompleted: completed,

    rating,
    ratingPermission,

    isServed: false,
    isBooked: false,
  });

  createdBookings.push(String(booking._id));

  return String(booking._id);
}

/*
 * ============================================================
 * SHARE SEEDING
 * ============================================================
 */

async function seedUserShare({ userId, phoneNo, status = "pending", shareDate = new Date() }) {
  const share = await Share.create({
    userId,
    phoneNo,
    status,
    shareDate,
  });

  createdShares.push(String(share._id));

  return String(share._id);
}

async function seedVendorShare({ vendorId, phoneNo, status = "pending", shareDate = new Date() }) {
  const share = await Share.create({
    vendorId,
    phoneNo,
    status,
    shareDate,
  });

  createdShares.push(String(share._id));

  return String(share._id);
}

/*
 * ============================================================
 * RESPONSE HELPERS
 * ============================================================
 */

function getShareArray(response) {
  if (Array.isArray(response?.data?.share)) {
    return response.data.share;
  }

  if (Array.isArray(response?.data?.data?.share)) {
    return response.data.data.share;
  }

  return [];
}

function getShareTotal(response) {
  if (Number.isFinite(Number(response?.data?.total))) {
    return Number(response.data.total);
  }

  if (Number.isFinite(Number(response?.data?.data?.total))) {
    return Number(response.data.data.total);
  }

  return null;
}

function shareIds(response) {
  return getShareArray(response)
    .map((share) => id(share?._id))
    .filter(Boolean);
}

/*
 * ============================================================
 * RATING REQUESTS
 * ============================================================
 */

async function rateAsUser({ token, bookingId, rating }) {
  return requestJson("PATCH", "/bookings/ratingU", {
    token,
    body: {
      bookingId,
      rating,
    },
  });
}

async function rateAsVendor({ token, bookingId, rating }) {
  return requestJson("PATCH", "/bookings/ratingV", {
    token,
    body: {
      bookingId,
      rating,
    },
  });
}

/*
 * ============================================================
 * RATING - MISSING JWT
 * ============================================================
 */

async function testRatingMissingJwt() {
  section("RATING - MISSING JWT");

  const customer = await signupAndLoginUser({
    label: "RATING MISSING JWT CUSTOMER",
  });

  const provider = await signupAndLoginVendor({
    label: "RATING MISSING JWT PROVIDER",
  });

  const bookingId = await seedBooking({
    customerId: customer.id,
    providerId: provider.id,
  });

  const beforeBooking = await loadBookingState(bookingId);
  const beforeProvider = await loadVendorState(provider.id);

  const response = await rateAsUser({
    token: null,
    bookingId,
    rating: 5,
  });

  httpOk(response.status === 401, "Rating route rejects missing JWT", response);

  const afterBooking = await loadBookingState(bookingId);
  const afterProvider = await loadVendorState(provider.id);

  ok(
    JSON.stringify(afterBooking) === JSON.stringify(beforeBooking),
    "Missing JWT leaves booking unchanged",
    {
      before: beforeBooking,
      after: afterBooking,
    },
  );

  ok(
    JSON.stringify(afterProvider) === JSON.stringify(beforeProvider),
    "Missing JWT leaves provider rating/accounting unchanged",
  );
}

/*
 * ============================================================
 * RATING - INVALID JWT
 * ============================================================
 */

async function testRatingInvalidJwt() {
  section("RATING - INVALID JWT");

  const customer = await signupAndLoginUser({
    label: "RATING INVALID JWT CUSTOMER",
  });

  const provider = await signupAndLoginVendor({
    label: "RATING INVALID JWT PROVIDER",
  });

  const bookingId = await seedBooking({
    customerId: customer.id,
    providerId: provider.id,
  });

  const before = await loadBookingState(bookingId);

  const response = await rateAsUser({
    token: "this.is.not.a.valid.jwt",
    bookingId,
    rating: 5,
  });

  httpOk(response.status === 401, "Rating route rejects invalid JWT", response);

  const after = await loadBookingState(bookingId);

  ok(JSON.stringify(before) === JSON.stringify(after), "Invalid JWT leaves booking unchanged");
}

/*
 * ============================================================
 * LEGITIMATE USER RATING
 * ============================================================
 */

async function testLegitimateUserRating() {
  section("RATING - LEGITIMATE USER CUSTOMER");

  const customer = await signupAndLoginUser({
    label: "LEGIT USER RATING CUSTOMER",
  });

  const provider = await signupAndLoginVendor({
    label: "LEGIT USER RATING PROVIDER",
  });

  const bookingId = await seedBooking({
    customerId: customer.id,
    providerId: provider.id,
    completed: true,
    cancelled: false,
    ratingPermission: true,
    rating: 0,
  });

  const response = await rateAsUser({
    token: customer.token,
    bookingId,
    rating: 5,
  });

  httpOk(response.status === 200, "User can rate own completed permitted booking", response);

  const booking = await loadBookingState(bookingId);

  ok(booking.rating === 5, "Legitimate User rating is persisted", booking);
}

/*
 * ============================================================
 * USER RATING IDOR
 * ============================================================
 */

async function testUserRatingIdor() {
  section("RATING - USER IDOR ATTACK");

  const victim = await signupAndLoginUser({
    label: "RATING USER IDOR VICTIM",
  });

  const attacker = await signupAndLoginUser({
    label: "RATING USER IDOR ATTACKER",
  });

  const provider = await signupAndLoginVendor({
    label: "RATING USER IDOR PROVIDER",
  });

  const bookingId = await seedBooking({
    customerId: victim.id,
    providerId: provider.id,
    completed: true,
    ratingPermission: true,
  });

  const beforeBooking = await loadBookingState(bookingId);
  const beforeProvider = await loadVendorState(provider.id);

  const response = await rateAsUser({
    token: attacker.token,
    bookingId,
    rating: 5,
  });

  httpOk(
    response.status === 403 || response.status === 404,
    "User cannot rate another User's booking",
    response,
  );

  const afterBooking = await loadBookingState(bookingId);
  const afterProvider = await loadVendorState(provider.id);

  ok(
    JSON.stringify(beforeBooking) === JSON.stringify(afterBooking),
    "Unauthorized User rating leaves booking unchanged",
    {
      before: beforeBooking,
      after: afterBooking,
    },
  );

  ok(
    JSON.stringify(beforeProvider) === JSON.stringify(afterProvider),
    "Unauthorized User rating leaves provider rating/accounting unchanged",
  );
}

/*
 * ============================================================
 * LEGITIMATE VENDOR-AS-CUSTOMER RATING
 * ============================================================
 */

async function testLegitimateVendorCustomerRating() {
  section("RATING - LEGITIMATE VENDOR-AS-CUSTOMER");

  const customer = await signupAndLoginVendor({
    label: "LEGIT VENDOR CUSTOMER RATING CUSTOMER",
  });

  const provider = await signupAndLoginVendor({
    label: "LEGIT VENDOR CUSTOMER RATING PROVIDER",
  });

  const bookingId = await seedBooking({
    customerId: customer.id,
    providerId: provider.id,
    completed: true,
    ratingPermission: true,
    rating: 0,
  });

  const response = await rateAsVendor({
    token: customer.token,
    bookingId,
    rating: 4,
  });

  httpOk(response.status === 200, "Vendor acting as customer can rate own booking", response);

  const booking = await loadBookingState(bookingId);

  ok(booking.rating === 4, "Vendor-customer rating is persisted", booking);
}

/*
 * ============================================================
 * VENDOR CUSTOMER RATING IDOR
 * ============================================================
 */

async function testVendorCustomerRatingIdor() {
  section("RATING - VENDOR CUSTOMER IDOR ATTACK");

  const victim = await signupAndLoginVendor({
    label: "VENDOR RATING IDOR VICTIM",
  });

  const attacker = await signupAndLoginVendor({
    label: "VENDOR RATING IDOR ATTACKER",
  });

  const provider = await signupAndLoginVendor({
    label: "VENDOR RATING IDOR PROVIDER",
  });

  const bookingId = await seedBooking({
    customerId: victim.id,
    providerId: provider.id,
    completed: true,
    ratingPermission: true,
  });

  const beforeBooking = await loadBookingState(bookingId);
  const beforeProvider = await loadVendorState(provider.id);

  const response = await rateAsVendor({
    token: attacker.token,
    bookingId,
    rating: 5,
  });

  httpOk(
    response.status === 403 || response.status === 404,
    "Vendor cannot rate another Vendor customer's booking",
    response,
  );

  const afterBooking = await loadBookingState(bookingId);
  const afterProvider = await loadVendorState(provider.id);

  ok(
    JSON.stringify(beforeBooking) === JSON.stringify(afterBooking),
    "Unauthorized Vendor-customer rating leaves booking unchanged",
    {
      before: beforeBooking,
      after: afterBooking,
    },
  );

  ok(
    JSON.stringify(beforeProvider) === JSON.stringify(afterProvider),
    "Unauthorized Vendor-customer rating leaves provider unchanged",
  );
}

/*
 * ============================================================
 * CROSS ROLE RATING
 * ============================================================
 */

async function testRatingCrossRole() {
  section("RATING - CROSS ROLE AUTHORIZATION");

  const user = await signupAndLoginUser({
    label: "RATING CROSS ROLE USER",
  });

  const vendorCustomer = await signupAndLoginVendor({
    label: "RATING CROSS ROLE VENDOR CUSTOMER",
  });

  const provider = await signupAndLoginVendor({
    label: "RATING CROSS ROLE PROVIDER",
  });

  const userBookingId = await seedBooking({
    customerId: user.id,
    providerId: provider.id,
  });

  const vendorBookingId = await seedBooking({
    customerId: vendorCustomer.id,
    providerId: provider.id,
  });

  const userOnVendorRoute = await rateAsVendor({
    token: user.token,
    bookingId: vendorBookingId,
    rating: 5,
  });

  httpOk(
    userOnVendorRoute.status === 401 || userOnVendorRoute.status === 403,
    "User JWT cannot use ratingV route",
    userOnVendorRoute,
  );

  const vendorOnUserRoute = await rateAsUser({
    token: vendorCustomer.token,
    bookingId: userBookingId,
    rating: 5,
  });

  httpOk(
    vendorOnUserRoute.status === 401 || vendorOnUserRoute.status === 403,
    "Vendor JWT cannot use ratingU route",
    vendorOnUserRoute,
  );

  const userBooking = await loadBookingState(userBookingId);
  const vendorBooking = await loadBookingState(vendorBookingId);

  ok(userBooking.rating === 0, "Cross-role Vendor request cannot mutate User booking");

  ok(vendorBooking.rating === 0, "Cross-role User request cannot mutate Vendor-customer booking");
}

/*
 * ============================================================
 * PROVIDER CANNOT RATE CUSTOMER BOOKING
 * ============================================================
 */

async function testProviderCannotRateAsCustomer() {
  section("RATING - PROVIDER IS NOT CUSTOMER");

  const customer = await signupAndLoginVendor({
    label: "PROVIDER NOT CUSTOMER REAL CUSTOMER",
  });

  const provider = await signupAndLoginVendor({
    label: "PROVIDER NOT CUSTOMER PROVIDER",
  });

  const bookingId = await seedBooking({
    customerId: customer.id,
    providerId: provider.id,
    completed: true,
    ratingPermission: true,
  });

  const before = await loadBookingState(bookingId);

  const response = await rateAsVendor({
    token: provider.token,
    bookingId,
    rating: 5,
  });

  httpOk(
    response.status === 403 || response.status === 404,
    "Service provider cannot rate booking merely because booking.vendorId matches JWT",
    response,
  );

  const after = await loadBookingState(bookingId);

  ok(
    JSON.stringify(before) === JSON.stringify(after),
    "Provider-as-attacker leaves booking unchanged",
    {
      before,
      after,
    },
  );
}

/*
 * ============================================================
 * RATING PERMISSION REQUIRED
 * ============================================================
 */

async function testRatingPermissionRequired() {
  section("RATING - PERMISSION REQUIRED");

  const customer = await signupAndLoginUser({
    label: "RATING PERMISSION CUSTOMER",
  });

  const provider = await signupAndLoginVendor({
    label: "RATING PERMISSION PROVIDER",
  });

  const bookingId = await seedBooking({
    customerId: customer.id,
    providerId: provider.id,
    completed: true,
    cancelled: false,
    ratingPermission: false,
  });

  const response = await rateAsUser({
    token: customer.token,
    bookingId,
    rating: 5,
  });

  httpOk(
    response.status === 400 || response.status === 403 || response.status === 409,
    "Booking without ratingPermission cannot be rated",
    response,
  );

  const booking = await loadBookingState(bookingId);

  ok(booking.rating === 0, "Rejected permissionless rating leaves rating unchanged");
}

/*
 * ============================================================
 * INCOMPLETE BOOKING
 * ============================================================
 */

async function testIncompleteBookingCannotBeRated() {
  section("RATING - INCOMPLETE BOOKING");

  const customer = await signupAndLoginUser({
    label: "INCOMPLETE RATING CUSTOMER",
  });

  const provider = await signupAndLoginVendor({
    label: "INCOMPLETE RATING PROVIDER",
  });

  const bookingId = await seedBooking({
    customerId: customer.id,
    providerId: provider.id,
    completed: false,
    cancelled: false,
    ratingPermission: true,
  });

  const response = await rateAsUser({
    token: customer.token,
    bookingId,
    rating: 5,
  });

  httpOk(isRejected(response.status), "Incomplete booking cannot be rated", response);

  const booking = await loadBookingState(bookingId);

  ok(booking.rating === 0, "Rejected incomplete-booking rating leaves rating unchanged");
}

/*
 * ============================================================
 * CANCELLED BOOKING
 * ============================================================
 */

async function testCancelledBookingCannotBeRated() {
  section("RATING - CANCELLED BOOKING");

  const customer = await signupAndLoginUser({
    label: "CANCELLED RATING CUSTOMER",
  });

  const provider = await signupAndLoginVendor({
    label: "CANCELLED RATING PROVIDER",
  });

  const bookingId = await seedBooking({
    customerId: customer.id,
    providerId: provider.id,
    completed: false,
    cancelled: true,
    ratingPermission: false,
  });

  const response = await rateAsUser({
    token: customer.token,
    bookingId,
    rating: 5,
  });

  httpOk(isRejected(response.status), "Cancelled booking cannot be rated", response);

  const booking = await loadBookingState(bookingId);

  ok(booking.rating === 0, "Rejected cancelled-booking rating leaves rating unchanged");
}

/*
 * ============================================================
 * NONEXISTENT / MALFORMED BOOKING ID
 * ============================================================
 */

async function testInvalidBookingIds() {
  section("RATING - INVALID BOOKING IDENTIFIERS");

  const customer = await signupAndLoginUser({
    label: "INVALID BOOKING ID CUSTOMER",
  });

  const nonexistent = new ObjectId().toString();

  const nonexistentRes = await rateAsUser({
    token: customer.token,
    bookingId: nonexistent,
    rating: 5,
  });

  httpOk(nonexistentRes.status === 404, "Nonexistent booking cannot be rated", nonexistentRes);

  const malformedRes = await rateAsUser({
    token: customer.token,
    bookingId: "not-a-valid-object-id",
    rating: 5,
  });

  httpOk(
    malformedRes.status === 400 || malformedRes.status === 422,
    "Malformed bookingId is rejected",
    malformedRes,
  );
}

/*
 * ============================================================
 * INVALID RATINGS
 * ============================================================
 */

async function testInvalidRatings() {
  section("RATING - INVALID RATING VALUES");

  const customer = await signupAndLoginUser({
    label: "INVALID RATING CUSTOMER",
  });

  const provider = await signupAndLoginVendor({
    label: "INVALID RATING PROVIDER",
  });

  const invalidValues = [0, -1, 6, 100, "abc", null];

  for (let index = 0; index < invalidValues.length; index += 1) {
    const bookingId = await seedBooking({
      customerId: customer.id,
      providerId: provider.id,
      completed: true,
      ratingPermission: true,
      rating: 0,
      days: 30 + index,
    });

    const value = invalidValues[index];

    const response = await rateAsUser({
      token: customer.token,
      bookingId,
      rating: value,
    });

    httpOk(
      response.status === 400 || response.status === 422,
      `Invalid rating ${JSON.stringify(value)} is rejected`,
      response,
    );

    const booking = await loadBookingState(bookingId);

    ok(
      booking.rating === 0,
      `Invalid rating ${JSON.stringify(value)} does not mutate booking`,
      booking,
    );
  }
}

/*
 * ============================================================
 * DUPLICATE RATING
 * ============================================================
 */

async function testDuplicateRating() {
  section("RATING - DUPLICATE REQUEST");

  const customer = await signupAndLoginUser({
    label: "DUPLICATE RATING CUSTOMER",
  });

  const provider = await signupAndLoginVendor({
    label: "DUPLICATE RATING PROVIDER",
  });

  const bookingId = await seedBooking({
    customerId: customer.id,
    providerId: provider.id,
    completed: true,
    ratingPermission: true,
    rating: 0,
  });

  const first = await rateAsUser({
    token: customer.token,
    bookingId,
    rating: 5,
  });

  httpOk(first.status === 200, "First legitimate rating succeeds", first);

  const afterFirstBooking = await loadBookingState(bookingId);
  const afterFirstProvider = await loadVendorState(provider.id);

  ok(afterFirstBooking.rating === 5, "First rating persists exactly once");

  const second = await rateAsUser({
    token: customer.token,
    bookingId,
    rating: 4,
  });

  httpOk(
    second.status === 400 || second.status === 409,
    "Second rating attempt is rejected",
    second,
  );

  const afterSecondBooking = await loadBookingState(bookingId);
  const afterSecondProvider = await loadVendorState(provider.id);

  ok(afterSecondBooking.rating === 5, "Duplicate request cannot overwrite original rating", {
    afterFirstBooking,
    afterSecondBooking,
  });

  ok(
    JSON.stringify(afterFirstProvider) === JSON.stringify(afterSecondProvider),
    "Duplicate rejected rating does not mutate provider again",
    {
      afterFirstProvider,
      afterSecondProvider,
    },
  );
}

/*
 * ============================================================
 * CONCURRENT RATING
 * ============================================================
 */

async function testConcurrentRating() {
  section("RATING - CONCURRENT REQUESTS");

  const customer = await signupAndLoginUser({
    label: "CONCURRENT RATING CUSTOMER",
  });

  const provider = await signupAndLoginVendor({
    label: "CONCURRENT RATING PROVIDER",
  });

  const bookingId = await seedBooking({
    customerId: customer.id,
    providerId: provider.id,
    completed: true,
    ratingPermission: true,
    rating: 0,
  });

  const responses = await Promise.all([
    rateAsUser({
      token: customer.token,
      bookingId,
      rating: 4,
    }),

    rateAsUser({
      token: customer.token,
      bookingId,
      rating: 5,
    }),
  ]);

  const successCount = responses.filter((response) => response.status === 200).length;

  ok(successCount === 1, "Exactly one concurrent rating request succeeds", responses);

  const booking = await loadBookingState(bookingId);

  ok(
    booking.rating === 4 || booking.rating === 5,
    "Concurrent rating leaves one valid final rating",
    booking,
  );
}

/*
 * ============================================================
 * USER SHARE - MISSING JWT
 * ============================================================
 */

async function testUserShareMissingJwt() {
  section("USER getShare - MISSING JWT");

  const owner = await signupAndLoginUser({
    label: "USER SHARE MISSING JWT OWNER",
  });

  await seedUserShare({
    userId: owner.id,
    phoneNo: nextPhone(),
  });

  const response = await requestJson("GET", `/user/getShare/${owner.id}/0`);

  httpOk(response.status === 401, "User getShare rejects missing JWT", response);
}

/*
 * ============================================================
 * USER SHARE - INVALID JWT
 * ============================================================
 */

async function testUserShareInvalidJwt() {
  section("USER getShare - INVALID JWT");

  const owner = await signupAndLoginUser({
    label: "USER SHARE INVALID JWT OWNER",
  });

  const response = await requestJson("GET", `/user/getShare/${owner.id}/0`, {
    token: "invalid.jwt.value",
  });

  httpOk(response.status === 401, "User getShare rejects invalid JWT", response);
}

/*
 * ============================================================
 * USER SHARE - LEGITIMATE READ
 * ============================================================
 */

async function testUserShareLegitimateRead() {
  section("USER getShare - LEGITIMATE READ");

  const owner = await signupAndLoginUser({
    label: "USER SHARE OWNER",
  });

  const foreign = await signupAndLoginUser({
    label: "USER SHARE FOREIGN OWNER",
  });

  const ownShare1 = await seedUserShare({
    userId: owner.id,
    phoneNo: nextPhone(),
    status: "pending",
  });

  const ownShare2 = await seedUserShare({
    userId: owner.id,
    phoneNo: nextPhone(),
    status: "accepted",
  });

  const foreignShare = await seedUserShare({
    userId: foreign.id,
    phoneNo: nextPhone(),
    status: "completed",
  });

  const response = await requestJson("GET", `/user/getShare/${owner.id}/0`, {
    token: owner.token,
  });

  httpOk(response.status === 200, "User can retrieve own shares", response);

  const ids = shareIds(response);

  ok(
    ids.includes(ownShare1) && ids.includes(ownShare2),
    "User response contains own seeded shares",
    {
      ids,
      ownShare1,
      ownShare2,
    },
  );

  ok(!ids.includes(foreignShare), "User response does not leak foreign share", {
    ids,
    foreignShare,
  });

  ok(
    getShareTotal(response) === 2,
    "User share total is scoped to authenticated owner",
    response.data,
  );
}

/*
 * ============================================================
 * USER SHARE - IDOR
 * ============================================================
 */

async function testUserShareIdor() {
  section("USER getShare - IDOR ATTACK");

  const victim = await signupAndLoginUser({
    label: "USER SHARE IDOR VICTIM",
  });

  const attacker = await signupAndLoginUser({
    label: "USER SHARE IDOR ATTACKER",
  });

  const victimShare = await seedUserShare({
    userId: victim.id,
    phoneNo: nextPhone(),
  });

  const response = await requestJson("GET", `/user/getShare/${victim.id}/0`, {
    token: attacker.token,
  });

  httpOk(
    response.status === 403 || response.status === 404,
    "User cannot retrieve another User's shares",
    response,
  );

  const ids = shareIds(response);

  ok(!ids.includes(victimShare), "Rejected User IDOR response does not leak victim Share ID", {
    victimShare,
    response: response.data,
  });

  ok(
    getShareTotal(response) === null || getShareTotal(response) === 0,
    "Rejected User IDOR response does not leak victim share total",
    response.data,
  );
}

/*
 * ============================================================
 * USER SHARE - CROSS ROLE
 * ============================================================
 */

async function testUserShareCrossRole() {
  section("USER getShare - CROSS ROLE VENDOR JWT");

  const owner = await signupAndLoginUser({
    label: "USER SHARE CROSS ROLE OWNER",
  });

  const vendor = await signupAndLoginVendor({
    label: "USER SHARE CROSS ROLE VENDOR",
  });

  const response = await requestJson("GET", `/user/getShare/${owner.id}/0`, {
    token: vendor.token,
  });

  httpOk(
    response.status === 401 || response.status === 403,
    "Vendor JWT cannot access User getShare route",
    response,
  );
}

/*
 * ============================================================
 * VENDOR SHARE - MISSING / INVALID JWT
 * ============================================================
 */

async function testVendorShareAuthentication() {
  section("VENDOR getShare - AUTHENTICATION");

  const owner = await signupAndLoginVendor({
    label: "VENDOR SHARE AUTH OWNER",
  });

  const missing = await requestJson("GET", `/vendor/getShare/${owner.id}/0`);

  httpOk(missing.status === 401, "Vendor getShare rejects missing JWT", missing);

  const invalid = await requestJson("GET", `/vendor/getShare/${owner.id}/0`, {
    token: "invalid.jwt.value",
  });

  httpOk(invalid.status === 401, "Vendor getShare rejects invalid JWT", invalid);
}

/*
 * ============================================================
 * VENDOR SHARE - LEGITIMATE READ
 * ============================================================
 */

async function testVendorShareLegitimateRead() {
  section("VENDOR getShare - LEGITIMATE READ");

  const owner = await signupAndLoginVendor({
    label: "VENDOR SHARE OWNER",
  });

  const foreign = await signupAndLoginVendor({
    label: "VENDOR SHARE FOREIGN OWNER",
  });

  const ownShare1 = await seedVendorShare({
    vendorId: owner.id,
    phoneNo: nextPhone(),
    status: "pending",
  });

  const ownShare2 = await seedVendorShare({
    vendorId: owner.id,
    phoneNo: nextPhone(),
    status: "completed",
  });

  const foreignShare = await seedVendorShare({
    vendorId: foreign.id,
    phoneNo: nextPhone(),
  });

  const response = await requestJson("GET", `/vendor/getShare/${owner.id}/0`, {
    token: owner.token,
  });

  httpOk(response.status === 200, "Vendor can retrieve own shares", response);

  const ids = shareIds(response);

  ok(
    ids.includes(ownShare1) && ids.includes(ownShare2),
    "Vendor response contains own seeded shares",
    {
      ids,
      ownShare1,
      ownShare2,
    },
  );

  ok(!ids.includes(foreignShare), "Vendor response does not leak foreign share", {
    ids,
    foreignShare,
  });

  ok(
    getShareTotal(response) === 2,
    "Vendor share total is scoped to authenticated Vendor",
    response.data,
  );
}

/*
 * ============================================================
 * VENDOR SHARE - IDOR
 * ============================================================
 */

async function testVendorShareIdor() {
  section("VENDOR getShare - IDOR ATTACK");

  const victim = await signupAndLoginVendor({
    label: "VENDOR SHARE IDOR VICTIM",
  });

  const attacker = await signupAndLoginVendor({
    label: "VENDOR SHARE IDOR ATTACKER",
  });

  const victimShare = await seedVendorShare({
    vendorId: victim.id,
    phoneNo: nextPhone(),
  });

  const response = await requestJson("GET", `/vendor/getShare/${victim.id}/0`, {
    token: attacker.token,
  });

  httpOk(
    response.status === 403 || response.status === 404,
    "Vendor cannot retrieve another Vendor's shares",
    response,
  );

  const ids = shareIds(response);

  ok(!ids.includes(victimShare), "Rejected Vendor IDOR response does not leak victim Share ID", {
    victimShare,
    response: response.data,
  });

  ok(
    getShareTotal(response) === null || getShareTotal(response) === 0,
    "Rejected Vendor IDOR response does not leak victim share total",
    response.data,
  );
}

/*
 * ============================================================
 * VENDOR SHARE - CROSS ROLE
 * ============================================================
 */

async function testVendorShareCrossRole() {
  section("VENDOR getShare - CROSS ROLE USER JWT");

  const vendor = await signupAndLoginVendor({
    label: "VENDOR SHARE CROSS ROLE OWNER",
  });

  const user = await signupAndLoginUser({
    label: "VENDOR SHARE CROSS ROLE USER",
  });

  const response = await requestJson("GET", `/vendor/getShare/${vendor.id}/0`, {
    token: user.token,
  });

  httpOk(
    response.status === 401 || response.status === 403,
    "User JWT cannot access Vendor getShare route",
    response,
  );
}

/*
 * ============================================================
 * SHARE - MALFORMED ACCOUNT IDS
 * ============================================================
 */

async function testShareMalformedIds() {
  section("getShare - MALFORMED ACCOUNT IDS");

  const user = await signupAndLoginUser({
    label: "MALFORMED SHARE USER",
  });

  const vendor = await signupAndLoginVendor({
    label: "MALFORMED SHARE VENDOR",
  });

  const userResponse = await requestJson("GET", "/user/getShare/not-an-object-id/0", {
    token: user.token,
  });

  httpOk(
    userResponse.status === 400 || userResponse.status === 403 || userResponse.status === 422,
    "Malformed User ID is rejected",
    userResponse,
  );

  const vendorResponse = await requestJson("GET", "/vendor/getShare/not-an-object-id/0", {
    token: vendor.token,
  });

  httpOk(
    vendorResponse.status === 400 || vendorResponse.status === 403 || vendorResponse.status === 422,
    "Malformed Vendor ID is rejected",
    vendorResponse,
  );
}

/*
 * ============================================================
 * SHARE PAGINATION
 * ============================================================
 */

async function testUserSharePagination() {
  section("USER getShare - PAGINATION");

  const owner = await signupAndLoginUser({
    label: "USER SHARE PAGINATION OWNER",
  });

  const seeded = [];

  for (let index = 0; index < 15; index += 1) {
    seeded.push(
      await seedUserShare({
        userId: owner.id,
        phoneNo: nextPhone(),
        status: "pending",
        shareDate: new Date(Date.now() + index * 1000),
      }),
    );
  }

  const firstPage = await requestJson("GET", `/user/getShare/${owner.id}/0`, {
    token: owner.token,
  });

  httpOk(firstPage.status === 200, "User first share page succeeds", firstPage);

  ok(
    getShareArray(firstPage).length <= 12,
    "User getShare enforces 12-item page limit",
    firstPage.data,
  );

  ok(getShareTotal(firstPage) === 15, "User share total reports all owner shares", firstPage.data);

  const secondPage = await requestJson("GET", `/user/getShare/${owner.id}/12`, {
    token: owner.token,
  });

  httpOk(secondPage.status === 200, "User second share page succeeds", secondPage);

  ok(
    getShareArray(secondPage).length === 3,
    "User skip=12 returns remaining 3 shares",
    secondPage.data,
  );

  const firstIds = new Set(shareIds(firstPage));
  const secondIds = shareIds(secondPage);

  ok(
    secondIds.every((shareId) => !firstIds.has(shareId)),
    "User share pages do not overlap",
    {
      first: [...firstIds],
      second: secondIds,
    },
  );
}

/*
 * ============================================================
 * SHARE SKIP EDGE CASES
 * ============================================================
 */

async function testShareSkipEdgeCases() {
  section("getShare - SKIP EDGE CASES");

  const user = await signupAndLoginUser({
    label: "SHARE SKIP USER",
  });

  const vendor = await signupAndLoginVendor({
    label: "SHARE SKIP VENDOR",
  });

  for (let index = 0; index < 3; index += 1) {
    await seedUserShare({
      userId: user.id,
      phoneNo: nextPhone(),
    });

    await seedVendorShare({
      vendorId: vendor.id,
      phoneNo: nextPhone(),
    });
  }

  /*
   * Non-numeric skip currently becomes 0 through:
   *
   * parseInt(skipParam) || 0
   *
   * This test documents that behavior.
   */

  const userNonNumeric = await requestJson("GET", `/user/getShare/${user.id}/abc`, {
    token: user.token,
  });

  httpOk(
    userNonNumeric.status === 200 || userNonNumeric.status === 400,
    "User nonnumeric skip is handled safely",
    userNonNumeric,
  );

  if (userNonNumeric.status === 200) {
    ok(getShareArray(userNonNumeric).length <= 12, "User nonnumeric skip cannot bypass page limit");
  }

  const vendorNonNumeric = await requestJson("GET", `/vendor/getShare/${vendor.id}/abc`, {
    token: vendor.token,
  });

  httpOk(
    vendorNonNumeric.status === 200 || vendorNonNumeric.status === 400,
    "Vendor nonnumeric skip is handled safely",
    vendorNonNumeric,
  );

  /*
   * Huge skip must never leak another account's data.
   *
   * Current service may return an empty array because skip
   * correction occurs after the database query.
   */

  const hugeUserSkip = await requestJson("GET", `/user/getShare/${user.id}/999999`, {
    token: user.token,
  });

  httpOk(
    hugeUserSkip.status === 200 || hugeUserSkip.status === 400,
    "Huge User skip is handled without server error",
    hugeUserSkip,
  );

  if (hugeUserSkip.status === 200) {
    const returned = getShareArray(hugeUserSkip);

    ok(returned.length <= 12, "Huge User skip cannot bypass page limit", returned);

    ok(
      returned.every((share) => !share.userId || id(share.userId) === user.id),
      "Huge User skip cannot leak another user's shares",
      returned,
    );
  }

  const hugeVendorSkip = await requestJson("GET", `/vendor/getShare/${vendor.id}/999999`, {
    token: vendor.token,
  });

  httpOk(
    hugeVendorSkip.status === 200 || hugeVendorSkip.status === 400,
    "Huge Vendor skip is handled without server error",
    hugeVendorSkip,
  );

  if (hugeVendorSkip.status === 200) {
    const returned = getShareArray(hugeVendorSkip);

    ok(returned.length <= 12, "Huge Vendor skip cannot bypass page limit", returned);

    ok(
      returned.every((share) => !share.vendorId || id(share.vendorId) === vendor.id),
      "Huge Vendor skip cannot leak another Vendor's shares",
      returned,
    );
  }
}

/*
 * ============================================================
 * SHARE ISOLATION STRESS TEST
 * ============================================================
 */

async function testShareIsolation() {
  section("getShare - ACCOUNT ISOLATION");

  const userA = await signupAndLoginUser({
    label: "SHARE ISOLATION USER A",
  });

  const userB = await signupAndLoginUser({
    label: "SHARE ISOLATION USER B",
  });

  const vendorA = await signupAndLoginVendor({
    label: "SHARE ISOLATION VENDOR A",
  });

  const vendorB = await signupAndLoginVendor({
    label: "SHARE ISOLATION VENDOR B",
  });

  const userAShares = [];
  const userBShares = [];
  const vendorAShares = [];
  const vendorBShares = [];

  for (let index = 0; index < 5; index += 1) {
    userAShares.push(
      await seedUserShare({
        userId: userA.id,
        phoneNo: nextPhone(),
      }),
    );

    userBShares.push(
      await seedUserShare({
        userId: userB.id,
        phoneNo: nextPhone(),
      }),
    );

    vendorAShares.push(
      await seedVendorShare({
        vendorId: vendorA.id,
        phoneNo: nextPhone(),
      }),
    );

    vendorBShares.push(
      await seedVendorShare({
        vendorId: vendorB.id,
        phoneNo: nextPhone(),
      }),
    );
  }

  const userResponse = await requestJson("GET", `/user/getShare/${userA.id}/0`, {
    token: userA.token,
  });

  httpOk(userResponse.status === 200, "User A share isolation request succeeds", userResponse);

  const returnedUserIds = shareIds(userResponse);

  ok(
    userAShares.every((shareId) => returnedUserIds.includes(shareId)),
    "User A receives User A shares",
  );

  ok(
    userBShares.every((shareId) => !returnedUserIds.includes(shareId)),
    "User A receives no User B shares",
    {
      returnedUserIds,
      userBShares,
    },
  );

  const vendorResponse = await requestJson("GET", `/vendor/getShare/${vendorA.id}/0`, {
    token: vendorA.token,
  });

  httpOk(
    vendorResponse.status === 200,
    "Vendor A share isolation request succeeds",
    vendorResponse,
  );

  const returnedVendorIds = shareIds(vendorResponse);

  ok(
    vendorAShares.every((shareId) => returnedVendorIds.includes(shareId)),
    "Vendor A receives Vendor A shares",
  );

  ok(
    vendorBShares.every((shareId) => !returnedVendorIds.includes(shareId)),
    "Vendor A receives no Vendor B shares",
    {
      returnedVendorIds,
      vendorBShares,
    },
  );
}

/*
 * ============================================================
 * CLEANUP
 * ============================================================
 */

async function cleanup() {
  section("CLEANUP");

  let bookingsDeleted = 0;
  let sharesDeleted = 0;
  let usersDeleted = 0;
  let vendorsDeleted = 0;

  if (createdBookings.length > 0) {
    const result = await Bookings.deleteMany({
      _id: {
        $in: createdBookings,
      },
    });

    bookingsDeleted = result.deletedCount || 0;
  }

  if (createdShares.length > 0) {
    const result = await Share.deleteMany({
      _id: {
        $in: createdShares,
      },
    });

    sharesDeleted = result.deletedCount || 0;
  }

  if (createdUsers.length > 0) {
    /*
     * Remove any shares potentially created automatically
     * during signup/referral flows.
     */
    await Share.deleteMany({
      userId: {
        $in: createdUsers,
      },
    });

    const result = await User.deleteMany({
      _id: {
        $in: createdUsers,
      },
    });

    usersDeleted = result.deletedCount || 0;
  }

  if (createdVendors.length > 0) {
    await Share.deleteMany({
      vendorId: {
        $in: createdVendors,
      },
    });

    const result = await Vendor.deleteMany({
      _id: {
        $in: createdVendors,
      },
    });

    vendorsDeleted = result.deletedCount || 0;
  }

  console.log({
    bookingsDeleted,
    sharesDeleted,
    usersDeleted,
    vendorsDeleted,
  });
}

/*
 * ============================================================
 * FINAL REPORT
 * ============================================================
 */

function printFinalReport() {
  section("FINAL RATING + SHARE SECURITY TEST SUMMARY");

  console.log(`Assertions: ${assertions}`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);

  if (suiteCrashed) {
    console.log("\nTEST SUITE CRASHED BEFORE COMPLETION.");
    return;
  }

  if (failed > 0) {
    section(`FAIL: ${failed} RATING / SHARE AUTHORIZATION SECURITY TEST(S) FAILED`);

    console.log(`
IMPORTANT:

A failed assertion may indicate:

- IDOR
- Broken Object Level Authorization
- role confusion
- unauthorized rating mutation
- referral/share information disclosure
- duplicate/concurrent rating weakness

The authoritative customer identity must come from JWT.

For ratingU:

    req.auth.role === "user"
    req.auth.id === booking.userId

For ratingV:

    req.auth.role === "vendor"
    req.auth.id === booking.userId

The service provider is:

    booking.vendorId

and MUST NOT automatically be treated as the customer.

For User getShare:

    JWT userId === requested userId

For Vendor getShare:

    JWT vendorId === requested vendorId

DO NOT weaken this test to accept an unauthorized HTTP 200.
`);

    return;
  }

  section("PASS: BOOKING RATING + SHARE AUTHORIZATION SECURITY TESTS PASSED");

  console.log(`
Verified:

✓ Real signup/login/JWT flow works

RATING

✓ Missing JWT cannot rate
✓ Invalid JWT cannot rate
✓ User can rate own eligible booking
✓ Vendor acting as customer can rate own eligible booking
✓ User cannot rate another User's booking
✓ Vendor cannot rate another Vendor customer's booking
✓ User JWT cannot use Vendor rating route
✓ Vendor JWT cannot use User rating route
✓ Service provider is not automatically the customer
✓ ratingPermission is enforced
✓ Incomplete booking cannot be rated
✓ Cancelled booking cannot be rated
✓ Nonexistent booking is rejected
✓ Malformed bookingId is rejected
✓ Invalid rating values are rejected
✓ Duplicate rating cannot overwrite original rating
✓ Concurrent rating has exactly one successful mutation
✓ Unauthorized rating leaves booking unchanged
✓ Unauthorized rating leaves provider state unchanged

USER getShare

✓ Missing JWT is rejected
✓ Invalid JWT is rejected
✓ User can retrieve own shares
✓ User cannot retrieve another User's shares
✓ Vendor JWT cannot access User getShare
✓ Foreign Share IDs are not leaked
✓ Foreign share totals are not leaked
✓ Pagination is account scoped
✓ Page size is bounded

VENDOR getShare

✓ Missing JWT is rejected
✓ Invalid JWT is rejected
✓ Vendor can retrieve own shares
✓ Vendor cannot retrieve another Vendor's shares
✓ User JWT cannot access Vendor getShare
✓ Foreign Share IDs are not leaked
✓ Foreign share totals are not leaked
✓ Pagination is account scoped
✓ Page size is bounded

ISOLATION

✓ User A never receives User B shares
✓ Vendor A never receives Vendor B shares
✓ JWT identity is authoritative
`);
}

/*
 * ============================================================
 * MAIN
 * ============================================================
 */

async function main() {
  section("BOOKING RATING + SHARE AUTHORIZATION / IDOR E2E SECURITY TEST");

  console.log({
    api: API,
    nodeEnv: process.env.NODE_ENV,
  });

  assertSafeEnvironment();

  await connectMongo();

  /*
   * ----------------------------------------------------------
   * RATING SECURITY
   * ----------------------------------------------------------
   */

  await testRatingMissingJwt();
  await testRatingInvalidJwt();

  await testLegitimateUserRating();
  await testUserRatingIdor();

  await testLegitimateVendorCustomerRating();
  await testVendorCustomerRatingIdor();

  await testRatingCrossRole();
  await testProviderCannotRateAsCustomer();

  await testRatingPermissionRequired();
  await testIncompleteBookingCannotBeRated();
  await testCancelledBookingCannotBeRated();

  await testInvalidBookingIds();
  await testInvalidRatings();

  await testDuplicateRating();
  await testConcurrentRating();

  /*
   * ----------------------------------------------------------
   * USER SHARE SECURITY
   * ----------------------------------------------------------
   */

  await testUserShareMissingJwt();
  await testUserShareInvalidJwt();
  await testUserShareLegitimateRead();
  await testUserShareIdor();
  await testUserShareCrossRole();

  /*
   * ----------------------------------------------------------
   * VENDOR SHARE SECURITY
   * ----------------------------------------------------------
   */

  await testVendorShareAuthentication();
  await testVendorShareLegitimateRead();
  await testVendorShareIdor();
  await testVendorShareCrossRole();

  /*
   * ----------------------------------------------------------
   * SHARE VALIDATION / PAGINATION / ISOLATION
   * ----------------------------------------------------------
   */

  await testShareMalformedIds();
  await testUserSharePagination();
  await testShareSkipEdgeCases();
  await testShareIsolation();
}

/*
 * ============================================================
 * RUN
 * ============================================================
 */

(async () => {
  try {
    await main();
  } catch (error) {
    suiteCrashed = true;

    section("TEST CRASHED");

    console.error(error?.stack || error);
  } finally {
    try {
      if (mongoose.connection.readyState !== 0) {
        await cleanup();
      }
    } catch (cleanupError) {
      suiteCrashed = true;

      console.error("Cleanup failed:", cleanupError?.stack || cleanupError);
    }

    try {
      if (mongoose.connection.readyState !== 0) {
        await mongoose.disconnect();
        console.log("\nMongoDB disconnected.");
      }
    } catch (disconnectError) {
      console.error("MongoDB disconnect failed:", disconnectError?.stack || disconnectError);
    }

    printFinalReport();

    if (suiteCrashed || failed > 0) {
      process.exitCode = 1;
    } else {
      process.exitCode = 0;
    }
  }
})();
