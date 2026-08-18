"use strict";

/**
 * ============================================================
 * PROFILE MUTATION AUTHORIZATION / MASS ASSIGNMENT E2E TEST
 * ============================================================
 *
 * PURPOSE
 * -------
 * Verify that User/Vendor profile mutation endpoints:
 *
 * 1. Require valid role-specific authentication.
 * 2. Use JWT identity as the authoritative account identity.
 * 3. Cannot mutate another account through body ID injection.
 * 4. Ignore/reject mass-assignment attempts against protected fields.
 * 5. Mutate only explicitly allowed profile fields.
 *
 * IMPORTANT
 * ---------
 * MongoDB state is authoritative.
 *
 * A HTTP 200 response is NOT enough. After every important mutation,
 * the database is inspected to verify that protected fields remain
 * unchanged.
 *
 * This test intentionally does not test password/OTP correctness.
 * Email mutation is tested for authorization separately where possible.
 *
 * RUN
 * ---
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
 * OUTPUT HELPERS
 * ============================================================
 */

function section(title) {
  console.log("\n========================================");
  console.log(title);
  console.log("========================================");
}

function safeString(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function assert(condition, message, details) {
  assertions += 1;

  if (condition) {
    passed += 1;
    console.log(`✓ ${message}`);
    return true;
  }

  failed += 1;
  console.error(`✗ ${message}`);

  if (details !== undefined) {
    console.error(safeString(details));
  }

  return false;
}

function assertStatus(response, expected, message) {
  return assert(
    response.status === expected,
    `${message} [HTTP ${response.status}]`,
    response.status === expected ? undefined : response.data,
  );
}

function assertUnauthorized(response, message) {
  return assert(
    response.status === 401,
    `${message} [HTTP ${response.status}]`,
    response.status === 401 ? undefined : response.data,
  );
}

function assertForbiddenOrUnauthorized(response, message) {
  return assert(
    response.status === 401 || response.status === 403,
    `${message} [HTTP ${response.status}]`,
    response.status === 401 || response.status === 403 ? undefined : response.data,
  );
}

/*
 * ============================================================
 * VALUE HELPERS
 * ============================================================
 */

function nextPhone() {
  /*
   * Keep generated values in a realistic Indian mobile range.
   */
  sequence += 1;

  return 8000000000 + ((Date.now() + sequence * 97) % 999999999);
}

function nextEmail(label) {
  sequence += 1;

  const normalized = String(label)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

  return `${normalized}.${Date.now()}.${sequence}@example.com`;
}

function authHeader(token) {
  return {
    Authorization: `Bearer ${token}`,
  };
}

function invalidAuthHeader() {
  return {
    Authorization: "Bearer definitely.invalid.jwt",
  };
}

/*
 * ============================================================
 * HTTP
 * ============================================================
 */

async function requestJson(method, path, { token, headers = {}, body } = {}) {
  const finalHeaders = {
    Accept: "application/json",
    ...headers,
  };

  if (token) {
    finalHeaders.Authorization = `Bearer ${token}`;
  }

  if (body !== undefined) {
    finalHeaders["Content-Type"] = "application/json";
  }

  let response;

  try {
    response = await fetch(`${API}${path}`, {
      method,
      headers: finalHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    throw new Error(`HTTP request failed: ${method} ${path}\n${error.message}`);
  }

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
}

/*
 * ============================================================
 * AUTH RESPONSE EXTRACTION
 * ============================================================
 */

function extractToken(response) {
  const data = response?.data;

  return (
    data?.token ||
    data?.accessToken ||
    data?.jwt ||
    data?.data?.token ||
    data?.data?.accessToken ||
    data?.user?.token ||
    data?.vendor?.token ||
    null
  );
}

function extractId(response, type) {
  const data = response?.data;

  if (!data) {
    return null;
  }

  const candidates =
    type === "user"
      ? [
          data.userId,
          data._id,
          data.id,
          data?.data?.userId,
          data?.data?._id,
          data?.data?.id,
          data?.user?._id,
          data?.user?.id,
        ]
      : [
          data.vendorId,
          data._id,
          data.id,
          data?.data?.vendorId,
          data?.data?._id,
          data?.data?.id,
          data?.vendor?._id,
          data?.vendor?.id,
        ];

  const id = candidates.find(Boolean);

  return id ? String(id) : null;
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
 * ACCOUNT CREATION
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
    const user = await User.findOne({ phoneNo }).select("_id").lean();

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
    const vendor = await Vendor.findOne({ phoneNo }).select("_id").lean();

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
 * SNAPSHOT HELPERS
 * ============================================================
 */

async function getUser(id) {
  return User.findById(id).lean();
}

async function getVendor(id) {
  return Vendor.findById(id).lean();
}

function normalize(value) {
  if (value instanceof mongoose.Types.ObjectId) {
    return String(value);
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    return value.map(normalize);
  }

  if (value && typeof value === "object") {
    const result = {};

    for (const [key, item] of Object.entries(value)) {
      if (key === "updatedAt") {
        continue;
      }

      result[key] = normalize(item);
    }

    return result;
  }

  return value;
}

function pick(obj, fields) {
  const result = {};

  for (const field of fields) {
    result[field] = normalize(obj?.[field]);
  }

  return result;
}

function sameProtectedFields(before, after, fields) {
  return JSON.stringify(pick(before, fields)) === JSON.stringify(pick(after, fields));
}

/*
 * ============================================================
 * PROTECTED FIELDS
 * ============================================================
 */

const USER_PROTECTED_FIELDS = [
  "phoneNo",
  "email",
  "password",
  "verifyPhoneNo",
  "verifyEmail",
  "shareBy",
  "pending",
  "completed",
  "canceled",
  "earning",
  "pendingShareBy",
  "completedShareBy",
  "canceledShareBy",
  "accountCreatedOn",
  "cd",
  "balance",
  "bookingCount",
  "shareCount",
  "transactionCount",
  "totalDiscount",
  "presentDate",
];

const VENDOR_PROTECTED_FIELDS = [
  "phoneNo",
  "email",
  "password",
  "verifyPhoneNo",
  "verifyEmail",
  "type",
  "experience",
  "isVerified",
  "shareBy",
  "pending",
  "completed",
  "canceled",
  "earning",
  "commission",
  "pendingVendor",
  "completedVendor",
  "canceledVendor",
  "pendingShareBy",
  "completedShareBy",
  "canceledShareBy",
  "rating",
  "ratingCount",
  "accountCreatedOn",
  "cd",
  "balance",
  "bookingCount",
  "bookingCountVendor",
  "shareCount",
  "transactionCount",
  "totalDiscount",
  "presentDate",
];

/*
 * ============================================================
 * MASS ASSIGNMENT PAYLOADS
 * ============================================================
 */

function maliciousUserFields(victimId) {
  return {
    userId: victimId,

    balance: 99999999,
    earning: 99999999,

    pending: 999999,
    completed: 999999,
    canceled: 999999,

    pendingShareBy: 999999,
    completedShareBy: 999999,
    canceledShareBy: 999999,

    bookingCount: 999999,
    shareCount: 999999,
    transactionCount: 999999,
    totalDiscount: 999999,

    shareBy: String(victimId),

    verifyPhoneNo: true,
    verifyEmail: true,

    cd: "MASS_ASSIGNMENT_ATTACK",

    role: "admin",
    isAdmin: true,
    admin: true,
  };
}

function maliciousVendorFields(victimId) {
  return {
    vendorId: victimId,

    balance: 99999999,
    earning: 99999999,
    commission: 0,

    pending: 999999,
    completed: 999999,
    canceled: 999999,

    pendingVendor: 999999,
    completedVendor: 999999,
    canceledVendor: 999999,

    pendingShareBy: 999999,
    completedShareBy: 999999,
    canceledShareBy: 999999,

    rating: 5,
    ratingCount: 999999,

    bookingCount: 999999,
    bookingCountVendor: 999999,
    shareCount: 999999,
    transactionCount: 999999,
    totalDiscount: 999999,

    shareBy: String(victimId),

    isVerified: true,
    verifyPhoneNo: true,
    verifyEmail: true,

    type: "MASS_ASSIGNMENT_TYPE",
    experience: 999999,

    cd: "MASS_ASSIGNMENT_ATTACK",

    role: "admin",
    isAdmin: true,
    admin: true,
  };
}

/*
 * ============================================================
 * MAIN SUITE
 * ============================================================
 */

async function run() {
  section("PROFILE MUTATION AUTHORIZATION / MASS ASSIGNMENT E2E SECURITY TEST");

  console.log({
    api: API,
    nodeEnv: process.env.NODE_ENV,
  });

  if (process.env.NODE_ENV === "production") {
    throw new Error("Refusing to run authorization E2E test in production.");
  }

  if (process.env.ALLOW_AUTHORIZATION_TEST !== "1") {
    throw new Error(
      "Set ALLOW_AUTHORIZATION_TEST=1 to explicitly allow this destructive E2E test.",
    );
  }

  await connectMongo();

  /*
   * ------------------------------------------------------------
   * CREATE ACCOUNTS
   * ------------------------------------------------------------
   */

  const userA = await signupAndLoginUser("PROFILE AUTH USER A");
  const userB = await signupAndLoginUser("PROFILE AUTH USER B");

  const vendorA = await signupAndLoginVendor("PROFILE AUTH VENDOR A");
  const vendorB = await signupAndLoginVendor("PROFILE AUTH VENDOR B");

  /*
   * ============================================================
   * USER NAME AUTHENTICATION
   * ============================================================
   */

  section("USER PROFILE - MISSING / INVALID JWT");

  let response = await requestJson("PATCH", "/user/edit/name", {
    body: {
      name: "UNAUTHORIZED NAME",
    },
  });

  assertUnauthorized(response, "Missing JWT cannot update User name");

  response = await requestJson("PATCH", "/user/edit/name", {
    headers: invalidAuthHeader(),
    body: {
      name: "INVALID JWT NAME",
    },
  });

  assertUnauthorized(response, "Invalid JWT cannot update User name");

  /*
   * ============================================================
   * USER CROSS ROLE
   * ============================================================
   */

  section("USER PROFILE - VENDOR JWT CROSS ROLE");

  const userBeforeCrossRole = await getUser(userA.id);

  response = await requestJson("PATCH", "/user/edit/name", {
    token: vendorA.token,
    body: {
      name: "VENDOR ATTACK",
      userId: userA.id,
    },
  });

  assertForbiddenOrUnauthorized(response, "Vendor JWT cannot mutate User profile");

  const userAfterCrossRole = await getUser(userA.id);

  assert(
    userAfterCrossRole.name === userBeforeCrossRole.name,
    "Vendor cross-role request leaves User name unchanged",
    {
      before: userBeforeCrossRole.name,
      after: userAfterCrossRole.name,
    },
  );

  /*
   * ============================================================
   * USER LEGITIMATE NAME UPDATE
   * ============================================================
   */

  section("USER PROFILE - LEGITIMATE NAME UPDATE");

  response = await requestJson("PATCH", "/user/edit/name", {
    token: userA.token,
    body: {
      name: "PROFILE AUTH USER A UPDATED",
    },
  });

  assertStatus(response, 200, "User can update own name");

  let currentUserA = await getUser(userA.id);

  assert(
    currentUserA.name === "PROFILE AUTH USER A UPDATED",
    "User legitimate name update persists to authenticated account",
    currentUserA,
  );

  /*
   * ============================================================
   * USER IDOR NAME
   * ============================================================
   */

  section("USER PROFILE - BODY USER ID INJECTION");

  const victimUserBefore = await getUser(userB.id);

  response = await requestJson("PATCH", "/user/edit/name", {
    token: userA.token,
    body: {
      userId: userB.id,
      name: "USER B COMPROMISED",
    },
  });

  assert(
    response.status === 403,
    `User cannot redirect name update using body.userId [HTTP ${response.status}]`,
    response.status === 403 ? undefined : response.data,
  );

  const victimUserAfter = await getUser(userB.id);

  assert(
    victimUserAfter.name === victimUserBefore.name,
    "Injected body.userId leaves victim User name unchanged",
    {
      before: victimUserBefore.name,
      after: victimUserAfter.name,
    },
  );

  /*
   * ============================================================
   * USER FCM
   * ============================================================
   */

  section("USER PROFILE - FCM TOKEN AUTHORIZATION");

  response = await requestJson("PATCH", "/user/edit/fcmToken", {
    token: userA.token,
    body: {
      fcmToken: "USER_A_TEST_FCM_TOKEN",
    },
  });

  assertStatus(response, 200, "User can update own FCM token");

  currentUserA = await getUser(userA.id);

  assert(
    currentUserA.fcmToken === "USER_A_TEST_FCM_TOKEN",
    "FCM token update belongs to authenticated User",
    currentUserA.fcmToken,
  );

  const victimBeforeFcm = await getUser(userB.id);

  response = await requestJson("PATCH", "/user/edit/fcmToken", {
    token: userA.token,
    body: {
      userId: userB.id,
      fcmToken: "VICTIM_COMPROMISED_FCM",
    },
  });

  assert(
    response.status === 403,
    `User cannot redirect FCM update using body.userId [HTTP ${response.status}]`,
    response.status === 403 ? undefined : response.data,
  );

  const victimAfterFcm = await getUser(userB.id);

  assert(
    victimAfterFcm.fcmToken === victimBeforeFcm.fcmToken,
    "Injected FCM request leaves victim token unchanged",
    {
      before: victimBeforeFcm.fcmToken,
      after: victimAfterFcm.fcmToken,
    },
  );

  /*
   * ============================================================
   * USER ADDRESS
   * ============================================================
   */

  section("USER PROFILE - ADDRESS AUTHORIZATION");

  response = await requestJson("PATCH", "/user/update/address", {
    token: userA.token,
    body: {
      vill: "Security Village",
      post: "Security Post",
      dist: "Deoria",
      state: "Uttar Pradesh",
      pincode: "274001",
    },
  });

  assertStatus(response, 200, "User can update own address");

  currentUserA = await getUser(userA.id);

  assert(
    currentUserA.pincode === "274001",
    "Address update changes authenticated User pincode",
    currentUserA,
  );

  const victimBeforeAddress = await getUser(userB.id);

  response = await requestJson("PATCH", "/user/update/address", {
    token: userA.token,
    body: {
      userId: userB.id,
      vill: "ATTACK",
      post: "ATTACK",
      dist: "ATTACK",
      state: "ATTACK",
      pincode: "999999",
    },
  });

  assert(
    response.status === 403,
    `User cannot redirect address update using body.userId [HTTP ${response.status}]`,
    response.status === 403 ? undefined : response.data,
  );

  const victimAfterAddress = await getUser(userB.id);

  assert(
    JSON.stringify(normalize(victimAfterAddress.address)) ===
      JSON.stringify(normalize(victimBeforeAddress.address)) &&
      victimAfterAddress.pincode === victimBeforeAddress.pincode,
    "Injected address request leaves victim User unchanged",
    {
      before: pick(victimBeforeAddress, ["address", "pincode"]),
      after: pick(victimAfterAddress, ["address", "pincode"]),
    },
  );

  /*
   * ============================================================
   * USER MASS ASSIGNMENT
   * ============================================================
   */

  section("USER PROFILE - MASS ASSIGNMENT");

  const userProtectedBefore = await getUser(userA.id);

  response = await requestJson("PATCH", "/user/edit/name", {
    token: userA.token,
    body: {
      name: "USER MASS ASSIGNMENT SAFE",
      ...maliciousUserFields(userA.id),
    },
  });

  assertStatus(
    response,
    200,
    "User name endpoint accepts legitimate field with extra hostile fields",
  );

  const userProtectedAfter = await getUser(userA.id);

  assert(
    userProtectedAfter.name === "USER MASS ASSIGNMENT SAFE",
    "Allowed User name field is updated",
    userProtectedAfter.name,
  );

  assert(
    sameProtectedFields(userProtectedBefore, userProtectedAfter, USER_PROTECTED_FIELDS),
    "User name endpoint cannot mass-assign protected account fields",
    {
      before: pick(userProtectedBefore, USER_PROTECTED_FIELDS),
      after: pick(userProtectedAfter, USER_PROTECTED_FIELDS),
    },
  );

  assert(
    userProtectedAfter.role === undefined &&
      userProtectedAfter.isAdmin === undefined &&
      userProtectedAfter.admin === undefined,
    "Unknown privilege-escalation fields are not persisted to User",
    {
      role: userProtectedAfter.role,
      isAdmin: userProtectedAfter.isAdmin,
      admin: userProtectedAfter.admin,
    },
  );

  /*
   * ============================================================
   * USER ADDRESS MASS ASSIGNMENT
   * ============================================================
   */

  section("USER ADDRESS - MASS ASSIGNMENT");

  const userAddressProtectedBefore = await getUser(userA.id);

  response = await requestJson("PATCH", "/user/update/address", {
    token: userA.token,
    body: {
      vill: "Allowed Village",
      post: "Allowed Post",
      dist: "Allowed District",
      state: "Allowed State",
      pincode: "274002",

      ...maliciousUserFields(userA.id),
    },
  });

  assertStatus(response, 200, "User address endpoint accepts allowed address fields");

  const userAddressProtectedAfter = await getUser(userA.id);

  assert(
    userAddressProtectedAfter.pincode === "274002",
    "Allowed User address fields persist",
    userAddressProtectedAfter.address,
  );

  assert(
    sameProtectedFields(
      userAddressProtectedBefore,
      userAddressProtectedAfter,
      USER_PROTECTED_FIELDS,
    ),
    "User address endpoint cannot mass-assign protected fields",
    {
      before: pick(userAddressProtectedBefore, USER_PROTECTED_FIELDS),
      after: pick(userAddressProtectedAfter, USER_PROTECTED_FIELDS),
    },
  );

  /*
   * ============================================================
   * VENDOR AUTHENTICATION
   * ============================================================
   */

  section("VENDOR PROFILE - MISSING / INVALID JWT");

  response = await requestJson("PATCH", "/vendor/edit/name", {
    body: {
      name: "UNAUTHORIZED VENDOR",
    },
  });

  assertUnauthorized(response, "Missing JWT cannot update Vendor name");

  response = await requestJson("PATCH", "/vendor/edit/name", {
    headers: invalidAuthHeader(),
    body: {
      name: "INVALID JWT VENDOR",
    },
  });

  assertUnauthorized(response, "Invalid JWT cannot update Vendor name");

  /*
   * ============================================================
   * VENDOR CROSS ROLE
   * ============================================================
   */

  section("VENDOR PROFILE - USER JWT CROSS ROLE");

  const vendorBeforeCrossRole = await getVendor(vendorA.id);

  response = await requestJson("PATCH", "/vendor/edit/name", {
    token: userA.token,
    body: {
      vendorId: vendorA.id,
      name: "USER ATTACKING VENDOR",
    },
  });

  assertForbiddenOrUnauthorized(response, "User JWT cannot mutate Vendor profile");

  const vendorAfterCrossRole = await getVendor(vendorA.id);

  assert(
    vendorAfterCrossRole.name === vendorBeforeCrossRole.name,
    "User cross-role request leaves Vendor name unchanged",
    {
      before: vendorBeforeCrossRole.name,
      after: vendorAfterCrossRole.name,
    },
  );

  /*
   * ============================================================
   * VENDOR NAME
   * ============================================================
   */

  section("VENDOR PROFILE - LEGITIMATE NAME UPDATE");

  response = await requestJson("PATCH", "/vendor/edit/name", {
    token: vendorA.token,
    body: {
      name: "PROFILE AUTH VENDOR A UPDATED",
    },
  });

  assertStatus(response, 200, "Vendor can update own name");

  let currentVendorA = await getVendor(vendorA.id);

  assert(
    currentVendorA.name === "PROFILE AUTH VENDOR A UPDATED",
    "Vendor name update belongs to JWT Vendor",
    currentVendorA,
  );

  /*
   * Vendor controller does not consume body.vendorId.
   *
   * Therefore the secure behavior is NOT necessarily 403.
   * It is acceptable for the endpoint to ignore vendorId and
   * mutate the JWT owner.
   */

  section("VENDOR PROFILE - BODY VENDOR ID INJECTION");

  const vendorVictimBefore = await getVendor(vendorB.id);

  response = await requestJson("PATCH", "/vendor/edit/name", {
    token: vendorA.token,
    body: {
      vendorId: vendorB.id,
      name: "VENDOR JWT OWNER NAME",
    },
  });

  assert(
    response.status >= 200 && response.status < 300,
    `Injected body.vendorId cannot prevent JWT-authorized self update [HTTP ${response.status}]`,
    response.status >= 200 && response.status < 300 ? undefined : response.data,
  );

  currentVendorA = await getVendor(vendorA.id);

  const vendorVictimAfter = await getVendor(vendorB.id);

  assert(
    currentVendorA.name === "VENDOR JWT OWNER NAME",
    "Injected vendorId still updates JWT Vendor",
    currentVendorA.name,
  );

  assert(
    vendorVictimAfter.name === vendorVictimBefore.name,
    "Injected vendorId cannot modify victim Vendor",
    {
      before: vendorVictimBefore.name,
      after: vendorVictimAfter.name,
    },
  );

  /*
   * ============================================================
   * VENDOR FCM
   * ============================================================
   */

  section("VENDOR PROFILE - FCM TOKEN");

  response = await requestJson("PATCH", "/vendor/edit/fcmToken", {
    token: vendorA.token,
    body: {
      vendorId: vendorB.id,
      fcmToken: "VENDOR_A_SECURE_FCM",
    },
  });

  assertStatus(response, 200, "Vendor can update own FCM token despite injected vendorId");

  currentVendorA = await getVendor(vendorA.id);

  const vendorBPostFcm = await getVendor(vendorB.id);

  assert(
    currentVendorA.fcmToken === "VENDOR_A_SECURE_FCM",
    "FCM token belongs to authenticated Vendor",
    currentVendorA.fcmToken,
  );

  assert(
    vendorBPostFcm.fcmToken === vendorVictimAfter.fcmToken,
    "Injected vendorId cannot change victim Vendor FCM token",
    {
      before: vendorVictimAfter.fcmToken,
      after: vendorBPostFcm.fcmToken,
    },
  );

  /*
   * ============================================================
   * VENDOR ADDRESS
   * ============================================================
   */

  section("VENDOR PROFILE - ADDRESS");

  const vendorBBeforeAddress = await getVendor(vendorB.id);

  response = await requestJson("PATCH", "/vendor/update/address", {
    token: vendorA.token,
    body: {
      vendorId: vendorB.id,

      vill: "Vendor Security Village",
      post: "Vendor Security Post",
      dist: "Deoria",
      state: "Uttar Pradesh",
      pincode: "274003",
    },
  });

  assertStatus(response, 200, "Vendor can update own address");

  currentVendorA = await getVendor(vendorA.id);

  const vendorBAfterAddress = await getVendor(vendorB.id);

  assert(
    currentVendorA.pincode === "274003",
    "Vendor address update belongs to JWT Vendor",
    currentVendorA,
  );

  assert(
    JSON.stringify(normalize(vendorBAfterAddress.address)) ===
      JSON.stringify(normalize(vendorBBeforeAddress.address)) &&
      vendorBAfterAddress.pincode === vendorBBeforeAddress.pincode,
    "Injected vendorId cannot modify victim Vendor address",
    {
      before: pick(vendorBBeforeAddress, ["address", "pincode"]),
      after: pick(vendorBAfterAddress, ["address", "pincode"]),
    },
  );

  /*
   * ============================================================
   * VENDOR WAGE RATE
   * ============================================================
   */

  section("VENDOR PROFILE - WAGE RATE AUTHORIZATION");

  const vendorBBeforeWage = await getVendor(vendorB.id);

  response = await requestJson("PATCH", "/vendor/wageRate", {
    token: vendorA.token,
    body: {
      vendorId: vendorB.id,
      wageRate: 777,
      wageRateType: "daily",
    },
  });

  assertStatus(response, 200, "Vendor can update own wage rate");

  currentVendorA = await getVendor(vendorA.id);

  const vendorBAfterWage = await getVendor(vendorB.id);

  assert(
    Number(currentVendorA.wageRate) === 777,
    "Wage rate update belongs to authenticated Vendor",
    {
      wageRate: currentVendorA.wageRate,
      wageRateType: currentVendorA.wageRateType,
    },
  );

  assert(
    vendorBAfterWage.wageRate === vendorBBeforeWage.wageRate &&
      vendorBAfterWage.wageRateType === vendorBBeforeWage.wageRateType,
    "Injected vendorId cannot change victim Vendor wage rate",
    {
      before: pick(vendorBBeforeWage, ["wageRate", "wageRateType"]),
      after: pick(vendorBAfterWage, ["wageRate", "wageRateType"]),
    },
  );

  /*
   * ============================================================
   * VENDOR MASS ASSIGNMENT
   * ============================================================
   */

  section("VENDOR PROFILE - MASS ASSIGNMENT");

  const vendorProtectedBefore = await getVendor(vendorA.id);

  response = await requestJson("PATCH", "/vendor/edit/name", {
    token: vendorA.token,
    body: {
      name: "VENDOR MASS ASSIGNMENT SAFE",
      ...maliciousVendorFields(vendorA.id),
    },
  });

  assertStatus(
    response,
    200,
    "Vendor name endpoint accepts legitimate field with hostile extra fields",
  );

  const vendorProtectedAfter = await getVendor(vendorA.id);

  assert(
    vendorProtectedAfter.name === "VENDOR MASS ASSIGNMENT SAFE",
    "Allowed Vendor name field is updated",
    vendorProtectedAfter.name,
  );

  assert(
    sameProtectedFields(vendorProtectedBefore, vendorProtectedAfter, VENDOR_PROTECTED_FIELDS),
    "Vendor name endpoint cannot mass-assign protected account fields",
    {
      before: pick(vendorProtectedBefore, VENDOR_PROTECTED_FIELDS),
      after: pick(vendorProtectedAfter, VENDOR_PROTECTED_FIELDS),
    },
  );

  assert(
    vendorProtectedAfter.role === undefined &&
      vendorProtectedAfter.isAdmin === undefined &&
      vendorProtectedAfter.admin === undefined,
    "Unknown privilege-escalation fields are not persisted to Vendor",
    {
      role: vendorProtectedAfter.role,
      isAdmin: vendorProtectedAfter.isAdmin,
      admin: vendorProtectedAfter.admin,
    },
  );

  /*
   * ============================================================
   * VENDOR WAGE MASS ASSIGNMENT
   * ============================================================
   */

  section("VENDOR WAGE RATE - MASS ASSIGNMENT");

  const vendorWageProtectedBefore = await getVendor(vendorA.id);

  response = await requestJson("PATCH", "/vendor/wageRate", {
    token: vendorA.token,
    body: {
      wageRate: 888,
      wageRateType: "daily",

      ...maliciousVendorFields(vendorA.id),
    },
  });

  assertStatus(response, 200, "Vendor wage-rate endpoint accepts legitimate wage fields");

  const vendorWageProtectedAfter = await getVendor(vendorA.id);

  assert(
    Number(vendorWageProtectedAfter.wageRate) === 888,
    "Allowed wageRate persists",
    vendorWageProtectedAfter.wageRate,
  );

  assert(
    sameProtectedFields(
      vendorWageProtectedBefore,
      vendorWageProtectedAfter,
      VENDOR_PROTECTED_FIELDS,
    ),
    "Wage-rate endpoint cannot mass-assign protected Vendor fields",
    {
      before: pick(vendorWageProtectedBefore, VENDOR_PROTECTED_FIELDS),
      after: pick(vendorWageProtectedAfter, VENDOR_PROTECTED_FIELDS),
    },
  );

  /*
   * ============================================================
   * VICTIM INTEGRITY
   * ============================================================
   */

  section("CROSS-ACCOUNT INTEGRITY");

  const finalUserB = await getUser(userB.id);
  const finalVendorB = await getVendor(vendorB.id);

  assert(
    finalUserB.name === victimUserBefore.name,
    "Victim User name survives all attack attempts",
    {
      expected: victimUserBefore.name,
      actual: finalUserB.name,
    },
  );

  assert(
    finalVendorB.name === vendorVictimBefore.name,
    "Victim Vendor name survives all attack attempts",
    {
      expected: vendorVictimBefore.name,
      actual: finalVendorB.name,
    },
  );

  assert(
    sameProtectedFields(victimUserBefore, finalUserB, USER_PROTECTED_FIELDS),
    "Victim User protected financial/accounting fields remain unchanged",
    {
      before: pick(victimUserBefore, USER_PROTECTED_FIELDS),
      after: pick(finalUserB, USER_PROTECTED_FIELDS),
    },
  );

  assert(
    sameProtectedFields(vendorVictimBefore, finalVendorB, VENDOR_PROTECTED_FIELDS),
    "Victim Vendor protected financial/accounting fields remain unchanged",
    {
      before: pick(vendorVictimBefore, VENDOR_PROTECTED_FIELDS),
      after: pick(finalVendorB, VENDOR_PROTECTED_FIELDS),
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
 * ENTRYPOINT
 * ============================================================
 */

(async () => {
  try {
    await run();
  } catch (error) {
    suiteCrashed = true;
    failed += 1;

    console.error("\nTEST SUITE CRASHED");
    console.error(error);
  } finally {
    try {
      if (mongoose.connection.readyState !== 0) {
        await cleanup();
        await mongoose.disconnect();
        console.log("\nMongoDB disconnected.");
      }
    } catch (cleanupError) {
      suiteCrashed = true;
      failed += 1;

      console.error("Cleanup failed:");
      console.error(cleanupError);
    }

    section("FINAL PROFILE MUTATION SECURITY TEST SUMMARY");

    console.log(`Assertions: ${assertions}`);
    console.log(`Passed: ${passed}`);
    console.log(`Failed: ${failed}`);

    if (suiteCrashed || failed > 0) {
      section(`FAIL: ${failed} PROFILE MUTATION SECURITY TEST(S) FAILED`);

      console.error(`
IMPORTANT:

A failure here may indicate:

1. Broken Object Level Authorization / IDOR
2. Cross-role authorization bypass
3. Mass-assignment vulnerability
4. Financial/accounting field manipulation
5. Privilege-field injection
6. Profile mutation applied to the wrong account

The authoritative identity for authenticated profile mutations
must come from:

    req.auth.id

Never trust:

    req.body.userId
    req.body.vendorId

to determine which authenticated account should be modified.

Controllers/services should explicitly whitelist writable fields.

DO NOT weaken this test merely to accept an unauthorized mutation.
`);

      process.exitCode = 1;
      return;
    }

    section("PASS: PROFILE MUTATION AUTHORIZATION SECURITY TESTS PASSED");

    console.log(`
Verified:

✓ Missing JWT cannot mutate profiles

✓ Invalid JWT cannot mutate profiles

✓ Vendor JWT cannot mutate User profile

✓ User JWT cannot mutate Vendor profile

✓ User can update own allowed profile fields

✓ Vendor can update own allowed profile fields

✓ JWT identity determines mutation ownership

✓ body.userId cannot redirect User mutations

✓ body.vendorId cannot redirect Vendor mutations

✓ User protected financial/accounting fields resist mass assignment

✓ Vendor protected financial/accounting fields resist mass assignment

✓ Privilege-like fields are not persisted

✓ Victim User remains unchanged after IDOR attempts

✓ Victim Vendor remains unchanged after IDOR attempts

✓ Vendor wageRate mutation belongs only to authenticated Vendor

✓ MongoDB state confirms authorization boundaries
`);
  }
})();
