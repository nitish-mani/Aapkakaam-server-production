"use strict";

/**
 * ============================================================
 * ACCOUNT DATA AUTHORIZATION / IDOR / BOLA E2E SECURITY TEST
 * ============================================================
 *
 * PURPOSE
 * -------
 * Verify that authenticated Users and Vendors cannot access or
 * mutate another account's private data merely by changing an
 * ID in the URL.
 *
 * SECURITY RULE
 * -------------
 *
 * JWT identity is authoritative.
 *
 * User A JWT + User B userId
 *   => MUST NOT expose/mutate User B private data.
 *
 * Vendor A JWT + Vendor B vendorId
 *   => MUST NOT expose/mutate Vendor B private data.
 *
 * PRIVATE USER SURFACE
 * --------------------
 * GET  /user/getOrders/:userId/:pageNo
 * GET  /user/getShare/:userId/:skip
 * GET  /user/getUserByUser/:userId
 * GET  /user/getEarnings/:userId
 * GET  /user/getAttendance/:userId/:month/:year
 * POST /user/postAttendance/:userId
 *
 * PRIVATE VENDOR SURFACE
 * ----------------------
 * GET  /vendor/getOrders/:vendorId/:pageNo
 * GET  /vendor/getShare/:vendorId/:skip
 * GET  /vendor/getVendorByVendor/:vendorId
 * GET  /vendor/getEarnings/:vendorId
 * GET  /vendor/getAttendance/:vendorId/:month/:year
 * POST /vendor/postAttendance/:vendorId
 *
 * IMPORTANT
 * ---------
 * This suite intentionally does NOT classify:
 *
 *   GET /vendor/getOne/:vendorId
 *
 * as a private Vendor endpoint because it appears to be an
 * authenticated marketplace-facing User -> Vendor lookup.
 *
 * Likewise, /user/getOne is not treated as a normal private
 * self-service endpoint because its current route/controller
 * contract is unusual and should be audited separately.
 *
 * SAFETY
 * ------
 * This test creates temporary accounts and attendance records.
 *
 * It MUST NOT run in production.
 *
 * Run:
 *
 * NODE_ENV=development ALLOW_AUTHORIZATION_TEST=1 \
 * node tests/account-data-authorization-e2e-test.js
 * ============================================================
 */

const mongoose = require("mongoose");

const ENV = require("../src/config/env");

const User = require("../models/user");
const Vendor = require("../models/vendor");
const Attendance = require("../models/attendance");
const Bookings = require("../models/bookings");
const Share = require("../models/share");

/*
 * ============================================================
 * CONFIG
 * ============================================================
 */

const API =
  process.env.ACCOUNT_AUTH_TEST_API || process.env.API_BASE_URL || "http://localhost:3000/api";

const DEFAULT_PASSWORD = "Test@123456";

const TEST_MONTH = new Date().getMonth() + 1;
const TEST_YEAR = new Date().getFullYear();

let sequence = 0;

/*
 * ============================================================
 * TRACK CREATED DATA
 * ============================================================
 */

const createdUsers = [];
const createdVendors = [];
const createdBookings = [];
const createdShares = [];
const createdAttendance = [];

let assertions = 0;
let passed = 0;
let failed = 0;
let suiteCrashed = false;

/*
 * ============================================================
 * BASIC HELPERS
 * ============================================================
 */

