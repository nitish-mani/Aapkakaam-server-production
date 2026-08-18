"use strict";

/**
 * ============================================================
 * PROFILE MUTATION AUTHORIZATION / IDOR / BOLA E2E TEST
 * ============================================================
 *
 * PURPOSE
 * -------
 * Verify that authenticated Users and Vendors cannot mutate
 * another account's profile by injecting/changing IDs.
 *
 * SECURITY RULE
 * -------------
 *
 * JWT identity is authoritative.
 *
 * User A JWT + body.userId = User B
 *   => MUST NOT modify User B.
 *
 * Vendor A JWT + body.vendorId = Vendor B
 *   => MUST NOT modify Vendor B.
 *
 * User A JWT + /uploads/user/User-B-ID
 *   => MUST NOT obtain authorization for User B.
 *
 * Vendor A JWT + /getUploads/vendor/Vendor-B-ID
 *   => MUST NOT modify Vendor B imgURL.
 *
 * IMPORTANT
 * ---------
 * Rejected requests MUST leave victim database state unchanged.
 *
 * This suite intentionally excludes:
 *
 * - password reset
 * - email OTP verification
 * - phone OTP verification
 *
 * Those flows require a separate OTP/account-recovery security
 * suite.
 *
 * SAFETY
 * ------
 * MUST NOT run in production.
 *
 * Run:
 *
 * NODE_ENV=development ALLOW_AUTHORIZATION_TEST=1 \
 * node tests/profile-mutation-authorization-e2e-test.js
 * ============================================================
 */

const mongoose = require("mongoose");

const ENV = require("../src/config/env");

const User = require("../models/user");
const Vendor = require("../models/vendor");

/*
 * ============================================================
 * CONFIG
 * ============================================================
 */

const API =
  process.env.PROFILE_AUTH_TEST_API || process.env.API_BASE_URL || "http://localhost:3000/api";

const DEFAULT_PASSWORD = "Test@123456";

let sequence = 0;

const createdUsers = [];
const createdVendors = [];

let assertions = 0;
let passed = 0;
let failed = 0;
let suiteCrashed = false;

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

function safeString(value) {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "string") return value;

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function assert(condition, message, details = undefined) {
  assertions += 1;

  if (condition) {
    passed += 1;
    console.log(`✓ ${message}`);
    return true;
  }

  failed += 1;
  console.log(`✗ ${message}`);

  if (details !== undefined) {
    console.dir(details, { depth: null });
  }

  return false;
}

function assertStatus(response, expected, message) {
  const accepted = Array.isArray(expected) ? expected : [expected];

  return assert(
    accepted.includes(response.status),
    `${message} [HTTP ${response.status}]`,
    response.data,
  );
}

function assertRejected(response, message) {
  return assert(
    response.status === 401 || response.status === 403,
    `${message} [HTTP ${response.status}]`,
    response.data,
  );
}

function assertNot500(response, message) {
  return assert(response.status !== 500, `${message} [HTTP ${response.status}]`, response.data);
}

function nextPhone() {
  sequence += 1;

  const suffix = (Date.now() % 1000000) + sequence * 173;

  return Number(`86${String(suffix % 100000000).padStart(8, "0")}`);
}

function nextEmail(label) {
  sequence += 1;

  const normalized = String(label)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.+|\.+$/g, "")
    .slice(0, 30);

  return `profile.auth.${normalized}.${Date.now()}.${sequence}@example.com`;
}

function extractToken(response) {
  return (
    response?.data?.token ||
    response?.data?.data?.token ||
    response?.data?.accessToken ||
    response?.data?.data?.accessToken ||
    null
  );
}

function extractId(response, type) {
  const data = response?.data;

  const candidates =
    type === "user"
      ? [
          data?.userId,
          data?.data?.userId,
          data?.user?._id,
          data?.data?.user?._id,
          data?._id,
          data?.data?._id,
          data?.id,
          data?.data?.id,
        ]
      : [
          data?.vendorId,
          data?.data?.vendorId,
          data?.vendor?._id,
          data?.data?.vendor?._id,
          data?._id,
          data?.data?._id,
          data?.id,
          data?.data?.id,
        ];

  for (const candidate of candidates) {
    if (candidate) {
      return String(candidate);
    }
  }

  return null;
}

/*
 * ============================================================
 * HTTP
 * ============================================================
 */

