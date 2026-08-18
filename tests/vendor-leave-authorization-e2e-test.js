"use strict";

/**
 * ============================================================
 * VENDOR LEAVE AUTHORIZATION / IDOR / BOLA E2E SECURITY TEST
 * ============================================================
 *
 * PURPOSE
 * -------
 * Verify:
 *
 * 1. Vendor leave management is authenticated.
 * 2. Vendor JWT identity is authoritative.
 * 3. Vendor A cannot mutate Vendor B leave records.
 * 4. User JWT cannot use Vendor-private leave endpoints.
 * 5. Failed leave operations do not mutate MongoDB state.
 * 6. Leave overlap / validation / availability behavior works.
 * 7. Expected validation failures must NOT become HTTP 500.
 *
 * ROUTES UNDER TEST
 * -----------------
 *
 * GET
 *   /vendor/getLeaveStats
 *
 * POST
 *   /vendor/createLeave
 *
 * DELETE
 *   /vendor/cancelLeave/:leaveId
 *
 * GET
 *   /vendor/availability?vendorId=...&date=...
 *
 * SECURITY RULE
 * -------------
 *
 * For PRIVATE leave-management routes:
 *
 *     req.auth.id
 *
 * is authoritative.
 *
 * Client-supplied:
 *
 *     body.vendorId
 *     params.vendorId
 *     query.vendorId
 *
 * MUST NOT be allowed to change private leave ownership.
 *
 * IMPORTANT:
 * ----------
 * /vendor/availability is intentionally treated differently.
 * It is an authenticated lookup endpoint and is allowed to
 * query another Vendor's availability.
 *
 * SAFETY
 * ------
 * This test creates temporary Users, Vendors and VendorLeave
 * records.
 *
 * NEVER run against production.
 *
 * RUN
 * ---
 *
 * NODE_ENV=development ALLOW_AUTHORIZATION_TEST=1 \
 * node tests/vendor-leave-authorization-e2e-test.js
 *
 * ============================================================
 */

const mongoose = require("mongoose");

const ENV = require("../src/config/env");

const User = require("../models/user");
const Vendor = require("../models/vendor");
const VendorLeave = require("../models/VendorLeave");

/*
 * ============================================================
 * CONFIG
 * ============================================================
 */

const API =
  process.env.VENDOR_LEAVE_AUTH_TEST_API || process.env.API_BASE_URL || "http://localhost:3000/api";

const DEFAULT_PASSWORD = "Test@123456";

let sequence = 0;

/*
 * ============================================================
 * TRACK CREATED DATA
 * ============================================================
 */

const createdUsers = [];
const createdVendors = [];
const createdLeaves = [];

let assertions = 0;
let passed = 0;
let failed = 0;
let suiteCrashed = false;

/*
 * ============================================================
 * OUTPUT HELPERS
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

function assertRejected(response, message) {
  return assert(
    response.status >= 400 && response.status < 500,
    `${message} [HTTP ${response.status}]`,
    response.data,
  );
}

function assertUnauthorized(response, message) {
  return assert(
    response.status === 401 || response.status === 403,
    `${message} [HTTP ${response.status}]`,
    response.data,
  );
}

/*
 * ============================================================
 * SAFETY
 * ============================================================
 */

function assertSafeEnvironment() {
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "REFUSING TO RUN: Vendor leave authorization test must not run with NODE_ENV=production.",
    );
  }

  if (process.env.ALLOW_AUTHORIZATION_TEST !== "1") {
    throw new Error("REFUSING TO RUN: set ALLOW_AUTHORIZATION_TEST=1 explicitly.");
  }
}

/*
 * ============================================================
 * GENERAL HELPERS
 * ============================================================
 */

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

  return `leave.auth.${normalized}.${Date.now()}.${sequence}@example.com`;
}

function futureDate(days) {
  const date = new Date();

  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + days);

  return date.toDateString();
}

