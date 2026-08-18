/**
 * ============================================================
 * BOOKING CREATION AUTHORIZATION / IDOR E2E SECURITY TEST
 * ============================================================
 *
 * PURPOSE
 *
 * Verify that booking creation cannot be used to impersonate
 * another User or Vendor customer.
 *
 * SECURITY INVARIANT:
 *
 *   JWT identity is authoritative.
 *
 * A client must never be able to submit another account's
 * userId and create a booking on that account's behalf.
 *
 * RUN SERVER:
 *
 * NODE_ENV=development ALLOW_AUTHORIZATION_TEST=1 npm run dev
 *
 * RUN TEST:
 *
 * NODE_ENV=development ALLOW_AUTHORIZATION_TEST=1 \
 * node tests/booking-creation-authorization-e2e-test.js
 */

const mongoose = require("mongoose");

const User = require("../models/user");
const Vendor = require("../models/vendor");
const Bookings = require("../models/bookings");

const ENV = require("../src/config/env");
const { createVerifiedSignupOtp } = require("./helpers/otp-auth-test-helper");
// ============================================================
// CONFIG
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
    console.dir(details, { depth: null });
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
    throw new Error("REFUSING TO RUN: creation authorization test must not run in production.");
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
  return `creation-security-${role}-${uniqueSuffix()}@example.com`;
}

function futureDate(days = 20) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toDateString();
}

function bearer(token) {
  return {
    Authorization: `Bearer ${token}`,
  };
}

function number(value) {
  return Number(value || 0);
}

// ============================================================
// HTTP
// ============================================================

async function requestJson(method, url, options = {}) {
  const headers = {
    Accept: "application/json",
    ...(options.headers || {}),
  };

  const config = {
    method: String(method).toUpperCase(),
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
    throw new Error(`HTTP request failed: ${config.method} ${url}\n${error.message}`);
  }
}

// ============================================================
// AUTH
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
    { _id: userId },
    {
      $set: {
        balance: 2000,

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
    throw new Error("User login did not return JWT.");
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
    { _id: vendorId },
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

        transactionCount: 0,
        totalDiscount: 0,
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
    throw new Error("Vendor login did not return JWT.");
  }

  return {
    kind: "vendor",
    id: String(vendorId),
    phoneNo,
    token: login.data.token,
  };
}

// ============================================================
// SNAPSHOTS
// ============================================================

async function snapshotUser(id) {
  const doc = await User.findById(id).lean();

  if (!doc) {
    throw new Error(`User not found: ${id}`);
  }

  return {
    pending: number(doc.pending),
    completed: number(doc.completed),
    canceled: number(doc.canceled),

    pendingShareBy: number(doc.pendingShareBy),
    completedShareBy: number(doc.completedShareBy),
    canceledShareBy: number(doc.canceledShareBy),

    balance: number(doc.balance),
    earning: number(doc.earning),

    transactionCount: number(doc.transactionCount),
    totalDiscount: number(doc.totalDiscount),
  };
}

async function snapshotVendor(id) {
  const doc = await Vendor.findById(id).lean();

  if (!doc) {
    throw new Error(`Vendor not found: ${id}`);
  }

  return {
    pending: number(doc.pending),
    completed: number(doc.completed),
    canceled: number(doc.canceled),

    pendingVendor: number(doc.pendingVendor),
    completedVendor: number(doc.completedVendor),
    canceledVendor: number(doc.canceledVendor),

    pendingShareBy: number(doc.pendingShareBy),
    completedShareBy: number(doc.completedShareBy),
    canceledShareBy: number(doc.canceledShareBy),

    balance: number(doc.balance),
    earning: number(doc.earning),

    transactionCount: number(doc.transactionCount),
    totalDiscount: number(doc.totalDiscount),
  };
}

function sameState(before, after) {
  return JSON.stringify(before) === JSON.stringify(after);
}

// ============================================================
// BOOKING QUERIES
// ============================================================