async function requestJson(method, path, options = {}) {
  const { token = null, body = undefined, headers = {} } = options;

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

  let response;

  try {
    response = await fetch(`${API}${path}`, {
      method: method.toUpperCase(),
      headers: requestHeaders,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new Error(
      [`HTTP request failed: ${method.toUpperCase()} ${path}`, err.message].join("\n"),
    );
  }

  const raw = await response.text();

  let data = null;

  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = raw;
    }
  }

  return {
    status: response.status,
    data,
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
    throw new Error(
      "REFUSING TO RUN: profile authorization test must not run with NODE_ENV=production.",
    );
  }

  if (process.env.ALLOW_AUTHORIZATION_TEST !== "1") {
    throw new Error("REFUSING TO RUN: set ALLOW_AUTHORIZATION_TEST=1 explicitly.");
  }
}

/*
 * ============================================================
 * DATABASE
 * ============================================================
 */

async function connectMongo() {
  const uri =
    ENV.MONGODB_URL_1 ||
    ENV.MONGODB_URI ||
    ENV.DB_URI ||
    process.env.MONGODB_URL_1 ||
    process.env.MONGODB_URI ||
    process.env.DB_URI;

  if (!uri) {
    throw new Error("MongoDB URI is missing.");
  }

  await mongoose.connect(uri);

  console.log("MongoDB connected.");
}

/*
 * ============================================================
 * AUTH ACCOUNT CREATION
 * ============================================================
 */

async function signupAndLoginUser(label) {
  const phoneNo = nextPhone();
  const email = nextEmail(label);

  const signupBody = {
    name: label,
    phoneNo,
    email,
    password: DEFAULT_PASSWORD,
    fcmToken: "",
    agreedToTnCnP: true,
  };

  const signup = await requestJson("POST", "/user/signup", {
    body: signupBody,
  });

  if (!(signup.status >= 200 && signup.status < 300)) {
    throw new Error(
      [
        "User signup failed.",
        `Label: ${label}`,
        `Status: ${signup.status}`,
        `Response: ${safeString(signup.data)}`,
      ].join("\n"),
    );
  }

  let userId = extractId(signup, "user");

  if (!userId) {
    const user = await User.findOne({
      phoneNo,
    })
      .select("_id")
      .lean();

    userId = user ? String(user._id) : null;
  }

  if (!userId) {
    throw new Error(`Unable to determine User ID for ${label}`);
  }

  const login = await requestJson("POST", "/user/login", {
    body: {
      phoneNo,
      password: DEFAULT_PASSWORD,
    },
  });

  if (!(login.status >= 200 && login.status < 300)) {
    throw new Error(
      ["User login failed.", `Status: ${login.status}`, `Response: ${safeString(login.data)}`].join(
        "\n",
      ),
    );
  }

  const token = extractToken(login);

  if (!token) {
    throw new Error(`User login did not return JWT for ${label}`);
  }

  createdUsers.push(userId);

  return {
    kind: "user",
    id: userId,
    phoneNo,
    email,
    token,
  };
}

async function signupAndLoginVendor(label) {
  const phoneNo = nextPhone();
  const email = nextEmail(label);

  const signupBody = {
    name: label,
    phoneNo,
    email,
    password: DEFAULT_PASSWORD,
    type: "four wheeler",
    experience: 1,
    gender: "male",
    fcmToken: "",
    agreedToTnCnP: true,
  };

  const signup = await requestJson("POST", "/vendor/signup", {
    body: signupBody,
  });

  if (!(signup.status >= 200 && signup.status < 300)) {
    throw new Error(
      [
        "Vendor signup failed.",
        `Label: ${label}`,
        `Status: ${signup.status}`,
        `Response: ${safeString(signup.data)}`,
      ].join("\n"),
    );
  }

  let vendorId = extractId(signup, "vendor");

  if (!vendorId) {
    const vendor = await Vendor.findOne({
      phoneNo,
    })
      .select("_id")
      .lean();

    vendorId = vendor ? String(vendor._id) : null;
  }

  if (!vendorId) {
    throw new Error(`Unable to determine Vendor ID for ${label}`);
  }

  const login = await requestJson("POST", "/vendor/login", {
    body: {
      phoneNo,
      password: DEFAULT_PASSWORD,
    },
  });

  if (!(login.status >= 200 && login.status < 300)) {
    throw new Error(
      [
        "Vendor login failed.",
        `Status: ${login.status}`,
        `Response: ${safeString(login.data)}`,
      ].join("\n"),
    );
  }

  const token = extractToken(login);

  if (!token) {
    throw new Error(`Vendor login did not return JWT for ${label}`);
  }

  createdVendors.push(vendorId);

  return {
    kind: "vendor",
    id: vendorId,
    phoneNo,
    email,
    token,
  };
}