function sameState(before, after) {
  return JSON.stringify(before) === JSON.stringify(after);
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
  } catch (error) {
    throw new Error(`HTTP request failed: ${method.toUpperCase()} ${path}\n${error.message}`);
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
 * AUTH
 * ============================================================
 */

async function signupAndLoginUser(label) {
  const phoneNo = nextPhone();
  const email = nextEmail(label);

  const signup = await requestJson("POST", "/user/signup", {
    body: {
      name: label,
      phoneNo,
      email,
      password: DEFAULT_PASSWORD,
      fcmToken: "",
      agreedToTnCnP: true,
    },
  });

  if (!(signup.status >= 200 && signup.status < 300)) {
    throw new Error(
      [
        "User signup failed.",
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

  createdUsers.push(userId);

  const login = await requestJson("POST", "/user/login", {
    body: {
      phoneNo,
      password: DEFAULT_PASSWORD,
    },
  });

  if (!(login.status >= 200 && login.status < 300)) {
    throw new Error(`User login failed: ${safeString(login.data)}`);
  }

  const token = extractToken(login);

  if (!token) {
    throw new Error(`User login did not return JWT for ${label}`);
  }

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

  const signup = await requestJson("POST", "/vendor/signup", {
    body: {
      name: label,
      phoneNo,
      email,
      password: DEFAULT_PASSWORD,
      type: "four wheeler",
      experience: 1,
      gender: "male",
      fcmToken: "",
      agreedToTnCnP: true,
    },
  });

  if (!(signup.status >= 200 && signup.status < 300)) {
    throw new Error(
      [
        "Vendor signup failed.",
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

  createdVendors.push(vendorId);

  const login = await requestJson("POST", "/vendor/login", {
    body: {
      phoneNo,
      password: DEFAULT_PASSWORD,
    },
  });

  if (!(login.status >= 200 && login.status < 300)) {
    throw new Error(`Vendor login failed: ${safeString(login.data)}`);
  }

  const token = extractToken(login);

  if (!token) {
    throw new Error(`Vendor login did not return JWT for ${label}`);
  }

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
 * DATABASE STATE HELPERS
 * ============================================================
 */

async function snapshotVendor(vendorId) {
  const vendor = await Vendor.findById(vendorId).lean();

  if (!vendor) {
    throw new Error(`Vendor not found: ${vendorId}`);
  }

  return {
    balance: Number(vendor.balance || 0),
    earning: Number(vendor.earning || 0),

    pending: Number(vendor.pending || 0),
    completed: Number(vendor.completed || 0),
    canceled: Number(vendor.canceled || 0),

    pendingVendor: Number(vendor.pendingVendor || 0),

    completedVendor: Number(vendor.completedVendor || 0),

    canceledVendor: Number(vendor.canceledVendor || 0),

    transactionCount: Number(vendor.transactionCount || 0),
  };
}

async function getVendorLeavesFromDb(vendorId) {
  return VendorLeave.find({
    vendorId,
  })
    .sort({
      from: 1,
    })
    .lean();
}

async function countVendorLeaves(vendorId) {
  return VendorLeave.countDocuments({
    vendorId,
  });
}

async function snapshotLeave(leaveId) {
  const leave = await VendorLeave.findById(leaveId).lean();

  if (!leave) {
    return null;
  }

  return {
    id: String(leave._id),
    vendorId: String(leave.vendorId),

    from: leave.from ? new Date(leave.from).toISOString() : null,

    to: leave.to ? new Date(leave.to).toISOString() : null,

    reason: leave.reason || "",
    status: leave.status,
  };
}

/*
 * ============================================================
 * DIRECT SEED HELPER
 * ============================================================
 *
 * Used where authorization — rather than creation behavior —
 * is the thing being tested.
 *
 * ============================================================
 */

async function seedLeave({
  vendorId,
  from,
  to,
  reason = "Security test leave",
  status = "active",
}) {
  const leave = await VendorLeave.create({
    vendorId,
    from: new Date(from),
    to: new Date(to),
    reason,
    status,
  });

  createdLeaves.push(String(leave._id));

  return leave;
}

/*
 * ============================================================
 * AUTHENTICATION TESTS
 * ============================================================
 */

async function testMissingJwt() {
  section("LEAVE MANAGEMENT - MISSING JWT");

  const read = await requestJson("GET", "/vendor/getLeaveStats");

  assertStatus(read, 401, "Missing JWT cannot read Vendor leaves");

  const create = await requestJson("POST", "/vendor/createLeave", {
    body: {
      from: futureDate(10),
      to: futureDate(11),
      reason: "Unauthorized",
    },
  });

  assertStatus(create, 401, "Missing JWT cannot create Vendor leave");

  const fakeId = new mongoose.Types.ObjectId().toString();

  const cancel = await requestJson("DELETE", `/vendor/cancelLeave/${fakeId}`);

  assertStatus(cancel, 401, "Missing JWT cannot cancel Vendor leave");
}

async function testInvalidJwt() {
  section("LEAVE MANAGEMENT - INVALID JWT");

  const headers = {
    Authorization: "Bearer this-is-not-a-valid-jwt",
  };

  const read = await requestJson("GET", "/vendor/getLeaveStats", {
    headers,
  });

  assertStatus(read, 401, "Invalid JWT cannot read Vendor leaves");

  const create = await requestJson("POST", "/vendor/createLeave", {
    headers,

    body: {
      from: futureDate(12),
      to: futureDate(13),
    },
  });

  assertStatus(create, 401, "Invalid JWT cannot create Vendor leave");
}

/*
 * ============================================================
 * CROSS ROLE
 * ============================================================
 */

async function testUserCannotUsePrivateLeaveRoutes(user, victimVendor) {
  section("LEAVE MANAGEMENT - USER JWT CROSS ROLE");

  const victimLeave = await seedLeave({
    vendorId: victimVendor.id,
    from: futureDate(30),
    to: futureDate(31),
  });

  const before = await snapshotLeave(victimLeave._id);

  const read = await requestJson("GET", "/vendor/getLeaveStats", {
    token: user.token,
  });

  assertUnauthorized(read, "User JWT cannot read Vendor-private leaves");

  const create = await requestJson("POST", "/vendor/createLeave", {
    token: user.token,

    body: {
      vendorId: victimVendor.id,
      from: futureDate(32),
      to: futureDate(33),
      reason: "Cross-role attack",
    },
  });

  assertUnauthorized(create, "User JWT cannot create Vendor leave");

  const cancel = await requestJson("DELETE", `/vendor/cancelLeave/${victimLeave._id}`, {
    token: user.token,
  });

  assertUnauthorized(cancel, "User JWT cannot cancel Vendor leave");

  const after = await snapshotLeave(victimLeave._id);

  assert(sameState(before, after), "User cross-role requests leave victim state unchanged", {
    before,
    after,
  });
}

/*
 * ============================================================
 * LEGITIMATE CREATE + READ
 * ============================================================
 */

async function testLegitimateCreateAndRead(vendor) {
  section("LEAVE MANAGEMENT - LEGITIMATE CREATE / READ");

  const beforeCount = await countVendorLeaves(vendor.id);

  const from = futureDate(40);
  const to = futureDate(42);

  const response = await requestJson("POST", "/vendor/createLeave", {
    token: vendor.token,

    body: {
      from,
      to,
      reason: "  Family function  ",
    },
  });

  assertStatus(response, 201, "Vendor can create own future leave");

  const leaves = await getVendorLeavesFromDb(vendor.id);

  assert(leaves.length === beforeCount + 1, "Exactly one Vendor leave is created", {
    beforeCount,
    afterCount: leaves.length,
  });

  const created = leaves.find(
    (leave) => String(leave.vendorId) === vendor.id && leave.reason === "Family function",
  );

  assert(Boolean(created), "Created leave belongs to authenticated Vendor", leaves);

  if (!created) {
    throw new Error("Unable to locate legitimate created leave");
  }

  createdLeaves.push(String(created._id));

  assert(
    String(created.vendorId) === vendor.id,
    "Created leave.vendorId equals JWT Vendor ID",
    created,
  );

  assert(created.status === "active", "Created leave starts active", created);

  assert(created.reason === "Family function", "Leave reason is trimmed", created);

  const read = await requestJson("GET", "/vendor/getLeaveStats", {
    token: vendor.token,
  });

  assertStatus(read, 200, "Vendor can retrieve own leave records");

  const returnedLeaves = Array.isArray(read.data?.data) ? read.data.data : [];

  assert(
    returnedLeaves.some((leave) => String(leave._id) === String(created._id)),
    "Created leave appears in Vendor leave response",
    read.data,
  );

  assert(
    returnedLeaves.every((leave) => String(leave.vendorId) === vendor.id),
    "Private leave response contains only authenticated Vendor records",
    returnedLeaves,
  );

  return String(created._id);
}

/*
 * ============================================================
 * BODY vendorId INJECTION
 * ============================================================
 */

async function testBodyVendorIdInjection(attacker, victim) {
  section("LEAVE CREATION - BODY VENDOR ID INJECTION");

  const attackerBefore = await countVendorLeaves(attacker.id);

  const victimBefore = await countVendorLeaves(victim.id);

  const victimStateBefore = await snapshotVendor(victim.id);

  const response = await requestJson("POST", "/vendor/createLeave", {
    token: attacker.token,

    body: {
      /*
       * Deliberately malicious.
       *
       * Controller MUST use req.auth.id.
       */
      vendorId: victim.id,

      from: futureDate(50),
      to: futureDate(51),

      reason: "Injected victim vendorId",
    },
  });

  assertStatus(
    response,
    201,
    "Injected body.vendorId cannot redirect authenticated Vendor leave ownership",
  );

  const attackerAfter = await countVendorLeaves(attacker.id);

  const victimAfter = await countVendorLeaves(victim.id);

  assert(attackerAfter === attackerBefore + 1, "Injected request creates leave for JWT Vendor", {
    before: attackerBefore,
    after: attackerAfter,
  });

  assert(victimAfter === victimBefore, "Injected vendorId creates no leave for victim Vendor", {
    before: victimBefore,
    after: victimAfter,
  });

  const created = await VendorLeave.findOne({
    vendorId: attacker.id,
    reason: "Injected victim vendorId",
  }).lean();

  assert(Boolean(created), "JWT Vendor owns leave created by injected request", created);

  if (created) {
    createdLeaves.push(String(created._id));

    assert(
      String(created.vendorId) === attacker.id,
      "req.auth.id is authoritative for leave creation",
      created,
    );
  }

  const victimStateAfter = await snapshotVendor(victim.id);

  assert(
    sameState(victimStateBefore, victimStateAfter),
    "Identity injection leaves victim Vendor accounting unchanged",
  );
}

/*
 * ============================================================
 * CANCEL IDOR
 * ============================================================
 */

async function testVendorCannotCancelAnotherLeave(attacker, victim) {
  section("LEAVE CANCELLATION - VENDOR IDOR ATTACK");

  const victimLeave = await seedLeave({
    vendorId: victim.id,
    from: futureDate(60),
    to: futureDate(62),
    reason: "Victim protected leave",
  });

  const leaveBefore = await snapshotLeave(victimLeave._id);

  const attackerBefore = await snapshotVendor(attacker.id);

  const victimBefore = await snapshotVendor(victim.id);

  const response = await requestJson("DELETE", `/vendor/cancelLeave/${victimLeave._id}`, {
    token: attacker.token,
  });

  /*
   * Because cancellation searches:
   *
   * {
   *   _id: leaveId,
   *   vendorId: JWT vendorId,
   *   status: "active"
   * }
   *
   * secure behavior should hide ownership and return 404.
   */
  assertStatus(response, [403, 404], "Vendor cannot cancel another Vendor's leave");

  assertNot500(response, "Unauthorized leave cancellation must not become HTTP 500");

  const leaveAfter = await snapshotLeave(victimLeave._id);

  assert(
    sameState(leaveBefore, leaveAfter),
    "Unauthorized cancellation leaves victim leave unchanged",
    {
      before: leaveBefore,
      after: leaveAfter,
    },
  );

  assert(leaveAfter?.status === "active", "Attacker cannot change victim leave status", leaveAfter);

  const attackerAfter = await snapshotVendor(attacker.id);

  const victimAfter = await snapshotVendor(victim.id);

  assert(
    sameState(attackerBefore, attackerAfter),
    "Unauthorized cancellation leaves attacker accounting unchanged",
  );

  assert(
    sameState(victimBefore, victimAfter),
    "Unauthorized cancellation leaves victim Vendor accounting unchanged",
  );
}

/*
 * ============================================================
 * LEGITIMATE CANCELLATION
 * ============================================================
 */

async function testLegitimateCancellation(vendor) {
  section("LEAVE CANCELLATION - LEGITIMATE OWNER");

  const leave = await seedLeave({
    vendorId: vendor.id,
    from: futureDate(70),
    to: futureDate(72),
    reason: "Cancellation test",
  });

  const response = await requestJson("DELETE", `/vendor/cancelLeave/${leave._id}`, {
    token: vendor.token,
  });

  assertStatus(response, 200, "Vendor can cancel own active future leave");

  const after = await snapshotLeave(leave._id);

  assert(
    after?.status === "cancelled",
    "Legitimate cancellation changes status to cancelled",
    after,
  );

  return String(leave._id);
}

/*
 * ============================================================
 * DUPLICATE CANCELLATION
 * ============================================================
 */

async function testDuplicateCancellation(vendor, cancelledLeaveId) {
  section("LEAVE CANCELLATION - DUPLICATE REQUEST");

  const before = await snapshotLeave(cancelledLeaveId);

  const response = await requestJson("DELETE", `/vendor/cancelLeave/${cancelledLeaveId}`, {
    token: vendor.token,
  });

  assertRejected(response, "Duplicate cancellation is safely rejected");

  assertNot500(response, "Duplicate cancellation must not produce HTTP 500");

  const after = await snapshotLeave(cancelledLeaveId);

  assert(sameState(before, after), "Duplicate cancellation does not further mutate leave", {
    before,
    after,
  });

  assert(after?.status === "cancelled", "Duplicate cancellation keeps leave cancelled", after);
}

/*
 * ============================================================
 * INVALID LEAVE ID
 * ============================================================
 */

async function testMalformedAndNonexistentLeaveId(vendor) {
  section("LEAVE CANCELLATION - INVALID IDENTIFIERS");

  const before = await countVendorLeaves(vendor.id);

  const malformed = await requestJson("DELETE", "/vendor/cancelLeave/not-a-valid-object-id", {
    token: vendor.token,
  });

  assertRejected(malformed, "Malformed leaveId is rejected");

  assertNot500(malformed, "Malformed leaveId must not produce HTTP 500");

  const nonexistentId = new mongoose.Types.ObjectId().toString();

  const nonexistent = await requestJson("DELETE", `/vendor/cancelLeave/${nonexistentId}`, {
    token: vendor.token,
  });

  assertRejected(nonexistent, "Nonexistent leaveId is rejected");

  assertNot500(nonexistent, "Nonexistent leaveId must not produce HTTP 500");

  const after = await countVendorLeaves(vendor.id);

  assert(before === after, "Invalid cancellation identifiers create/delete no leave records", {
    before,
    after,
  });
}

/*
 * ============================================================
 * INVALID DATE RANGES
 * ============================================================
 */

async function testInvalidDateRanges(vendor) {
  section("LEAVE CREATION - DATE VALIDATION");

  const before = await countVendorLeaves(vendor.id);

  const missingFrom = await requestJson("POST", "/vendor/createLeave", {
    token: vendor.token,

    body: {
      to: futureDate(81),
    },
  });

  assertStatus(missingFrom, 400, "Missing leave start date is rejected");

  const missingTo = await requestJson("POST", "/vendor/createLeave", {
    token: vendor.token,

    body: {
      from: futureDate(80),
    },
  });

  assertStatus(missingTo, 400, "Missing leave end date is rejected");

  const malformed = await requestJson("POST", "/vendor/createLeave", {
    token: vendor.token,

    body: {
      from: "definitely-not-a-date",
      to: "also-not-a-date",
    },
  });

  assertRejected(malformed, "Malformed leave date is rejected");

  assertNot500(malformed, "Malformed leave date must not produce HTTP 500");

  const reversed = await requestJson("POST", "/vendor/createLeave", {
    token: vendor.token,

    body: {
      from: futureDate(90),
      to: futureDate(85),
    },
  });

  assertRejected(reversed, "Reversed leave range is rejected");

  assertNot500(reversed, "Invalid leave range must not produce HTTP 500");

  const after = await countVendorLeaves(vendor.id);

  assert(before === after, "Rejected date validation requests create no leave", {
    before,
    after,
  });
}

/*
 * ============================================================
 * OVERLAPPING LEAVE
 * ============================================================
 */

async function testOverlap(vendor) {
  section("LEAVE CREATION - OVERLAPPING LEAVE");

  const leave = await seedLeave({
    vendorId: vendor.id,
    from: futureDate(100),
    to: futureDate(105),
    reason: "Overlap baseline",
  });

  const beforeCount = await countVendorLeaves(vendor.id);

  const before = await snapshotLeave(leave._id);

  const response = await requestJson("POST", "/vendor/createLeave", {
    token: vendor.token,

    body: {
      from: futureDate(103),
      to: futureDate(108),
      reason: "Should overlap",
    },
  });

  assertRejected(response, "Overlapping leave is rejected");

  assertNot500(response, "Leave overlap must not produce HTTP 500");

  const afterCount = await countVendorLeaves(vendor.id);

  assert(beforeCount === afterCount, "Overlap rejection creates no additional leave", {
    beforeCount,
    afterCount,
  });

  const after = await snapshotLeave(leave._id);

  assert(sameState(before, after), "Overlap rejection leaves existing leave unchanged", {
    before,
    after,
  });
}

/*
 * ============================================================
 * REASON SANITIZATION
 * ============================================================
 */

async function testReasonSanitization(vendor) {
  section("LEAVE CREATION - REASON SANITIZATION");

  const longReason = `   ${"R".repeat(250)}   `;

  const response = await requestJson("POST", "/vendor/createLeave", {
    token: vendor.token,

    body: {
      from: futureDate(120),
      to: futureDate(121),
      reason: longReason,
    },
  });

  assertStatus(response, 201, "Long leave reason is safely accepted/sanitized");

  const leave = await VendorLeave.findOne({
    vendorId: vendor.id,
    from: {
      $gte: new Date(futureDate(120)),
    },
  })
    .sort({
      _id: -1,
    })
    .lean();

  assert(Boolean(leave), "Sanitized leave exists in database", leave);

  if (!leave) return;

  createdLeaves.push(String(leave._id));

  assert(leave.reason.length <= 200, "Persisted leave reason never exceeds 200 characters", {
    length: leave.reason.length,
  });

  assert(
    leave.reason === leave.reason.trim(),
    "Persisted leave reason has surrounding whitespace removed",
    leave.reason,
  );
}

/*
 * ============================================================
 * AVAILABILITY
 * ============================================================
 */

async function testAvailability(vendor, user) {
  section("VENDOR LEAVE - AVAILABILITY");

  const leave = await seedLeave({
    vendorId: vendor.id,
    from: futureDate(140),
    to: futureDate(142),
    reason: "Availability test",
  });

  const during = futureDate(141);
  const outside = futureDate(145);

  const duringResponse = await requestJson(
    "GET",
    `/vendor/availability?vendorId=${encodeURIComponent(
      vendor.id,
    )}&date=${encodeURIComponent(during)}`,
    {
      token: user.token,
    },
  );

  assertStatus(duringResponse, 200, "Authenticated User can query provider availability");

  assert(
    duringResponse.data?.data?.available === false,
    "Vendor is unavailable during active leave",
    duringResponse.data,
  );

  const outsideResponse = await requestJson(
    "GET",
    `/vendor/availability?vendorId=${encodeURIComponent(
      vendor.id,
    )}&date=${encodeURIComponent(outside)}`,
    {
      token: user.token,
    },
  );

  assertStatus(outsideResponse, 200, "Availability lookup succeeds outside leave");

  assert(
    outsideResponse.data?.data?.available === true,
    "Vendor is available outside active leave",
    outsideResponse.data,
  );

  /*
   * Cancel leave through legitimate Vendor endpoint.
   */

  const cancel = await requestJson("DELETE", `/vendor/cancelLeave/${leave._id}`, {
    token: vendor.token,
  });

  assertStatus(cancel, 200, "Vendor can cancel leave used by availability");

  const afterCancellation = await requestJson(
    "GET",
    `/vendor/availability?vendorId=${encodeURIComponent(
      vendor.id,
    )}&date=${encodeURIComponent(during)}`,
    {
      token: user.token,
    },
  );

  assertStatus(afterCancellation, 200, "Availability lookup succeeds after leave cancellation");

  assert(
    afterCancellation.data?.data?.available === true,
    "Cancelled leave no longer blocks Vendor availability",
    afterCancellation.data,
  );
}

/*
 * ============================================================
 * AVAILABILITY AUTH
 * ============================================================
 */

async function testAvailabilityAuthentication(vendor) {
  section("VENDOR AVAILABILITY - AUTHENTICATION");

  const path = `/vendor/availability?vendorId=${encodeURIComponent(
    vendor.id,
  )}&date=${encodeURIComponent(futureDate(160))}`;

  const missing = await requestJson("GET", path);

  assertStatus(missing, 401, "Availability rejects missing JWT");

  const invalid = await requestJson("GET", path, {
    headers: {
      Authorization: "Bearer invalid-jwt-security-test",
    },
  });

  assertStatus(invalid, 401, "Availability rejects invalid JWT");
}

/*
 * ============================================================
 * AVAILABILITY VALIDATION
 * ============================================================
 */

async function testAvailabilityValidation(vendor, user) {
  section("VENDOR AVAILABILITY - INPUT VALIDATION");

  const missingVendor = await requestJson(
    "GET",
    `/vendor/availability?date=${encodeURIComponent(futureDate(170))}`,
    {
      token: user.token,
    },
  );

  assertStatus(missingVendor, 400, "Availability requires vendorId");

  const missingDate = await requestJson(
    "GET",
    `/vendor/availability?vendorId=${encodeURIComponent(vendor.id)}`,
    {
      token: user.token,
    },
  );

  assertStatus(missingDate, 400, "Availability requires date");

  const malformedDate = await requestJson(
    "GET",
    `/vendor/availability?vendorId=${encodeURIComponent(vendor.id)}&date=not-a-real-date`,
    {
      token: user.token,
    },
  );

  assertRejected(malformedDate, "Availability rejects malformed date");

  assertNot500(malformedDate, "Malformed availability date must not produce HTTP 500");
}

/*
 * ============================================================
 * PRIVATE READ IS JWT-SCOPED
 * ============================================================
 */

async function testPrivateReadIsolation(victim, attacker) {
  section("VENDOR LEAVE READ - PRIVATE ISOLATION");

  const marker = `VICTIM-PRIVATE-${Date.now()}`;

  await seedLeave({
    vendorId: victim.id,
    from: futureDate(180),
    to: futureDate(181),
    reason: marker,
  });

  const response = await requestJson("GET", "/vendor/getLeaveStats", {
    token: attacker.token,
  });

  assertStatus(response, 200, "Attacker Vendor can retrieve own leave collection");

  const leaves = Array.isArray(response.data?.data) ? response.data.data : [];

  const leaked = leaves.some(
    (leave) => String(leave.vendorId) === victim.id || leave.reason === marker,
  );

  assert(!leaked, "Vendor private leave read does not expose another Vendor's records", leaves);
}

/*
 * ============================================================
 * CLEANUP
 * ============================================================
 */

async function cleanup() {
  section("CLEANUP");

  let leavesDeleted = 0;
  let usersDeleted = 0;
  let vendorsDeleted = 0;

  try {
    if (createdVendors.length > 0) {
      const result = await VendorLeave.deleteMany({
        vendorId: {
          $in: createdVendors,
        },
      });

      leavesDeleted += result.deletedCount || 0;
    }

    /*
     * Also remove explicitly tracked IDs in case a test
     * created a leave through an unexpected ownership path.
     */

    if (createdLeaves.length > 0) {
      const result = await VendorLeave.deleteMany({
        _id: {
          $in: createdLeaves,
        },
      });

      leavesDeleted += result.deletedCount || 0;
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

    console.log({
      leavesDeleted,
      usersDeleted,
      vendorsDeleted,
    });
  } catch (error) {
    console.error("Cleanup error:", error);

    suiteCrashed = true;
  }
}

/*
 * ============================================================
 * SUMMARY
 * ============================================================
 */

function printSummary() {
  section("FINAL VENDOR LEAVE SECURITY TEST SUMMARY");

  console.log(`Assertions: ${assertions}`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);

  if (suiteCrashed) {
    console.log("\nTEST SUITE CRASHED BEFORE COMPLETION.");

    process.exitCode = 1;

    return;
  }

  if (failed === 0) {
    section("PASS: VENDOR LEAVE AUTHORIZATION SECURITY TESTS PASSED");

    console.log(`
Verified:

✓ Real signup/login/JWT flow works

✓ Missing JWT cannot access private Vendor leave routes

✓ Invalid JWT cannot access private Vendor leave routes

✓ User JWT cannot manage Vendor leave

✓ Vendor can create own leave

✓ Vendor can retrieve own leave records

✓ JWT Vendor ID determines leave ownership

✓ body.vendorId cannot redirect leave ownership

✓ Vendor cannot read another Vendor's private leave data

✓ Vendor cannot cancel another Vendor's leave

✓ Unauthorized cancellation leaves victim leave unchanged

✓ Unauthorized requests leave Vendor accounting unchanged

✓ Vendor can cancel own leave

✓ Duplicate cancellation is safe

✓ Malformed leaveId is rejected without HTTP 500

✓ Nonexistent leaveId is rejected without HTTP 500

✓ Missing dates are rejected

✓ Malformed dates are rejected without HTTP 500

✓ Reversed leave range is rejected without HTTP 500

✓ Overlapping leave is rejected without HTTP 500

✓ Overlap rejection creates no additional leave

✓ Leave reason is trimmed

✓ Leave reason is limited to 200 characters

✓ Authenticated User can query Vendor availability

✓ Active leave makes Vendor unavailable

✓ Vendor remains available outside leave

✓ Cancelled leave no longer blocks availability

✓ Availability requires authentication

✓ Invalid availability input is rejected safely

✓ Failed security requests do not mutate protected state

✓ req.auth.id is authoritative for private leave management
`);

    return;
  }

  section(`FAIL: ${failed} VENDOR LEAVE SECURITY TEST(S) FAILED`);

  console.log(`
IMPORTANT:

A failed assertion may indicate either:

1. IDOR / Broken Object Level Authorization

2. Leave validation/business errors leaking as HTTP 500

3. Incorrect leave ownership

4. Incorrect availability behavior

5. Non-atomic state mutation


Critical authorization rule:

Vendor A JWT
+
DELETE /vendor/cancelLeave/<Vendor-B-Leave-ID>

must NEVER cancel Vendor B's leave.


Likewise:

Vendor A JWT
+
POST /vendor/createLeave
{
  "vendorId": "Vendor-B-ID",
  ...
}

must NEVER create leave for Vendor B.

The authoritative private Vendor identity is:

    req.auth.id


Expected business validation errors such as:

    INVALID_LEAVE_RANGE
    INVALID_LEAVE_ID
    LEAVE_NOT_FOUND
    LEAVE_OVERLAP
    LEAVE_CONFLICTS_WITH_BOOKINGS

must NOT normally become HTTP 500.


DO NOT weaken this test to accept unauthorized mutation.

Fix the authorization/error boundary instead.
`);

  process.exitCode = 1;
}

/*
 * ============================================================
 * MAIN
 * ============================================================
 */

async function main() {
  assertSafeEnvironment();

  section("VENDOR LEAVE AUTHORIZATION / IDOR E2E SECURITY TEST");

  console.log({
    api: API,
    nodeEnv: process.env.NODE_ENV,
  });

  await connectMongo();

  /*
   * Reuse a small account set to avoid unnecessary auth
   * rate-limit pressure.
   */

  const user = await signupAndLoginUser("LEAVE SECURITY USER");

  const victim = await signupAndLoginVendor("LEAVE SECURITY VENDOR VICTIM");

  const attacker = await signupAndLoginVendor("LEAVE SECURITY VENDOR ATTACKER");

  const validationVendor = await signupAndLoginVendor("LEAVE SECURITY VALIDATION VENDOR");

  /*
   * Authentication boundary.
   */

  await testMissingJwt();

  await testInvalidJwt();

  await testUserCannotUsePrivateLeaveRoutes(user, victim);

  /*
   * Legitimate behavior.
   */

  await testLegitimateCreateAndRead(victim);

  /*
   * Ownership / BOLA.
   */

  await testBodyVendorIdInjection(attacker, victim);

  await testPrivateReadIsolation(victim, attacker);

  await testVendorCannotCancelAnotherLeave(attacker, victim);

  /*
   * Cancellation lifecycle.
   */

  const cancelledLeaveId = await testLegitimateCancellation(validationVendor);

  await testDuplicateCancellation(validationVendor, cancelledLeaveId);

  await testMalformedAndNonexistentLeaveId(validationVendor);

  /*
   * Validation.
   */

  await testInvalidDateRanges(validationVendor);

  await testOverlap(validationVendor);

  await testReasonSanitization(validationVendor);

  /*
   * Availability.
   */

  await testAvailabilityAuthentication(victim);

  await testAvailabilityValidation(victim, user);

  await testAvailability(victim, user);
}

/*
 * ============================================================
 * RUNNER
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
    if (mongoose.connection.readyState !== 0) {
      await cleanup();

      await mongoose.disconnect();

      console.log("\nMongoDB disconnected.");
    }

    printSummary();
  }
})();