async function countBooking(customerId, providerId) {
  return Bookings.countDocuments({
    userId: customerId,
    vendorId: providerId,
  });
}

async function findBooking(customerId, providerId) {
  return Bookings.findOne({
    userId: customerId,
    vendorId: providerId,
  })
    .sort({
      bookedOn: -1,
      _id: -1,
    })
    .lean();
}

async function deleteBooking(customerId, providerId) {
  await Bookings.deleteMany({
    userId: customerId,
    vendorId: providerId,
  });
}

// ============================================================
// REQUEST HELPERS
// ============================================================

function bookingBody(customerId, providerId, days = 20) {
  return {
    userId: customerId,
    vendorId: providerId,

    bookingDate: futureDate(days),

    type: BOOKING_TYPE,
    pincode: PINCODE,
  };
}

async function postUserBooking(token, body) {
  return requestJson("post", `${BOOKING_PREFIX}/postToBookingsU`, {
    headers: token ? bearer(token) : undefined,
    body,
  });
}

async function postVendorBooking(token, body) {
  return requestJson("post", `${BOOKING_PREFIX}/postToBookingsV`, {
    headers: token ? bearer(token) : undefined,
    body,
  });
}

// ============================================================
// 1. LEGITIMATE USER CREATION
// ============================================================

async function testLegitimateUserCreation() {
  section("LEGITIMATE USER BOOKING CREATION");

  const customer = await signupAndLoginUser("CREATION LEGIT USER CUSTOMER");

  const provider = await signupAndLoginVendor("CREATION LEGIT USER PROVIDER");

  const customerBefore = await snapshotUser(customer.id);

  const providerBefore = await snapshotVendor(provider.id);

  const countBefore = await countBooking(customer.id, provider.id);

  const response = await postUserBooking(customer.token, bookingBody(customer.id, provider.id, 20));

  expectStatus(response, 201, "User can create booking as authenticated self");

  const countAfter = await countBooking(customer.id, provider.id);

  ok(countAfter === countBefore + 1, "Exactly one booking created for authenticated user", {
    before: countBefore,
    after: countAfter,
  });

  const booking = await findBooking(customer.id, provider.id);

  ok(Boolean(booking), "Created booking belongs to authenticated user");

  if (booking) {
    ok(
      String(booking.userId) === customer.id,
      "Booking customer ID equals authenticated User ID",
      booking,
    );

    ok(String(booking.vendorId) === provider.id, "Booking provider ID is correct", booking);
  }

  const customerAfter = await snapshotUser(customer.id);

  const providerAfter = await snapshotVendor(provider.id);

  ok(
    customerAfter.pending === customerBefore.pending + 1,
    "User pending counter incremented exactly once",
    {
      before: customerBefore,
      after: customerAfter,
    },
  );

  ok(
    providerAfter.pendingVendor === providerBefore.pendingVendor + 1,
    "Provider pendingVendor incremented exactly once",
    {
      before: providerBefore,
      after: providerAfter,
    },
  );
}

// ============================================================
// 2. USER IDENTITY SUBSTITUTION / IMPERSONATION
// ============================================================