/*
 * ============================================================
 * PROFILE SNAPSHOTS
 * ============================================================
 */

function normalizeAddress(address) {
  if (!Array.isArray(address)) {
    return [];
  }

  return JSON.parse(JSON.stringify(address));
}

async function snapshotUser(userId) {
  const user = await User.findById(userId)
    .select("name email phoneNo fcmToken address pincode imgURL")
    .lean();

  if (!user) {
    throw new Error(`User not found during snapshot: ${userId}`);
  }

  return {
    id: String(user._id),
    name: user.name ?? null,
    email: user.email ?? null,
    phoneNo: user.phoneNo === undefined ? null : Number(user.phoneNo),
    fcmToken: user.fcmToken ?? null,
    address: normalizeAddress(user.address),
    pincode: user.pincode ?? null,
    imgURL: user.imgURL ?? null,
  };
}

async function snapshotVendor(vendorId) {
  const vendor = await Vendor.findById(vendorId)
    .select(
      [
        "name",
        "email",
        "phoneNo",
        "fcmToken",
        "address",
        "pincode",
        "imgURL",
        "wageRate",
        "wageRateType",
      ].join(" "),
    )
    .lean();

  if (!vendor) {
    throw new Error(`Vendor not found during snapshot: ${vendorId}`);
  }

  return {
    id: String(vendor._id),
    name: vendor.name ?? null,
    email: vendor.email ?? null,
    phoneNo: vendor.phoneNo === undefined ? null : Number(vendor.phoneNo),
    fcmToken: vendor.fcmToken ?? null,
    address: normalizeAddress(vendor.address),
    pincode: vendor.pincode ?? null,
    imgURL: vendor.imgURL ?? null,
    wageRate: Number(vendor.wageRate || 0),
    wageRateType: vendor.wageRateType ?? null,
  };
}

function same(valueA, valueB) {
  return JSON.stringify(valueA) === JSON.stringify(valueB);
}

/*
 * ============================================================
 * USER LEGITIMATE MUTATIONS
 * ============================================================
 */

async function testUserLegitimateMutations(user) {
  section("USER PROFILE - LEGITIMATE SELF MUTATIONS");

  const newName = `PROFILE USER SELF ${Date.now()}`;

  const nameResponse = await requestJson("PATCH", "/user/edit/name", {
    token: user.token,
    body: {
      userId: user.id,
      name: newName,
    },
  });

  assertStatus(nameResponse, 200, "User can update own name");

  let snapshot = await snapshotUser(user.id);

  assert(snapshot.name === newName, "User own name mutation persisted", snapshot);

  const fcmToken = `profile-user-fcm-${Date.now()}`;

  const fcmResponse = await requestJson("PATCH", "/user/edit/fcmToken", {
    token: user.token,
    body: {
      userId: user.id,
      fcmToken,
    },
  });

  assertStatus(fcmResponse, 200, "User can update own FCM token");

  snapshot = await snapshotUser(user.id);

  assert(snapshot.fcmToken === fcmToken, "User own FCM mutation persisted", snapshot);

  const address = {
    vill: "Security Village",
    post: "Security Post",
    dist: "Deoria",
    state: "Uttar Pradesh",
    pincode: "274001",
  };

  const addressResponse = await requestJson("PATCH", "/user/update/address", {
    token: user.token,
    body: {
      userId: user.id,
      ...address,
    },
  });

  assertStatus(addressResponse, 200, "User can update own address");

  snapshot = await snapshotUser(user.id);

  assert(
    Array.isArray(snapshot.address) && snapshot.address.length > 0,
    "User own address mutation persisted",
    snapshot,
  );
}

/*
 * ============================================================
 * USER IDOR MUTATIONS
 * ============================================================
 */