function safeString(value) {
  if (value === undefined) {
    return "undefined";
  }

  if (value === null) {
    return "null";
  }

  if (typeof value === "string") {
    return value;
  }

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
    return true;
  }

  failed += 1;

  if (details !== undefined) {
    console.dir(details, {
      depth: null,
    });
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

function assertNot500(response, message) {
  return assert(response.status !== 500, `${message} [HTTP ${response.status}]`, response.data);
}

function assertUnauthorizedResponse(response, message) {
  return assert(
    response.status === 401 || response.status === 403,
    `${message} [HTTP ${response.status}]`,
    response.data,
  );
}

function nextPhone() {
  sequence += 1;

  /*
   * Generate unique Indian-looking 10 digit numbers.
   *
   * The prefix is intentionally separated from existing
   * lifecycle/security test ranges as much as possible.
   */
  const suffix = (Date.now() % 1000000) + sequence * 137;

  return Number(`85${String(suffix % 100000000).padStart(8, "0")}`);
}

function nextEmail(label) {
  sequence += 1;

  const normalized = String(label)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.+|\.+$/g, "")
    .slice(0, 30);

  return `account.auth.${normalized}.${Date.now()}.${sequence}@example.com`;
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
    throw new Error(`HTTP request failed: ${method.toUpperCase()} ${path}\n${err.message}`);
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
      "REFUSING TO RUN: account authorization test must not run with NODE_ENV=production.",
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

  /*
   * Some auth implementations don't return the ID from signup.
   * Resolve it through the DB using the unique phone number.
   */
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
 * DATABASE SNAPSHOTS
 * ============================================================
 */

async function snapshotUser(userId) {
  const user = await User.findById(userId)
    .select(
      [
        "balance",
        "earning",
        "pending",
        "completed",
        "canceled",
        "pendingShareBy",
        "completedShareBy",
        "canceledShareBy",
        "shareCount",
        "presentDate",
      ].join(" "),
    )
    .lean();

  if (!user) {
    throw new Error(`User not found during snapshot: ${userId}`);
  }

  return {
    id: String(user._id),
    balance: Number(user.balance || 0),
    earning: Number(user.earning || 0),
    pending: Number(user.pending || 0),
    completed: Number(user.completed || 0),
    canceled: Number(user.canceled || 0),
    pendingShareBy: Number(user.pendingShareBy || 0),
    completedShareBy: Number(user.completedShareBy || 0),
    canceledShareBy: Number(user.canceledShareBy || 0),
    shareCount: Number(user.shareCount || 0),
    presentDate:
      user.presentDate === undefined || user.presentDate === null ? null : String(user.presentDate),
  };
}

async function snapshotVendor(vendorId) {
  const vendor = await Vendor.findById(vendorId)
    .select(
      [
        "balance",
        "earning",
        "pending",
        "completed",
        "canceled",
        "pendingVendor",
        "completedVendor",
        "canceledVendor",
        "pendingShareBy",
        "completedShareBy",
        "canceledShareBy",
        "shareCount",
        "presentDate",
      ].join(" "),
    )
    .lean();

  if (!vendor) {
    throw new Error(`Vendor not found during snapshot: ${vendorId}`);
  }

  return {
    id: String(vendor._id),
    balance: Number(vendor.balance || 0),
    earning: Number(vendor.earning || 0),
    pending: Number(vendor.pending || 0),
    completed: Number(vendor.completed || 0),
    canceled: Number(vendor.canceled || 0),
    pendingVendor: Number(vendor.pendingVendor || 0),
    completedVendor: Number(vendor.completedVendor || 0),
    canceledVendor: Number(vendor.canceledVendor || 0),
    pendingShareBy: Number(vendor.pendingShareBy || 0),
    completedShareBy: Number(vendor.completedShareBy || 0),
    canceledShareBy: Number(vendor.canceledShareBy || 0),
    shareCount: Number(vendor.shareCount || 0),
    presentDate:
      vendor.presentDate === undefined || vendor.presentDate === null
        ? null
        : String(vendor.presentDate),
  };
}

function sameSnapshot(before, after) {
  return JSON.stringify(before) === JSON.stringify(after);
}

async function attendanceCountForUser(userId) {
  return Attendance.countDocuments({
    userId,
  });
}

async function attendanceCountForVendor(vendorId) {
  return Attendance.countDocuments({
    vendorId,
  });
}

/*
 * ============================================================
 * SEED PRIVATE DATA
 * ============================================================
 */

async function seedUserPrivateData(user) {
  await User.updateOne(
    {
      _id: user.id,
    },
    {
      $set: {
        balance: 7311,
        earning: 913,
        pendingShareBy: 4,
        completedShareBy: 7,
        canceledShareBy: 2,
        shareCount: 13,
      },
    },
  );

  const share = await Share.create({
    userId: user.id,
    phoneNo: nextPhone(),
    status: "accepted",
    shareDate: new Date(),
  });

  createdShares.push(String(share._id));
}

async function seedVendorPrivateData(vendor) {
  await Vendor.updateOne(
    {
      _id: vendor.id,
    },
    {
      $set: {
        balance: 8642,
        earning: 1217,
        pendingShareBy: 3,
        completedShareBy: 8,
        canceledShareBy: 1,
        shareCount: 17,
      },
    },
  );

  const share = await Share.create({
    vendorId: vendor.id,
    phoneNo: nextPhone(),
    status: "accepted",
    shareDate: new Date(),
  });

  createdShares.push(String(share._id));
}

/*
 * ============================================================
 * RESPONSE LEAK HELPERS
 * ============================================================
 */

function responseContainsMarker(response, marker) {
  const serialized = safeString(response.data);

  return serialized.includes(String(marker));
}

function assertNoMarkerLeak(response, marker, message) {
  return assert(!responseContainsMarker(response, marker), message, response.data);
}

/*
 * ============================================================
 * USER PRIVATE READ TESTS
 * ============================================================
 */

async function testUserGetOrders(victim, attacker, vendorToken) {
  section("USER PRIVATE DATA - GET ORDERS");

  const own = await requestJson("GET", `/user/getOrders/${victim.id}/1`, {
    token: victim.token,
  });

  assertStatus(own, 200, "User can retrieve own orders");

  const attack = await requestJson("GET", `/user/getOrders/${victim.id}/1`, {
    token: attacker.token,
  });

  assertStatus(attack, 403, "User cannot retrieve another user's orders");

  const missing = await requestJson("GET", `/user/getOrders/${victim.id}/1`);

  assertStatus(missing, 401, "User orders reject missing JWT");

  const invalid = await requestJson("GET", `/user/getOrders/${victim.id}/1`, {
    token: "definitely.invalid.jwt",
  });

  assertStatus(invalid, 401, "User orders reject invalid JWT");

  const crossRole = await requestJson("GET", `/user/getOrders/${victim.id}/1`, {
    token: vendorToken,
  });

  assertUnauthorizedResponse(crossRole, "Vendor JWT cannot access User orders");
}

async function testUserGetShare(victim, attacker, vendorToken) {
  section("USER PRIVATE DATA - GET SHARE");

  const own = await requestJson("GET", `/user/getShare/${victim.id}/0`, {
    token: victim.token,
  });

  assertStatus(own, 200, "User can retrieve own shares");

  const attack = await requestJson("GET", `/user/getShare/${victim.id}/0`, {
    token: attacker.token,
  });

  assertStatus(attack, 403, "User cannot retrieve another user's shares");

  const missing = await requestJson("GET", `/user/getShare/${victim.id}/0`);

  assertStatus(missing, 401, "User shares reject missing JWT");

  const invalid = await requestJson("GET", `/user/getShare/${victim.id}/0`, {
    token: "invalid.jwt",
  });

  assertStatus(invalid, 401, "User shares reject invalid JWT");

  const crossRole = await requestJson("GET", `/user/getShare/${victim.id}/0`, {
    token: vendorToken,
  });

  assertUnauthorizedResponse(crossRole, "Vendor JWT cannot access User shares");
}

async function testUserGetPrivateDetails(victim, attacker, vendorToken) {
  section("USER PRIVATE DATA - GET USER DETAILS");

  const own = await requestJson("GET", `/user/getUserByUser/${victim.id}`, {
    token: victim.token,
  });

  assertStatus(own, 200, "User can retrieve own private account details");

  assert(responseContainsMarker(own, 7311), "Own private details contain seeded balance", own.data);

  const attack = await requestJson("GET", `/user/getUserByUser/${victim.id}`, {
    token: attacker.token,
  });

  assertStatus(attack, 403, "User cannot retrieve another user's private account details");

  assertNoMarkerLeak(attack, 7311, "Rejected User details IDOR does not expose victim balance");

  const missing = await requestJson("GET", `/user/getUserByUser/${victim.id}`);

  assertStatus(missing, 401, "User private details reject missing JWT");

  const invalid = await requestJson("GET", `/user/getUserByUser/${victim.id}`, {
    token: "invalid.jwt",
  });

  assertStatus(invalid, 401, "User private details reject invalid JWT");

  const crossRole = await requestJson("GET", `/user/getUserByUser/${victim.id}`, {
    token: vendorToken,
  });

  assertUnauthorizedResponse(crossRole, "Vendor JWT cannot access User private account details");

  const malformed = await requestJson("GET", "/user/getUserByUser/not-a-valid-object-id", {
    token: victim.token,
  });

  assertNot500(malformed, "Malformed User ID does not produce HTTP 500");

  assert(
    malformed.status === 400 || malformed.status === 403,
    `Malformed User ID is rejected [HTTP ${malformed.status}]`,
    malformed.data,
  );
}

async function testUserEarnings(victim, attacker, vendorToken) {
  section("USER PRIVATE DATA - GET EARNINGS");

  const own = await requestJson("GET", `/user/getEarnings/${victim.id}`, {
    token: victim.token,
  });

  assertStatus(own, 200, "User can retrieve own earnings");

  assert(
    responseContainsMarker(own, 913),
    "Own earnings response contains seeded earning",
    own.data,
  );

  const attack = await requestJson("GET", `/user/getEarnings/${victim.id}`, {
    token: attacker.token,
  });

  assertStatus(attack, 403, "User cannot retrieve another user's earnings");

  assertNoMarkerLeak(attack, 913, "Rejected User earnings IDOR does not expose victim earning");

  const missing = await requestJson("GET", `/user/getEarnings/${victim.id}`);

  assertStatus(missing, 401, "User earnings reject missing JWT");

  const invalid = await requestJson("GET", `/user/getEarnings/${victim.id}`, {
    token: "invalid.jwt",
  });

  assertStatus(invalid, 401, "User earnings reject invalid JWT");

  const crossRole = await requestJson("GET", `/user/getEarnings/${victim.id}`, {
    token: vendorToken,
  });

  assertUnauthorizedResponse(crossRole, "Vendor JWT cannot access User earnings");
}

async function testUserAttendanceRead(victim, attacker, vendorToken) {
  section("USER PRIVATE DATA - GET ATTENDANCE");

  const own = await requestJson(
    "GET",
    `/user/getAttendance/${victim.id}/${TEST_MONTH}/${TEST_YEAR}`,
    {
      token: victim.token,
    },
  );

  assertStatus(own, 200, "User can retrieve own attendance");

  const attack = await requestJson(
    "GET",
    `/user/getAttendance/${victim.id}/${TEST_MONTH}/${TEST_YEAR}`,
    {
      token: attacker.token,
    },
  );

  assertStatus(attack, 403, "User cannot retrieve another user's attendance");

  const missing = await requestJson(
    "GET",
    `/user/getAttendance/${victim.id}/${TEST_MONTH}/${TEST_YEAR}`,
  );

  assertStatus(missing, 401, "User attendance rejects missing JWT");

  const invalid = await requestJson(
    "GET",
    `/user/getAttendance/${victim.id}/${TEST_MONTH}/${TEST_YEAR}`,
    {
      token: "invalid.jwt",
    },
  );

  assertStatus(invalid, 401, "User attendance rejects invalid JWT");

  const crossRole = await requestJson(
    "GET",
    `/user/getAttendance/${victim.id}/${TEST_MONTH}/${TEST_YEAR}`,
    {
      token: vendorToken,
    },
  );

  assertUnauthorizedResponse(crossRole, "Vendor JWT cannot access User attendance");

  const malformed = await requestJson(
    "GET",
    `/user/getAttendance/not-valid/${TEST_MONTH}/${TEST_YEAR}`,
    {
      token: victim.token,
    },
  );

  assertNot500(malformed, "Malformed User attendance identity does not produce HTTP 500");
}

/*
 * ============================================================
 * USER ATTENDANCE WRITE IDOR
 * ============================================================
 */

async function testUserAttendanceWrite(victim, attacker, vendorToken) {
  section("USER PRIVATE DATA - POST ATTENDANCE / WRITE IDOR");

  /*
   * Ensure the victim has no attendance for today so a vulnerable
   * implementation cannot escape through "already marked today".
   */

  await Attendance.deleteMany({
    userId: victim.id,
  });

  await User.updateOne(
    {
      _id: victim.id,
    },
    {
      $unset: {
        presentDate: 1,
      },
    },
  );

  const beforeAccount = await snapshotUser(victim.id);
  const beforeCount = await attendanceCountForUser(victim.id);

  const attack = await requestJson("POST", `/user/postAttendance/${victim.id}`, {
    token: attacker.token,
    body: {
      attendanceData: {
        time1: 10,
        time2: 20,
        time3: 30,
      },
    },
  });

  assertStatus(attack, 403, "User cannot mark attendance for another User");

  const afterAccount = await snapshotUser(victim.id);
  const afterCount = await attendanceCountForUser(victim.id);

  assert(
    afterCount === beforeCount,
    "Unauthorized User attendance write creates no Attendance document",
    {
      beforeCount,
      afterCount,
    },
  );

  assert(
    sameSnapshot(beforeAccount, afterAccount),
    "Unauthorized User attendance write leaves victim account unchanged",
    {
      before: beforeAccount,
      after: afterAccount,
    },
  );

  const missing = await requestJson("POST", `/user/postAttendance/${victim.id}`, {
    body: {
      attendanceData: {
        time1: 10,
        time2: 20,
        time3: 30,
      },
    },
  });

  assertStatus(missing, 401, "User attendance write rejects missing JWT");

  const invalid = await requestJson("POST", `/user/postAttendance/${victim.id}`, {
    token: "invalid.jwt",
    body: {
      attendanceData: {
        time1: 10,
        time2: 20,
        time3: 30,
      },
    },
  });

  assertStatus(invalid, 401, "User attendance write rejects invalid JWT");

  const crossRole = await requestJson("POST", `/user/postAttendance/${victim.id}`, {
    token: vendorToken,
    body: {
      attendanceData: {
        time1: 10,
        time2: 20,
        time3: 30,
      },
    },
  });

  assertUnauthorizedResponse(crossRole, "Vendor JWT cannot mark User attendance");

  const finalCount = await attendanceCountForUser(victim.id);
  const finalAccount = await snapshotUser(victim.id);

  assert(
    finalCount === beforeCount,
    "All rejected User attendance attacks leave Attendance collection unchanged",
    {
      beforeCount,
      finalCount,
    },
  );

  assert(
    sameSnapshot(beforeAccount, finalAccount),
    "All rejected User attendance attacks leave victim account unchanged",
    {
      before: beforeAccount,
      after: finalAccount,
    },
  );

  /*
   * Legitimate owner request.
   */

  const legitimate = await requestJson("POST", `/user/postAttendance/${victim.id}`, {
    token: victim.token,
    body: {
      attendanceData: {
        time1: 11,
        time2: 22,
        time3: 33,
      },
    },
  });

  assertStatus(legitimate, 200, "User can mark own attendance");

  const legitimateCount = await attendanceCountForUser(victim.id);

  assert(
    legitimateCount === beforeCount + 1,
    "Legitimate User attendance creates exactly one Attendance document",
    {
      beforeCount,
      legitimateCount,
    },
  );

  const created = await Attendance.findOne({
    userId: victim.id,
  })
    .sort({
      _id: -1,
    })
    .lean();

  if (created) {
    createdAttendance.push(String(created._id));
  }

  assert(
    Number(created?.totalTime) === 66,
    "Legitimate User attendance stores expected totalTime",
    created,
  );
}

/*
 * ============================================================
 * VENDOR PRIVATE READ TESTS
 * ============================================================
 */

async function testVendorGetOrders(victim, attacker, userToken) {
  section("VENDOR PRIVATE DATA - GET ORDERS");

  const own = await requestJson("GET", `/vendor/getOrders/${victim.id}/1`, {
    token: victim.token,
  });

  assertStatus(own, 200, "Vendor can retrieve own orders");

  const attack = await requestJson("GET", `/vendor/getOrders/${victim.id}/1`, {
    token: attacker.token,
  });

  assertStatus(attack, 403, "Vendor cannot retrieve another Vendor's orders");

  const missing = await requestJson("GET", `/vendor/getOrders/${victim.id}/1`);

  assertStatus(missing, 401, "Vendor orders reject missing JWT");

  const invalid = await requestJson("GET", `/vendor/getOrders/${victim.id}/1`, {
    token: "invalid.jwt",
  });

  assertStatus(invalid, 401, "Vendor orders reject invalid JWT");

  const crossRole = await requestJson("GET", `/vendor/getOrders/${victim.id}/1`, {
    token: userToken,
  });

  assertUnauthorizedResponse(crossRole, "User JWT cannot access Vendor private orders");
}

async function testVendorGetShare(victim, attacker, userToken) {
  section("VENDOR PRIVATE DATA - GET SHARE");

  const own = await requestJson("GET", `/vendor/getShare/${victim.id}/0`, {
    token: victim.token,
  });

  assertStatus(own, 200, "Vendor can retrieve own shares");

  const attack = await requestJson("GET", `/vendor/getShare/${victim.id}/0`, {
    token: attacker.token,
  });

  assertStatus(attack, 403, "Vendor cannot retrieve another Vendor's shares");

  const missing = await requestJson("GET", `/vendor/getShare/${victim.id}/0`);

  assertStatus(missing, 401, "Vendor shares reject missing JWT");

  const invalid = await requestJson("GET", `/vendor/getShare/${victim.id}/0`, {
    token: "invalid.jwt",
  });

  assertStatus(invalid, 401, "Vendor shares reject invalid JWT");

  const crossRole = await requestJson("GET", `/vendor/getShare/${victim.id}/0`, {
    token: userToken,
  });

  assertUnauthorizedResponse(crossRole, "User JWT cannot access Vendor shares");
}

async function testVendorPrivateDetails(victim, attacker, userToken) {
  section("VENDOR PRIVATE DATA - GET VENDOR DETAILS");

  const own = await requestJson("GET", `/vendor/getVendorByVendor/${victim.id}`, {
    token: victim.token,
  });

  assertStatus(own, 200, "Vendor can retrieve own private account details");

  assert(responseContainsMarker(own, 8642), "Own Vendor details contain seeded balance", own.data);

  const attack = await requestJson("GET", `/vendor/getVendorByVendor/${victim.id}`, {
    token: attacker.token,
  });

  assertStatus(attack, 403, "Vendor cannot retrieve another Vendor's private account details");

  assertNoMarkerLeak(attack, 8642, "Rejected Vendor details IDOR does not expose victim balance");

  const missing = await requestJson("GET", `/vendor/getVendorByVendor/${victim.id}`);

  assertStatus(missing, 401, "Vendor private details reject missing JWT");

  const invalid = await requestJson("GET", `/vendor/getVendorByVendor/${victim.id}`, {
    token: "invalid.jwt",
  });

  assertStatus(invalid, 401, "Vendor private details reject invalid JWT");

  const crossRole = await requestJson("GET", `/vendor/getVendorByVendor/${victim.id}`, {
    token: userToken,
  });

  assertUnauthorizedResponse(crossRole, "User JWT cannot access Vendor private account details");

  const malformed = await requestJson("GET", "/vendor/getVendorByVendor/not-a-valid-object-id", {
    token: victim.token,
  });

  assertNot500(malformed, "Malformed Vendor ID does not produce HTTP 500");

  assert(
    malformed.status === 400 || malformed.status === 403,
    `Malformed Vendor ID is rejected [HTTP ${malformed.status}]`,
    malformed.data,
  );
}

async function testVendorEarnings(victim, attacker, userToken) {
  section("VENDOR PRIVATE DATA - GET EARNINGS");

  const own = await requestJson("GET", `/vendor/getEarnings/${victim.id}`, {
    token: victim.token,
  });

  assertStatus(own, 200, "Vendor can retrieve own earnings");

  assert(responseContainsMarker(own, 1217), "Own Vendor earnings contain seeded earning", own.data);

  const attack = await requestJson("GET", `/vendor/getEarnings/${victim.id}`, {
    token: attacker.token,
  });

  assertStatus(attack, 403, "Vendor cannot retrieve another Vendor's earnings");

  assertNoMarkerLeak(attack, 1217, "Rejected Vendor earnings IDOR does not expose victim earning");

  const missing = await requestJson("GET", `/vendor/getEarnings/${victim.id}`);

  assertStatus(missing, 401, "Vendor earnings reject missing JWT");

  const invalid = await requestJson("GET", `/vendor/getEarnings/${victim.id}`, {
    token: "invalid.jwt",
  });

  assertStatus(invalid, 401, "Vendor earnings reject invalid JWT");

  const crossRole = await requestJson("GET", `/vendor/getEarnings/${victim.id}`, {
    token: userToken,
  });

  assertUnauthorizedResponse(crossRole, "User JWT cannot access Vendor earnings");
}

async function testVendorAttendanceRead(victim, attacker, userToken) {
  section("VENDOR PRIVATE DATA - GET ATTENDANCE");

  const own = await requestJson(
    "GET",
    `/vendor/getAttendance/${victim.id}/${TEST_MONTH}/${TEST_YEAR}`,
    {
      token: victim.token,
    },
  );

  assertStatus(own, 200, "Vendor can retrieve own attendance");

  const attack = await requestJson(
    "GET",
    `/vendor/getAttendance/${victim.id}/${TEST_MONTH}/${TEST_YEAR}`,
    {
      token: attacker.token,
    },
  );

  assertStatus(attack, 403, "Vendor cannot retrieve another Vendor's attendance");

  const missing = await requestJson(
    "GET",
    `/vendor/getAttendance/${victim.id}/${TEST_MONTH}/${TEST_YEAR}`,
  );

  assertStatus(missing, 401, "Vendor attendance rejects missing JWT");

  const invalid = await requestJson(
    "GET",
    `/vendor/getAttendance/${victim.id}/${TEST_MONTH}/${TEST_YEAR}`,
    {
      token: "invalid.jwt",
    },
  );

  assertStatus(invalid, 401, "Vendor attendance rejects invalid JWT");

  const crossRole = await requestJson(
    "GET",
    `/vendor/getAttendance/${victim.id}/${TEST_MONTH}/${TEST_YEAR}`,
    {
      token: userToken,
    },
  );

  assertUnauthorizedResponse(crossRole, "User JWT cannot access Vendor attendance");

  const malformed = await requestJson(
    "GET",
    `/vendor/getAttendance/not-valid/${TEST_MONTH}/${TEST_YEAR}`,
    {
      token: victim.token,
    },
  );

  assertNot500(malformed, "Malformed Vendor attendance identity does not produce HTTP 500");
}

/*
 * ============================================================
 * VENDOR ATTENDANCE WRITE IDOR
 * ============================================================
 */

async function testVendorAttendanceWrite(victim, attacker, userToken) {
  section("VENDOR PRIVATE DATA - POST ATTENDANCE / WRITE IDOR");

  await Attendance.deleteMany({
    vendorId: victim.id,
  });

  await Vendor.updateOne(
    {
      _id: victim.id,
    },
    {
      $unset: {
        presentDate: 1,
      },
    },
  );

  const beforeAccount = await snapshotVendor(victim.id);
  const beforeCount = await attendanceCountForVendor(victim.id);

  const attack = await requestJson("POST", `/vendor/postAttendance/${victim.id}`, {
    token: attacker.token,
    body: {
      attendanceData: {
        time1: 10,
        time2: 20,
        time3: 30,
      },
    },
  });

  assertStatus(attack, 403, "Vendor cannot mark attendance for another Vendor");

  const afterAccount = await snapshotVendor(victim.id);
  const afterCount = await attendanceCountForVendor(victim.id);

  assert(
    afterCount === beforeCount,
    "Unauthorized Vendor attendance write creates no Attendance document",
    {
      beforeCount,
      afterCount,
    },
  );

  assert(
    sameSnapshot(beforeAccount, afterAccount),
    "Unauthorized Vendor attendance write leaves victim account unchanged",
    {
      before: beforeAccount,
      after: afterAccount,
    },
  );

  const missing = await requestJson("POST", `/vendor/postAttendance/${victim.id}`, {
    body: {
      attendanceData: {
        time1: 10,
        time2: 20,
        time3: 30,
      },
    },
  });

  assertStatus(missing, 401, "Vendor attendance write rejects missing JWT");

  const invalid = await requestJson("POST", `/vendor/postAttendance/${victim.id}`, {
    token: "invalid.jwt",
    body: {
      attendanceData: {
        time1: 10,
        time2: 20,
        time3: 30,
      },
    },
  });

  assertStatus(invalid, 401, "Vendor attendance write rejects invalid JWT");

  const crossRole = await requestJson("POST", `/vendor/postAttendance/${victim.id}`, {
    token: userToken,
    body: {
      attendanceData: {
        time1: 10,
        time2: 20,
        time3: 30,
      },
    },
  });

  assertUnauthorizedResponse(crossRole, "User JWT cannot mark Vendor attendance");

  const finalCount = await attendanceCountForVendor(victim.id);
  const finalAccount = await snapshotVendor(victim.id);

  assert(
    finalCount === beforeCount,
    "All rejected Vendor attendance attacks leave Attendance collection unchanged",
    {
      beforeCount,
      finalCount,
    },
  );

  assert(
    sameSnapshot(beforeAccount, finalAccount),
    "All rejected Vendor attendance attacks leave victim account unchanged",
    {
      before: beforeAccount,
      after: finalAccount,
    },
  );

  const legitimate = await requestJson("POST", `/vendor/postAttendance/${victim.id}`, {
    token: victim.token,
    body: {
      attendanceData: {
        time1: 12,
        time2: 23,
        time3: 34,
      },
    },
  });

  assertStatus(legitimate, 200, "Vendor can mark own attendance");

  const legitimateCount = await attendanceCountForVendor(victim.id);

  assert(
    legitimateCount === beforeCount + 1,
    "Legitimate Vendor attendance creates exactly one Attendance document",
    {
      beforeCount,
      legitimateCount,
    },
  );

  const created = await Attendance.findOne({
    vendorId: victim.id,
  })
    .sort({
      _id: -1,
    })
    .lean();

  if (created) {
    createdAttendance.push(String(created._id));
  }

  assert(
    Number(created?.totalTime) === 69,
    "Legitimate Vendor attendance stores expected totalTime",
    created,
  );
}

/*
 * ============================================================
 * NONEXISTENT / MALFORMED ID TESTS
 * ============================================================
 */

async function testMalformedAndNonexistentIds(user, vendor) {
  section("MALFORMED / NONEXISTENT PRIVATE ACCOUNT IDENTITIES");

  const nonexistentUserId = new mongoose.Types.ObjectId().toString();
  const nonexistentVendorId = new mongoose.Types.ObjectId().toString();

  const userEndpoints = [
    `/user/getOrders/${nonexistentUserId}/1`,
    `/user/getShare/${nonexistentUserId}/0`,
    `/user/getUserByUser/${nonexistentUserId}`,
    `/user/getEarnings/${nonexistentUserId}`,
    `/user/getAttendance/${nonexistentUserId}/${TEST_MONTH}/${TEST_YEAR}`,
  ];

  for (const path of userEndpoints) {
    const response = await requestJson("GET", path, {
      token: user.token,
    });

    assert(
      response.status === 403 || response.status === 404,
      `Nonexistent User identity is rejected: ${path} [HTTP ${response.status}]`,
      response.data,
    );

    assertNot500(response, `Nonexistent User identity never causes HTTP 500: ${path}`);
  }

  const vendorEndpoints = [
    `/vendor/getOrders/${nonexistentVendorId}/1`,
    `/vendor/getShare/${nonexistentVendorId}/0`,
    `/vendor/getVendorByVendor/${nonexistentVendorId}`,
    `/vendor/getEarnings/${nonexistentVendorId}`,
    `/vendor/getAttendance/${nonexistentVendorId}/${TEST_MONTH}/${TEST_YEAR}`,
  ];

  for (const path of vendorEndpoints) {
    const response = await requestJson("GET", path, {
      token: vendor.token,
    });

    assert(
      response.status === 403 || response.status === 404,
      `Nonexistent Vendor identity is rejected: ${path} [HTTP ${response.status}]`,
      response.data,
    );

    assertNot500(response, `Nonexistent Vendor identity never causes HTTP 500: ${path}`);
  }
}

/*
 * ============================================================
 * CLEANUP
 * ============================================================
 */

async function cleanup() {
  section("CLEANUP");

  let bookingsDeleted = 0;
  let usersDeleted = 0;
  let vendorsDeleted = 0;
  let sharesDeleted = 0;
  let attendanceDeleted = 0;

  try {
    if (createdBookings.length > 0) {
      const result = await Bookings.deleteMany({
        _id: {
          $in: createdBookings,
        },
      });

      bookingsDeleted = result.deletedCount || 0;
    }

    /*
     * Delete all attendance records tied to test accounts,
     * not just IDs we explicitly tracked.
     *
     * This also removes attendance that might have been created
     * by a vulnerable endpoint before the assertion failed.
     */

    if (createdUsers.length > 0 || createdVendors.length > 0) {
      const result = await Attendance.deleteMany({
        $or: [
          {
            userId: {
              $in: createdUsers,
            },
          },
          {
            vendorId: {
              $in: createdVendors,
            },
          },
        ],
      });

      attendanceDeleted = result.deletedCount || 0;
    }

    if (createdShares.length > 0) {
      const result = await Share.deleteMany({
        _id: {
          $in: createdShares,
        },
      });

      sharesDeleted = result.deletedCount || 0;
    }

    /*
     * Also clean any Share records referencing test accounts.
     */

    if (createdUsers.length > 0 || createdVendors.length > 0) {
      const result = await Share.deleteMany({
        $or: [
          {
            userId: {
              $in: createdUsers,
            },
          },
          {
            vendorId: {
              $in: createdVendors,
            },
          },
        ],
      });

      sharesDeleted += result.deletedCount || 0;
    }

    if (createdUsers.length > 0 || createdVendors.length > 0) {
      await Bookings.deleteMany({
        $or: [
          {
            userId: {
              $in: createdUsers,
            },
          },
          {
            vendorId: {
              $in: createdVendors,
            },
          },
        ],
      });
    }

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
  } catch (err) {
    console.error("Cleanup error:", err);
  }

  console.log({
    bookingsDeleted,
    usersDeleted,
    vendorsDeleted,
    sharesDeleted,
    attendanceDeleted,
  });
}

/*
 * ============================================================
 * REPORT
 * ============================================================
 */

function printFinalReport() {
  section("FINAL ACCOUNT DATA AUTHORIZATION SECURITY TEST SUMMARY");

  console.log(`Assertions: ${assertions}`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);

  if (suiteCrashed) {
    console.log("\nTEST SUITE CRASHED BEFORE COMPLETION.");
    return;
  }

  if (failed === 0 && assertions > 0) {
    section("PASS: ACCOUNT DATA AUTHORIZATION SECURITY TESTS PASSED");

    console.log(`
Verified:

✓ User can access own private account data
✓ User cannot access another User's orders
✓ User cannot access another User's shares
✓ User cannot access another User's balance/details
✓ User cannot access another User's earnings
✓ User cannot access another User's attendance
✓ User cannot mark attendance for another User

✓ Vendor can access own private account data
✓ Vendor cannot access another Vendor's orders
✓ Vendor cannot access another Vendor's shares
✓ Vendor cannot access another Vendor's balance/details
✓ Vendor cannot access another Vendor's earnings
✓ Vendor cannot access another Vendor's attendance
✓ Vendor cannot mark attendance for another Vendor

✓ Missing JWT is rejected
✓ Invalid JWT is rejected
✓ Cross-role JWT access is rejected
✓ Malformed identities do not produce HTTP 500
✓ Nonexistent identities do not expose private data

✓ Rejected attendance write creates no Attendance document
✓ Rejected attendance write does not modify presentDate
✓ Legitimate User attendance still works
✓ Legitimate Vendor attendance still works

✓ JWT identity is authoritative
`);
  } else {
    section(`FAIL: ${failed} ACCOUNT DATA AUTHORIZATION SECURITY TEST(S) FAILED`);

    console.log(`
IMPORTANT:

A failed assertion may indicate an IDOR /
Broken Object Level Authorization vulnerability.

Examples:

User A JWT
+
/user/getEarnings/User-B-ID

must NOT expose User B's earnings.


Vendor A JWT
+
/vendor/getVendorByVendor/Vendor-B-ID

must NOT expose Vendor B's private account data.


User A JWT
+
POST /user/postAttendance/User-B-ID

must NOT create attendance for User B.


Vendor A JWT
+
POST /vendor/postAttendance/Vendor-B-ID

must NOT create attendance for Vendor B.


The authoritative identity is the authenticated JWT:

    req.auth.id

NOT the ID supplied by the client in:

    req.params
    req.body
    req.query


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

  section("ACCOUNT DATA AUTHORIZATION / IDOR E2E SECURITY TEST");

  console.log({
    api: API,
    nodeEnv: process.env.NODE_ENV,
  });

  await connectMongo();

  /*
   * Create only a small reusable account set.
   *
   * This reduces auth requests and avoids unnecessary pressure
   * on auth rate limiting.
   */

  const userVictim = await signupAndLoginUser("ACCOUNT SECURITY USER VICTIM");

  const userAttacker = await signupAndLoginUser("ACCOUNT SECURITY USER ATTACKER");

  const vendorVictim = await signupAndLoginVendor("ACCOUNT SECURITY VENDOR VICTIM");

  const vendorAttacker = await signupAndLoginVendor("ACCOUNT SECURITY VENDOR ATTACKER");

  await seedUserPrivateData(userVictim);
  await seedVendorPrivateData(vendorVictim);

  /*
   * USER PRIVATE DATA
   */

  await testUserGetOrders(userVictim, userAttacker, vendorAttacker.token);

  await testUserGetShare(userVictim, userAttacker, vendorAttacker.token);

  await testUserGetPrivateDetails(userVictim, userAttacker, vendorAttacker.token);

  await testUserEarnings(userVictim, userAttacker, vendorAttacker.token);

  await testUserAttendanceRead(userVictim, userAttacker, vendorAttacker.token);

  await testUserAttendanceWrite(userVictim, userAttacker, vendorAttacker.token);

  /*
   * VENDOR PRIVATE DATA
   */

  await testVendorGetOrders(vendorVictim, vendorAttacker, userAttacker.token);

  await testVendorGetShare(vendorVictim, vendorAttacker, userAttacker.token);

  await testVendorPrivateDetails(vendorVictim, vendorAttacker, userAttacker.token);

  await testVendorEarnings(vendorVictim, vendorAttacker, userAttacker.token);

  await testVendorAttendanceRead(vendorVictim, vendorAttacker, userAttacker.token);

  await testVendorAttendanceWrite(vendorVictim, vendorAttacker, userAttacker.token);

  await testMalformedAndNonexistentIds(userVictim, vendorVictim);
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