async function testUserCannotCreateAsAnotherUser() {
  section("USER CREATION IDOR - CANNOT IMPERSONATE ANOTHER USER");

  const attacker = await signupAndLoginUser("CREATION USER ATTACKER");

  const victim = await signupAndLoginUser("CREATION USER VICTIM");

  const provider = await signupAndLoginVendor("CREATION USER IDOR PROVIDER");

  const attackerBefore = await snapshotUser(attacker.id);

  const victimBefore = await snapshotUser(victim.id);

  const providerBefore = await snapshotVendor(provider.id);

  const victimBookingCountBefore = await countBooking(victim.id, provider.id);

  const attackerBookingCountBefore = await countBooking(attacker.id, provider.id);

  /*
   * Attacker authenticates with ATTACKER JWT,
   * but supplies VICTIM userId.
   */

  const response = await postUserBooking(attacker.token, bookingBody(victim.id, provider.id, 25));

  expectStatus(response, [403, 404], "User cannot create booking using another user's ID");

  const victimBookingCountAfter = await countBooking(victim.id, provider.id);

  const attackerBookingCountAfter = await countBooking(attacker.id, provider.id);

  ok(victimBookingCountAfter === victimBookingCountBefore, "No booking created for victim", {
    before: victimBookingCountBefore,
    after: victimBookingCountAfter,
  });

  /*
   * This is important.
   *
   * A broken 'fix' could silently replace victim.id with
   * attacker.id and still create a booking.
   *
   * Our chosen security contract requires this mismatch
   * to be REJECTED, not silently rewritten.
   */

  ok(
    attackerBookingCountAfter === attackerBookingCountBefore,
    "Identity mismatch does not silently create booking for attacker",
    {
      before: attackerBookingCountBefore,
      after: attackerBookingCountAfter,
    },
  );

  const attackerAfter = await snapshotUser(attacker.id);

  const victimAfter = await snapshotUser(victim.id);

  const providerAfter = await snapshotVendor(provider.id);

  ok(sameState(attackerBefore, attackerAfter), "Attacker accounting remains unchanged");

  ok(sameState(victimBefore, victimAfter), "Victim accounting remains unchanged");

  ok(
    sameState(providerBefore, providerAfter),
    "Provider accounting remains unchanged after rejected impersonation",
  );
}

// ============================================================
// 3. LEGITIMATE VENDOR-AS-CUSTOMER CREATION
// ============================================================

async function testLegitimateVendorCustomerCreation() {
  section("LEGITIMATE VENDOR-AS-CUSTOMER BOOKING CREATION");

  const customer = await signupAndLoginVendor("CREATION LEGIT VENDOR CUSTOMER");

  const provider = await signupAndLoginVendor("CREATION LEGIT VENDOR PROVIDER");

  const customerBefore = await snapshotVendor(customer.id);

  const providerBefore = await snapshotVendor(provider.id);

  const countBefore = await countBooking(customer.id, provider.id);

  const response = await postVendorBooking(
    customer.token,
    bookingBody(customer.id, provider.id, 30),
  );

  expectStatus(response, 201, "Vendor can create booking while acting as authenticated customer");

  const countAfter = await countBooking(customer.id, provider.id);

  ok(countAfter === countBefore + 1, "Exactly one Vendor-customer booking created", {
    before: countBefore,
    after: countAfter,
  });

  const booking = await findBooking(customer.id, provider.id);

  ok(Boolean(booking), "Created booking belongs to authenticated Vendor customer");

  if (booking) {
    ok(
      String(booking.userId) === customer.id,
      "Booking customer ID equals authenticated Vendor ID",
      booking,
    );

    ok(
      String(booking.vendorId) === provider.id,
      "Vendor-customer booking provider ID is correct",
      booking,
    );
  }

  const customerAfter = await snapshotVendor(customer.id);

  const providerAfter = await snapshotVendor(provider.id);

  /*
   * IMPORTANT DOMAIN RULE:
   *
   * Vendor acting as CUSTOMER uses:
   *
   * pending
   *
   * NOT:
   *
   * pendingVendor
   */

  ok(
    customerAfter.pending === customerBefore.pending + 1,
    "Vendor acting as customer increments pending",
    {
      before: customerBefore,
      after: customerAfter,
    },
  );

  ok(
    customerAfter.pendingVendor === customerBefore.pendingVendor,
    "Vendor acting as customer does NOT increment own pendingVendor",
    {
      before: customerBefore,
      after: customerAfter,
    },
  );

  ok(
    providerAfter.pendingVendor === providerBefore.pendingVendor + 1,
    "Service provider pendingVendor increments exactly once",
    {
      before: providerBefore,
      after: providerAfter,
    },
  );
}

// ============================================================
// 4. VENDOR IDENTITY SUBSTITUTION
// ============================================================