async function testUserNameIdor(victim, attacker) {
  section("USER PROFILE IDOR - NAME");

  const before = await snapshotUser(victim.id);

  const maliciousName = `HACKED USER ${Date.now()}`;

  const response = await requestJson("PATCH", "/user/edit/name", {
    token: attacker.token,
    body: {
      userId: victim.id,
      name: maliciousName,
    },
  });

  assertRejected(response, "User cannot update another user's name");

  const after = await snapshotUser(victim.id);

  assert(after.name === before.name, "Rejected User name IDOR leaves victim name unchanged", {
    before,
    after,
  });

  assert(!same(after.name, maliciousName), "Victim name was not replaced by attacker", after);
}

async function testUserFcmIdor(victim, attacker) {
  section("USER PROFILE IDOR - FCM TOKEN");

  const before = await snapshotUser(victim.id);

  const maliciousToken = `attacker-fcm-${Date.now()}`;

  const response = await requestJson("PATCH", "/user/edit/fcmToken", {
    token: attacker.token,
    body: {
      userId: victim.id,
      fcmToken: maliciousToken,
    },
  });

  assertRejected(response, "User cannot update another user's FCM token");

  const after = await snapshotUser(victim.id);

  assert(after.fcmToken === before.fcmToken, "Rejected FCM IDOR leaves victim token unchanged", {
    before,
    after,
  });
}

async function testUserAddressIdor(victim, attacker) {
  section("USER PROFILE IDOR - ADDRESS");

  const before = await snapshotUser(victim.id);

  const response = await requestJson("PATCH", "/user/update/address", {
    token: attacker.token,
    body: {
      userId: victim.id,
      vill: "ATTACKER VILLAGE",
      post: "ATTACKER POST",
      dist: "ATTACKER DISTRICT",
      state: "ATTACKER STATE",
      pincode: "999999",
    },
  });

  assertRejected(response, "User cannot update another user's address");

  const after = await snapshotUser(victim.id);

  assert(
    same(after.address, before.address),
    "Rejected address IDOR leaves victim address unchanged",
    { before, after },
  );

  assert(
    after.pincode === before.pincode,
    "Rejected address IDOR leaves victim pincode unchanged",
    { before, after },
  );
}

/*
 * ============================================================
 * VENDOR LEGITIMATE MUTATIONS
 * ============================================================
 */

async function testVendorLegitimateMutations(vendor) {
  section("VENDOR PROFILE - LEGITIMATE SELF MUTATIONS");

  const newName = `PROFILE VENDOR SELF ${Date.now()}`;

  let response = await requestJson("PATCH", "/vendor/edit/name", {
    token: vendor.token,
    body: {
      name: newName,
      vendorId: vendor.id,
    },
  });

  assertStatus(response, 200, "Vendor can update own name");

  let snapshot = await snapshotVendor(vendor.id);

  assert(snapshot.name === newName, "Vendor own name mutation persisted", snapshot);

  const fcmToken = `profile-vendor-fcm-${Date.now()}`;

  response = await requestJson("PATCH", "/vendor/edit/fcmToken", {
    token: vendor.token,
    body: {
      fcmToken,
      vendorId: vendor.id,
    },
  });

  assertStatus(response, 200, "Vendor can update own FCM token");

  snapshot = await snapshotVendor(vendor.id);

  assert(snapshot.fcmToken === fcmToken, "Vendor own FCM mutation persisted", snapshot);

  response = await requestJson("PATCH", "/vendor/update/address", {
    token: vendor.token,
    body: {
      vendorId: vendor.id,
      vill: "Vendor Security Village",
      post: "Vendor Security Post",
      dist: "Deoria",
      state: "Uttar Pradesh",
      pincode: "274001",
    },
  });

  assertStatus(response, 200, "Vendor can update own address");

  snapshot = await snapshotVendor(vendor.id);

  assert(
    Array.isArray(snapshot.address) && snapshot.address.length > 0,
    "Vendor own address mutation persisted",
    snapshot,
  );

  response = await requestJson("PATCH", "/vendor/wageRate", {
    token: vendor.token,
    body: {
      vendorId: vendor.id,
      wageRate: 777,
      wageRateType: "daily",
    },
  });

  assertStatus(response, 200, "Vendor can update own wage rate");

  snapshot = await snapshotVendor(vendor.id);

  assert(snapshot.wageRate === 777, "Vendor own wage rate mutation persisted", snapshot);
}

/*
 * ============================================================
 * VENDOR BODY-ID INJECTION
 * ============================================================
 */

async function testVendorBodyIdInjection(victim, attacker) {
  section("VENDOR PROFILE - BODY ID INJECTION");

  let before = await snapshotVendor(victim.id);

  const attackerName = `VENDOR BODY ID ATTACK ${Date.now()}`;

  let response = await requestJson("PATCH", "/vendor/edit/name", {
    token: attacker.token,
    body: {
      vendorId: victim.id,
      name: attackerName,
    },
  });

  /*
   * The route may legitimately return HTTP 200 because the
   * controller ignores body.vendorId and updates req.auth.id.
   *
   * The security invariant is:
   *
   *     victim MUST remain unchanged.
   */

  assertNot500(response, "Vendor body-ID injection does not cause server error");

  let after = await snapshotVendor(victim.id);

  assert(after.name === before.name, "body.vendorId cannot redirect Vendor name mutation", {
    before,
    after,
  });

  before = await snapshotVendor(victim.id);

  response = await requestJson("PATCH", "/vendor/edit/fcmToken", {
    token: attacker.token,
    body: {
      vendorId: victim.id,
      fcmToken: `victim-fcm-attack-${Date.now()}`,
    },
  });

  assertNot500(response, "Vendor FCM body-ID injection does not cause server error");

  after = await snapshotVendor(victim.id);

  assert(after.fcmToken === before.fcmToken, "body.vendorId cannot redirect Vendor FCM mutation", {
    before,
    after,
  });

  before = await snapshotVendor(victim.id);

  response = await requestJson("PATCH", "/vendor/update/address", {
    token: attacker.token,
    body: {
      vendorId: victim.id,
      vill: "VICTIM ATTACK",
      post: "VICTIM ATTACK",
      dist: "VICTIM ATTACK",
      state: "VICTIM ATTACK",
      pincode: "999999",
    },
  });

  assertNot500(response, "Vendor address body-ID injection does not cause server error");

  after = await snapshotVendor(victim.id);

  assert(
    same(after.address, before.address),
    "body.vendorId cannot redirect Vendor address mutation",
    { before, after },
  );

  before = await snapshotVendor(victim.id);

  response = await requestJson("PATCH", "/vendor/wageRate", {
    token: attacker.token,
    body: {
      vendorId: victim.id,
      wageRate: 99999,
      wageRateType: "hourly",
    },
  });

  assertNot500(response, "Vendor wage-rate body-ID injection does not cause server error");

  after = await snapshotVendor(victim.id);

  assert(
    after.wageRate === before.wageRate && after.wageRateType === before.wageRateType,
    "body.vendorId cannot redirect Vendor wage-rate mutation",
    { before, after },
  );
}

/*
 * ============================================================
 * CROSS ROLE
 * ============================================================
 */

async function testCrossRole(user, vendor) {
  section("PROFILE MUTATIONS - CROSS ROLE");

  let before = await snapshotUser(user.id);

  let response = await requestJson("PATCH", "/user/edit/name", {
    token: vendor.token,
    body: {
      userId: user.id,
      name: "CROSS ROLE ATTACK",
    },
  });

  assertRejected(response, "Vendor JWT cannot use User profile mutation route");

  let after = await snapshotUser(user.id);

  assert(after.name === before.name, "Cross-role Vendor request leaves User unchanged", {
    before,
    after,
  });

  before = await snapshotVendor(vendor.id);

  response = await requestJson("PATCH", "/vendor/edit/name", {
    token: user.token,
    body: {
      vendorId: vendor.id,
      name: "CROSS ROLE ATTACK",
    },
  });

  assertRejected(response, "User JWT cannot use Vendor profile mutation route");

  after = await snapshotVendor(vendor.id);

  assert(after.name === before.name, "Cross-role User request leaves Vendor unchanged", {
    before,
    after,
  });
}

/*
 * ============================================================
 * MISSING / INVALID JWT
 * ============================================================
 */