async function testVendorCannotCreateAsAnotherVendor() {
  section("VENDOR CREATION IDOR - CANNOT IMPERSONATE ANOTHER VENDOR");

  const attacker = await signupAndLoginVendor("CREATION VENDOR ATTACKER");

  const victim = await signupAndLoginVendor("CREATION VENDOR VICTIM");

  const provider = await signupAndLoginVendor("CREATION VENDOR IDOR PROVIDER");

  const attackerBefore = await snapshotVendor(attacker.id);

  const victimBefore = await snapshotVendor(victim.id);

  const providerBefore = await snapshotVendor(provider.id);

  const victimCountBefore = await countBooking(victim.id, provider.id);

  const attackerCountBefore = await countBooking(attacker.id, provider.id);

  const response = await postVendorBooking(attacker.token, bookingBody(victim.id, provider.id, 35));

  expectStatus(
    response,
    [403, 404],
    "Vendor cannot create booking using another vendor customer's ID",
  );

  const victimCountAfter = await countBooking(victim.id, provider.id);

  const attackerCountAfter = await countBooking(attacker.id, provider.id);

  ok(victimCountAfter === victimCountBefore, "No booking created for victim Vendor");

  ok(
    attackerCountAfter === attackerCountBefore,
    "Rejected identity mismatch does not silently create attacker booking",
  );

  const attackerAfter = await snapshotVendor(attacker.id);

  const victimAfter = await snapshotVendor(victim.id);

  const providerAfter = await snapshotVendor(provider.id);

  ok(sameState(attackerBefore, attackerAfter), "Vendor attacker accounting remains unchanged");

  ok(sameState(victimBefore, victimAfter), "Victim Vendor accounting remains unchanged");

  ok(
    sameState(providerBefore, providerAfter),
    "Provider accounting remains unchanged after rejected Vendor impersonation",
  );
}

// ============================================================
// 5. USER TOKEN ON VENDOR CREATION ROUTE
// ============================================================

async function testUserCannotUseVendorCreationRoute() {
  section("CROSS ROLE - USER JWT ON VENDOR CREATION ROUTE");

  const user = await signupAndLoginUser("CREATION CROSS ROLE USER");

  const provider = await signupAndLoginVendor("CREATION CROSS ROLE USER PROVIDER");

  const userBefore = await snapshotUser(user.id);

  const providerBefore = await snapshotVendor(provider.id);

  const countBefore = await countBooking(user.id, provider.id);

  const response = await postVendorBooking(user.token, bookingBody(user.id, provider.id, 40));

  expectStatus(response, [401, 403], "User JWT cannot access Vendor booking creation route");

  const countAfter = await countBooking(user.id, provider.id);

  ok(countAfter === countBefore, "Cross-role request creates no booking");

  const userAfter = await snapshotUser(user.id);

  const providerAfter = await snapshotVendor(provider.id);

  ok(sameState(userBefore, userAfter), "User accounting unchanged after cross-role request");

  ok(
    sameState(providerBefore, providerAfter),
    "Provider accounting unchanged after cross-role request",
  );
}

// ============================================================
// 6. VENDOR TOKEN ON USER CREATION ROUTE
// ============================================================

async function testVendorCannotUseUserCreationRoute() {
  section("CROSS ROLE - VENDOR JWT ON USER CREATION ROUTE");

  const vendor = await signupAndLoginVendor("CREATION CROSS ROLE VENDOR");

  const provider = await signupAndLoginVendor("CREATION CROSS ROLE VENDOR PROVIDER");

  const vendorBefore = await snapshotVendor(vendor.id);

  const providerBefore = await snapshotVendor(provider.id);

  const countBefore = await countBooking(vendor.id, provider.id);

  const response = await postUserBooking(vendor.token, bookingBody(vendor.id, provider.id, 45));

  expectStatus(response, [401, 403], "Vendor JWT cannot access User booking creation route");

  const countAfter = await countBooking(vendor.id, provider.id);

  ok(countAfter === countBefore, "Vendor cross-role request creates no booking");

  const vendorAfter = await snapshotVendor(vendor.id);

  const providerAfter = await snapshotVendor(provider.id);

  ok(sameState(vendorBefore, vendorAfter), "Vendor accounting unchanged after cross-role request");

  ok(
    sameState(providerBefore, providerAfter),
    "Provider accounting unchanged after Vendor cross-role request",
  );
}