async function testAuthenticationRequired(user, vendor) {
  section("PROFILE MUTATIONS - MISSING / INVALID JWT");

  let before = await snapshotUser(user.id);

  let response = await requestJson("PATCH", "/user/edit/name", {
    body: {
      userId: user.id,
      name: "NO JWT ATTACK",
    },
  });

  assertStatus(response, 401, "User mutation rejects missing JWT");

  let after = await snapshotUser(user.id);

  assert(after.name === before.name, "Missing JWT leaves User unchanged", { before, after });

  response = await requestJson("PATCH", "/user/edit/name", {
    token: "definitely.invalid.jwt",
    body: {
      userId: user.id,
      name: "INVALID JWT ATTACK",
    },
  });

  assertStatus(response, 401, "User mutation rejects invalid JWT");

  after = await snapshotUser(user.id);

  assert(after.name === before.name, "Invalid JWT leaves User unchanged", { before, after });

  before = await snapshotVendor(vendor.id);

  response = await requestJson("PATCH", "/vendor/edit/name", {
    body: {
      name: "NO JWT VENDOR ATTACK",
    },
  });

  assertStatus(response, 401, "Vendor mutation rejects missing JWT");

  after = await snapshotVendor(vendor.id);

  assert(after.name === before.name, "Missing JWT leaves Vendor unchanged", { before, after });

  response = await requestJson("PATCH", "/vendor/edit/name", {
    token: "definitely.invalid.jwt",
    body: {
      name: "INVALID JWT VENDOR ATTACK",
    },
  });

  assertStatus(response, 401, "Vendor mutation rejects invalid JWT");

  after = await snapshotVendor(vendor.id);

  assert(after.name === before.name, "Invalid JWT leaves Vendor unchanged", { before, after });
}

/*
 * ============================================================
 * UPLOAD AUTHORIZATION
 * ============================================================
 */

async function testUserUploadAuthorization(victim, attacker, vendor) {
  section("USER UPLOAD AUTHORIZATION / IDOR");

  let response = await requestJson("PUT", `/user/uploads/user/${attacker.id}`, {
    token: attacker.token,
    body: {},
  });

  assert(
    response.status >= 200 && response.status < 300,
    `User can request own upload authorization [HTTP ${response.status}]`,
    response.data,
  );

  response = await requestJson("PUT", `/user/uploads/user/${victim.id}`, {
    token: attacker.token,
    body: {},
  });

  assertRejected(response, "User cannot request upload authorization for another User");

  response = await requestJson("PUT", `/user/uploads/vendor/${vendor.id}`, {
    token: attacker.token,
    body: {},
  });

  assertRejected(response, "User cannot request Vendor-category upload authorization");
}

async function testVendorUploadAuthorization(victim, attacker, user) {
  section("VENDOR UPLOAD AUTHORIZATION / IDOR");

  let response = await requestJson("PUT", `/vendor/uploads/vendor/${attacker.id}`, {
    token: attacker.token,
    body: {},
  });

  assert(
    response.status >= 200 && response.status < 300,
    `Vendor can request own upload authorization [HTTP ${response.status}]`,
    response.data,
  );

  response = await requestJson("PUT", `/vendor/uploads/vendor/${victim.id}`, {
    token: attacker.token,
    body: {},
  });

  assertRejected(response, "Vendor cannot request upload authorization for another Vendor");

  response = await requestJson("PUT", `/vendor/uploads/user/${user.id}`, {
    token: attacker.token,
    body: {},
  });

  assertRejected(response, "Vendor cannot request User-category upload authorization");
}

/*
 * ============================================================
 * getUploads / imgURL MUTATION AUTHORIZATION
 * ============================================================
 */

async function testUserImageCommitAuthorization(victim, attacker, vendor) {
  section("USER IMAGE COMMIT / getUploads AUTHORIZATION");

  /*
   * IMPORTANT:
   *
   * This test does NOT upload to S3.
   *
   * It sends only a synthetic URL to the backend and verifies
   * which MongoDB account, if any, is modified.
   */

  const ownUrl = `https://example.com/security/user-own-${Date.now()}.jpg`;

  let response = await requestJson("GET", `/user/getUploads/user/${attacker.id}`, {
    token: attacker.token,
    headers: {
      /*
       * Some implementations take URL from query/body.
       * If your controller uses a different transport this
       * legitimate assertion may reveal that contract.
       */
    },
  });

  /*
   * Do not require success here because existing getUploads
   * implementations vary in how they receive the image URL.
   *
   * Authorization attacks below remain authoritative.
   */

  assertNot500(response, "Own User getUploads request does not crash server");

  const victimBefore = await snapshotUser(victim.id);

  response = await requestJson(
    "GET",
    `/user/getUploads/user/${victim.id}?url=${encodeURIComponent(ownUrl)}`,
    {
      token: attacker.token,
    },
  );

  assertRejected(response, "User cannot commit imgURL to another User");

  const victimAfter = await snapshotUser(victim.id);

  assert(
    victimAfter.imgURL === victimBefore.imgURL,
    "Rejected User imgURL IDOR leaves victim unchanged",
    {
      before: victimBefore,
      after: victimAfter,
    },
  );

  const vendorBefore = await snapshotVendor(vendor.id);

  response = await requestJson(
    "GET",
    `/user/getUploads/vendor/${vendor.id}?url=${encodeURIComponent(ownUrl)}`,
    {
      token: attacker.token,
    },
  );

  assertRejected(response, "User cannot commit imgURL to Vendor account");

  const vendorAfter = await snapshotVendor(vendor.id);

  assert(
    vendorAfter.imgURL === vendorBefore.imgURL,
    "Cross-category User imgURL attack leaves Vendor unchanged",
    {
      before: vendorBefore,
      after: vendorAfter,
    },
  );
}