// ============================================================
// 7. MISSING JWT
// ============================================================

async function testMissingJwt() {
  section("MISSING JWT - BOOKING CREATION");

  const customer = await signupAndLoginUser("CREATION MISSING JWT CUSTOMER");

  const provider = await signupAndLoginVendor("CREATION MISSING JWT PROVIDER");

  const customerBefore = await snapshotUser(customer.id);

  const providerBefore = await snapshotVendor(provider.id);

  const countBefore = await countBooking(customer.id, provider.id);

  const response = await postUserBooking(null, bookingBody(customer.id, provider.id, 50));

  expectStatus(response, 401, "Booking creation rejects missing JWT");

  const countAfter = await countBooking(customer.id, provider.id);

  ok(countAfter === countBefore, "Missing JWT creates no booking");

  const customerAfter = await snapshotUser(customer.id);

  const providerAfter = await snapshotVendor(provider.id);

  ok(sameState(customerBefore, customerAfter), "Customer unchanged after unauthenticated request");

  ok(sameState(providerBefore, providerAfter), "Provider unchanged after unauthenticated request");
}

// ============================================================
// 8. INVALID JWT
// ============================================================

async function testInvalidJwt() {
  section("INVALID JWT - BOOKING CREATION");

  const customer = await signupAndLoginUser("CREATION INVALID JWT CUSTOMER");

  const provider = await signupAndLoginVendor("CREATION INVALID JWT PROVIDER");

  const customerBefore = await snapshotUser(customer.id);

  const providerBefore = await snapshotVendor(provider.id);

  const countBefore = await countBooking(customer.id, provider.id);

  const response = await requestJson("post", `${BOOKING_PREFIX}/postToBookingsU`, {
    headers: {
      Authorization: "Bearer invalid.jwt.token",
    },

    body: bookingBody(customer.id, provider.id, 55),
  });

  expectStatus(response, 401, "Booking creation rejects invalid JWT");

  const countAfter = await countBooking(customer.id, provider.id);

  ok(countAfter === countBefore, "Invalid JWT creates no booking");

  const customerAfter = await snapshotUser(customer.id);

  const providerAfter = await snapshotVendor(provider.id);

  ok(sameState(customerBefore, customerAfter), "Customer unchanged after invalid JWT");

  ok(sameState(providerBefore, providerAfter), "Provider unchanged after invalid JWT");
}

// ============================================================
// 9. NONEXISTENT PROVIDER
// ============================================================

async function testNonexistentProvider() {
  section("NONEXISTENT PROVIDER");

  const customer = await signupAndLoginUser("CREATION MISSING PROVIDER CUSTOMER");

  const fakeProviderId = new mongoose.Types.ObjectId().toString();

  const customerBefore = await snapshotUser(customer.id);

  const countBefore = await Bookings.countDocuments({
    userId: customer.id,
    vendorId: fakeProviderId,
  });

  const response = await postUserBooking(
    customer.token,
    bookingBody(customer.id, fakeProviderId, 60),
  );

  /*
   * Depending on your ApiError mapping, nonexistent provider
   * may be 400 or 404.
   */

  expectStatus(response, [400, 404], "Nonexistent provider is rejected");

  const countAfter = await Bookings.countDocuments({
    userId: customer.id,
    vendorId: fakeProviderId,
  });

  ok(countAfter === countBefore, "No booking created for nonexistent provider");

  const customerAfter = await snapshotUser(customer.id);

  ok(
    sameState(customerBefore, customerAfter),
    "Customer accounting unchanged when provider does not exist",
    {
      before: customerBefore,
      after: customerAfter,
    },
  );
}

// ============================================================
// 10. USER ID MUST BE VALID
// ============================================================

async function testMalformedCustomerIdCannotBypassAuthorization() {
  section("MALFORMED CUSTOMER ID");

  const attacker = await signupAndLoginUser("CREATION MALFORMED ID USER");

  const provider = await signupAndLoginVendor("CREATION MALFORMED ID PROVIDER");

  const attackerBefore = await snapshotUser(attacker.id);

  const providerBefore = await snapshotVendor(provider.id);

  const response = await postUserBooking(attacker.token, {
    ...bookingBody(attacker.id, provider.id, 65),

    userId: "not-a-valid-object-id",
  });

  expectStatus(response, [400, 422], "Malformed customer ID is rejected");

  const attackerAfter = await snapshotUser(attacker.id);

  const providerAfter = await snapshotVendor(provider.id);

  ok(
    sameState(attackerBefore, attackerAfter),
    "Malformed identity request leaves customer unchanged",
  );

  ok(
    sameState(providerBefore, providerAfter),
    "Malformed identity request leaves provider unchanged",
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

  const accountIds = [...createdUsers, ...createdVendors];

  if (accountIds.length) {
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

    bookingsDeleted = result.deletedCount || 0;
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
  section("FINAL CREATION SECURITY TEST SUMMARY");

  console.log(`Assertions: ${assertions}`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);

  if (crashed) {
    console.log("\nTEST SUITE CRASHED BEFORE COMPLETION.");

    return;
  }

  if (failed === 0 && assertions > 0) {
    section("PASS: BOOKING CREATION AUTHORIZATION TESTS PASSED");

    console.log(`
Verified:

✓ User can create booking as authenticated self

✓ Vendor can create booking while acting as customer

✓ User cannot create booking using another User's ID

✓ Vendor cannot create booking using another Vendor's ID

✓ Identity mismatch is rejected rather than silently rewritten

✓ User JWT cannot use Vendor creation route

✓ Vendor JWT cannot use User creation route

✓ Missing JWT cannot create booking

✓ Invalid JWT cannot create booking

✓ Nonexistent provider cannot create booking

✓ Malformed customer identity is rejected

✓ Rejected creation does not mutate customer accounting

✓ Rejected creation does not mutate provider accounting

✓ Legitimate User booking increments pending

✓ Legitimate Vendor-as-customer booking increments pending

✓ Vendor-as-customer does NOT use pendingVendor as customer

✓ Service provider increments pendingVendor

✓ JWT identity is authoritative
`);

    return;
  }

  section(`FAIL: ${failed} BOOKING CREATION SECURITY TEST(S) FAILED`);

  console.log(`
IMPORTANT:

A failure here may indicate a booking creation
authorization / IDOR / BOLA vulnerability.

Especially dangerous:

JWT(User A)
+
body.userId = User B

must NEVER create a booking for User B.

Likewise:

JWT(Vendor A)
+
body.userId = Vendor B

must NEVER create a booking for Vendor B.

Rejected creation must leave:

- Bookings
- pending
- pendingVendor
- balance
- earning
- transactionCount

unchanged.

Do NOT weaken the test to accept unauthorized HTTP 201.
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
  section("BOOKING CREATION AUTHORIZATION / IDOR E2E SECURITY TEST");

  console.log({
    api: API_BASE,
    nodeEnv: process.env.NODE_ENV,
  });

  assertSafeEnvironment();

  await connectMongo();

  await testLegitimateUserCreation();

  await testUserCannotCreateAsAnotherUser();

  await testLegitimateVendorCustomerCreation();

  await testVendorCannotCreateAsAnotherVendor();

  await testUserCannotUseVendorCreationRoute();

  await testVendorCannotUseUserCreationRoute();

  await testMissingJwt();

  await testInvalidJwt();

  await testNonexistentProvider();

  await testMalformedCustomerIdCannotBypassAuthorization();
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

    if (crashed || failed > 0 || assertions === 0) {
      process.exitCode = 1;
    }
  }
})();