async function testVendorImageCommitAuthorization(victim, attacker, user) {
  section("VENDOR IMAGE COMMIT / getUploads AUTHORIZATION");

  const syntheticUrl = `https://example.com/security/vendor-${Date.now()}.jpg`;

  const victimBefore = await snapshotVendor(victim.id);

  let response = await requestJson(
    "GET",
    `/vendor/getUploads/vendor/${victim.id}?url=${encodeURIComponent(syntheticUrl)}`,
    {
      token: attacker.token,
    },
  );

  assertRejected(response, "Vendor cannot commit imgURL to another Vendor");

  const victimAfter = await snapshotVendor(victim.id);

  assert(
    victimAfter.imgURL === victimBefore.imgURL,
    "Rejected Vendor imgURL IDOR leaves victim unchanged",
    {
      before: victimBefore,
      after: victimAfter,
    },
  );

  const userBefore = await snapshotUser(user.id);

  response = await requestJson(
    "GET",
    `/vendor/getUploads/user/${user.id}?url=${encodeURIComponent(syntheticUrl)}`,
    {
      token: attacker.token,
    },
  );

  assertRejected(response, "Vendor cannot commit imgURL to User account");

  const userAfter = await snapshotUser(user.id);

  assert(
    userAfter.imgURL === userBefore.imgURL,
    "Cross-category Vendor imgURL attack leaves User unchanged",
    {
      before: userBefore,
      after: userAfter,
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

  let usersDeleted = 0;
  let vendorsDeleted = 0;

  if (createdUsers.length > 0) {
    const result = await User.deleteMany({
      _id: {
        $in: createdUsers,
      },
    });

    usersDeleted = result.deletedCount || 0;
  }

  if (createdVendors.length > 0) {
    const result = await Vendor.deleteMany({
      _id: {
        $in: createdVendors,
      },
    });

    vendorsDeleted = result.deletedCount || 0;
  }

  console.log({
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
  section("FINAL PROFILE MUTATION AUTHORIZATION SECURITY TEST SUMMARY");

  console.log(`Assertions: ${assertions}`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);

  if (suiteCrashed) {
    console.log("\nTEST SUITE CRASHED BEFORE COMPLETION.");
    return;
  }

  if (failed === 0 && assertions > 0) {
    section("PASS: PROFILE MUTATION AUTHORIZATION SECURITY TESTS PASSED");

    console.log(`
Verified:

✓ Legitimate User profile mutations work
✓ Legitimate Vendor profile mutations work

✓ User cannot mutate another User's profile
✓ User cannot replace another User's FCM token
✓ User cannot replace another User's address

✓ Vendor body-ID injection cannot redirect mutations
✓ Vendor JWT identity remains authoritative

✓ User JWT cannot access Vendor mutation routes
✓ Vendor JWT cannot access User mutation routes

✓ Missing JWT is rejected
✓ Invalid JWT is rejected

✓ User cannot obtain upload authorization for another User
✓ Vendor cannot obtain upload authorization for another Vendor

✓ User cannot target Vendor upload category
✓ Vendor cannot target User upload category

✓ User cannot mutate another User's imgURL
✓ Vendor cannot mutate another Vendor's imgURL

✓ Cross-category imgURL attacks are rejected

✓ Rejected attacks leave victim database state unchanged

✓ JWT identity is authoritative
`);
  } else {
    section(`FAIL: ${failed} PROFILE MUTATION AUTHORIZATION SECURITY TEST(S) FAILED`);

    console.log(`
IMPORTANT:

A failed assertion may indicate an IDOR /
Broken Object Level Authorization vulnerability.

Critical examples:


1. USER PROFILE IDOR

User A JWT
+
body.userId = User B
+
PATCH /user/edit/name

must NEVER modify User B.


2. FCM TOKEN TAKEOVER

User A JWT
+
body.userId = User B
+
PATCH /user/edit/fcmToken

must NEVER replace User B's FCM token.


3. ADDRESS IDOR

User A JWT
+
body.userId = User B
+
PATCH /user/update/address

must NEVER modify User B's address.


4. UPLOAD IDOR

User A JWT
+
/user/uploads/user/User-B-ID

must NEVER authorize an upload for User B.


5. IMAGE URL IDOR

Vendor A JWT
+
/vendor/getUploads/vendor/Vendor-B-ID

must NEVER modify Vendor B's imgURL.


The authoritative identity must be:

    req.auth.id

NOT:

    req.body.userId
    req.body.vendorId
    req.params.id


The authenticated role must also determine the account
category. A client-controlled "category" must not allow:

    User JWT   -> Vendor mutation
    Vendor JWT -> User mutation


DO NOT weaken this test to accept unauthorized HTTP 200.

Fix the authorization boundary in the application.
`);
  }
}

/*
 * ============================================================
 * MAIN
 * ============================================================
 */

async function main() {
  assertSafeEnvironment();

  section("PROFILE MUTATION AUTHORIZATION / IDOR E2E SECURITY TEST");

  console.log({
    api: API,
    nodeEnv: process.env.NODE_ENV,
  });

  await connectMongo();

  /*
   * Reuse only four accounts.
   *
   * Keeps auth traffic low while still establishing separate
   * victim/attacker identities for both roles.
   */

  const userVictim = await signupAndLoginUser("PROFILE SECURITY USER VICTIM");

  const userAttacker = await signupAndLoginUser("PROFILE SECURITY USER ATTACKER");

  const vendorVictim = await signupAndLoginVendor("PROFILE SECURITY VENDOR VICTIM");

  const vendorAttacker = await signupAndLoginVendor("PROFILE SECURITY VENDOR ATTACKER");

  /*
   * Legitimate behavior first.
   */

  await testUserLegitimateMutations(userVictim);

  await testVendorLegitimateMutations(vendorVictim);

  /*
   * User BOLA attacks.
   */

  await testUserNameIdor(userVictim, userAttacker);

  await testUserFcmIdor(userVictim, userAttacker);

  await testUserAddressIdor(userVictim, userAttacker);

  /*
   * Vendor body-ID injection.
   */

  await testVendorBodyIdInjection(vendorVictim, vendorAttacker);

  /*
   * Role boundary.
   */

  await testCrossRole(userVictim, vendorVictim);

  /*
   * Authentication boundary.
   */

  await testAuthenticationRequired(userVictim, vendorVictim);

  /*
   * Upload authorization.
   */

  await testUserUploadAuthorization(userVictim, userAttacker, vendorVictim);

  await testVendorUploadAuthorization(vendorVictim, vendorAttacker, userVictim);

  /*
   * imgURL / getUploads authorization.
   */

  await testUserImageCommitAuthorization(userVictim, userAttacker, vendorVictim);

  await testVendorImageCommitAuthorization(vendorVictim, vendorAttacker, userVictim);
}

/*
 * ============================================================
 * EXECUTION
 * ============================================================
 */

(async () => {
  try {
    await main();
  } catch (err) {
    suiteCrashed = true;

    section("TEST CRASHED");

    console.error(err);
  } finally {
    try {
      if (mongoose.connection.readyState !== 0) {
        await cleanup();
      }
    } catch (err) {
      console.error("Cleanup failed:", err);
    }

    try {
      if (mongoose.connection.readyState !== 0) {
        await mongoose.disconnect();

        console.log("\nMongoDB disconnected.");
      }
    } catch (err) {
      console.error("MongoDB disconnect failed:", err);
    }

    printFinalReport();

    if (suiteCrashed || failed > 0 || assertions === 0) {
      process.exitCode = 1;
    } else {
      process.exitCode = 0;
    }
  }
})();
