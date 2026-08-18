"use strict";

/**
 * ============================================================
 * OTP / ACCOUNT MUTATION / ACCOUNT TAKEOVER E2E SECURITY TEST
 * ============================================================
 *
 * PURPOSE
 * -------
 * Security-test OTP-protected account mutations for:
 *
 * - User email mutation
 * - User phone mutation (if route exists)
 * - User password reset
 * - Vendor email mutation
 * - Vendor phone mutation (if route exists)
 * - Vendor password reset
 *
 * ATTACKS TESTED
 * --------------
 * 1. Missing/invalid authentication on authenticated mutations
 * 2. Cross-role access
 * 3. body.userId / body.vendorId IDOR
 * 4. Wrong OTP verification type
 * 5. Unverified OTP
 * 6. Missing/nonexistent/malformed otpId
 * 7. Cross-account OTP reuse
 * 8. Cross-role OTP reuse
 * 9. Password-reset target substitution
 * 10. OTP replay
 * 11. Victim-state integrity
 *
 * IMPORTANT
 * ---------
 * This test intentionally creates VERIFIED OtpAuth records directly
 * in MongoDB.
 *
 * It DOES NOT send real SMS/email OTPs.
 *
 * This isolates authorization-after-verification from OTP delivery.
 *
 * Some tests MAY FAIL against the current implementation.
 * A failure can represent a real security vulnerability.
 *
 * NEVER RUN IN PRODUCTION.
 *
 * Run:
 *
 * NODE_ENV=development ALLOW_AUTHORIZATION_TEST=1 \
 * node tests/otp-account-security-e2e-test.js
 * ============================================================
 */

const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const ENV = require("../src/config/env");

const User = require("../models/user");
const Vendor = require("../models/vendor");
const OtpAuth = require("../models/otpAuth");

/*
 * ============================================================
 * CONFIG
 * ============================================================
 */

const API =
  process.env.OTP_SECURITY_TEST_API || process.env.API_BASE_URL || "http://localhost:3000/api";

const DEFAULT_PASSWORD = "Test@123456";
const NEW_PASSWORD = "Changed@987654";
const ATTACK_PASSWORD = "Pwned@987654";

let sequence = 0;

const createdUsers = [];
const createdVendors = [];
const createdOtps = [];

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
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function assert(condition, message, details = "") {
  assertions += 1;

  if (condition) {
    passed += 1;
    console.log(`✓ ${message}`);
    return true;
  }

  failed += 1;
  console.error(`✗ ${message}`);

  if (details) {
    console.error(`  ${details}`);
  }

  return false;
}

function assertHttp(response, allowedStatuses, message) {
  const allowed = Array.isArray(allowedStatuses) ? allowedStatuses : [allowedStatuses];

  return assert(
    allowed.includes(response.status),
    `${message} [HTTP ${response.status}]`,
    `Expected: ${allowed.join(", ")} | Response: ${safeString(response.data)}`,
  );
}

function assertRejected(response, message) {
  return assert(
    response.status >= 400 && response.status < 500,
    `${message} [HTTP ${response.status}]`,
    `Expected controlled 4xx rejection | Response: ${safeString(response.data)}`,
  );
}

function assertNot500(response, message) {
  return assert(
    response.status !== 500,
    `${message} [HTTP ${response.status}]`,
    `Response: ${safeString(response.data)}`,
  );
}

/*
 * ============================================================
 * RANDOM TEST DATA
 * ============================================================
 */

function nextPhone() {
  sequence += 1;

  /*
   * Keep generated number in a normal Indian mobile-looking range.
   */
  const suffix = String((Date.now() % 1000000) + sequence)
    .padStart(6, "0")
    .slice(-6);

  return `98${String(sequence % 100).padStart(2, "0")}${suffix}`;
}

function nextEmail(label = "otp") {
  sequence += 1;

  const safe = String(label)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

  return `${safe}.${Date.now()}.${sequence}@example.test`;
}

/*
 * ============================================================
 * HTTP
 * ============================================================
 */

async function requestJson(method, path, options = {}) {
  const { token, body } = options;

  const headers = {
    Accept: "application/json",
  };

  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  try {
    const response = await fetch(`${API}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

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
  } catch (error) {
    throw new Error(`HTTP request failed: ${method} ${path}\n${error.message}`);
  }
}

/*
 * ============================================================
 * RESPONSE EXTRACTION
 * ============================================================
 */

function extractToken(response) {
  const data = response?.data;

  if (!data || typeof data !== "object") {
    return null;
  }

  return (
    data.token ||
    data.accessToken ||
    data.jwt ||
    data?.data?.token ||
    data?.data?.accessToken ||
    data?.user?.token ||
    data?.vendor?.token ||
    null
  );
}

function extractId(response, kind) {
  const data = response?.data;

  if (!data || typeof data !== "object") {
    return null;
  }

  const candidates =
    kind === "user"
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

  return candidates.find(Boolean) || null;
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
 * SAFETY
 * ============================================================
 */

function enforceSafety() {
  const nodeEnv = process.env.NODE_ENV;

  if (nodeEnv === "production") {
    throw new Error("REFUSING TO RUN: OTP security test cannot run in production.");
  }

  if (process.env.ALLOW_AUTHORIZATION_TEST !== "1") {
    throw new Error("REFUSING TO RUN: set ALLOW_AUTHORIZATION_TEST=1 explicitly.");
  }
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
    id: String(userId),
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
    id: String(vendorId),
    phoneNo,
    email,
    token,
  };
}

/*
 * ============================================================
 * OTP FACTORIES
 * ============================================================
 */

async function createOtp({ accountType, accountId, target, purpose, verified = true }) {
  const otp = await OtpAuth.create({
    otp: "123456",

    purpose,
    accountType,
    accountId,

    // Normalize the same way production code should.
    target: String(target).trim().toLowerCase(),

    verified,

    // Keep legacy flags if they still exist in your schema/service.
    verifiedEmail: verified && ["verify_email", "change_email", "reset_password"].includes(purpose),

    verifiedNumber: verified && ["verify_phone", "change_phone"].includes(purpose),

    consumedAt: null,
  });

  createdOtps.push(String(otp._id));

  return otp;
}

async function createEmailOtp(account, options = {}) {
  return createOtp({
    accountType: account.kind,
    accountId: account.id,
    target: options.target || account.email,
    purpose: options.purpose || "change_email",
    verified: options.verified ?? true,
  });
}

async function createPhoneOtp(account, options = {}) {
  return createOtp({
    accountType: account.kind,
    accountId: account.id,
    target: options.target || String(account.phoneNo),
    purpose: options.purpose || "change_phone",
    verified: options.verified ?? true,
  });
}

async function createPasswordResetOtp(account, options = {}) {
  return createOtp({
    accountType: account.kind,
    accountId: account.id,
    target: options.target || account.email,
    purpose: "reset_password",
    verified: options.verified ?? true,
  });
}

async function createUnverifiedOtp(account) {
  return createOtp({
    accountType: account.kind,
    accountId: account.id,
    target: account.email,
    purpose: "change_email",
    verified: false,
  });
}

/*
 * ============================================================
 * PASSWORD HELPERS
 * ============================================================
 */

async function userPasswordHash(userId) {
  const doc = await User.findById(userId).select("+password password").lean();

  return doc?.password || null;
}

async function vendorPasswordHash(vendorId) {
  const doc = await Vendor.findById(vendorId).select("+password password").lean();

  return doc?.password || null;
}

async function passwordMatchesUser(userId, plainText) {
  const hash = await userPasswordHash(userId);

  if (!hash) {
    return false;
  }

  return bcrypt.compare(plainText, hash);
}

async function passwordMatchesVendor(vendorId, plainText) {
  const hash = await vendorPasswordHash(vendorId);

  if (!hash) {
    return false;
  }

  return bcrypt.compare(plainText, hash);
}

/*
 * ============================================================
 * TESTS
 * ============================================================
 */

async function runTests() {
  section("OTP / ACCOUNT MUTATION / ACCOUNT TAKEOVER E2E SECURITY TEST");

  console.log({
    api: API,
    nodeEnv: process.env.NODE_ENV,
  });

  /*
   * ----------------------------------------------------------
   * ACCOUNTS
   * ----------------------------------------------------------
   */

  const userA = await signupAndLoginUser("OTP User A");
  const userB = await signupAndLoginUser("OTP User Victim");

  const vendorA = await signupAndLoginVendor("OTP Vendor A");
  const vendorB = await signupAndLoginVendor("OTP Vendor Victim");

  /*
   * ----------------------------------------------------------
   * OTP RECORDS
   * ----------------------------------------------------------
   */
  const userEmailOtp = await createEmailOtp(userA);
  const userPhoneOtp = await createPhoneOtp(userA);

  const vendorEmailOtp = await createEmailOtp(vendorA);
  const vendorPhoneOtp = await createPhoneOtp(vendorA);

  const unverifiedOtp = await createUnverifiedOtp(userA);

  /*
   * ==========================================================
   * USER EMAIL - AUTHENTICATION
   * ==========================================================
   */

  section("USER EMAIL - AUTHENTICATION");

  {
    const response = await requestJson("PATCH", "/user/edit/email", {
      body: {
        userId: userA.id,
        email: nextEmail("missingjwt"),
        otpId: String(userEmailOtp._id),
      },
    });

    assertHttp(response, 401, "Missing JWT cannot update User email");
  }

  {
    const response = await requestJson("PATCH", "/user/edit/email", {
      token: "invalid.jwt.token",
      body: {
        userId: userA.id,
        email: nextEmail("invalidjwt"),
        otpId: String(userEmailOtp._id),
      },
    });

    assertHttp(response, 401, "Invalid JWT cannot update User email");
  }

  /*
   * ==========================================================
   * USER EMAIL - CROSS ROLE
   * ==========================================================
   */

  section("USER EMAIL - CROSS ROLE");

  {
    const before = await User.findById(userA.id).select("email").lean();

    const response = await requestJson("PATCH", "/user/edit/email", {
      token: vendorA.token,
      body: {
        userId: userA.id,
        email: nextEmail("vendorattack"),
        otpId: String(userEmailOtp._id),
      },
    });

    assertRejected(response, "Vendor JWT cannot update User email");

    const after = await User.findById(userA.id).select("email").lean();

    assert(after.email === before.email, "Vendor cross-role email attack leaves User unchanged");
  }

  /*
   * ==========================================================
   * USER EMAIL - WRONG OTP TYPE
   * ==========================================================
   */

  section("USER EMAIL - OTP TYPE");

  {
    const before = await User.findById(userA.id).select("email").lean();

    const response = await requestJson("PATCH", "/user/edit/email", {
      token: userA.token,
      body: {
        userId: userA.id,
        email: nextEmail("wrongtype"),
        otpId: String(userPhoneOtp._id),
      },
    });

    assertRejected(response, "Phone-verified OTP cannot authorize User email mutation");

    const after = await User.findById(userA.id).select("email").lean();

    assert(after.email === before.email, "Wrong OTP type leaves User email unchanged");
  }

  {
    const before = await User.findById(userA.id).select("email").lean();

    const response = await requestJson("PATCH", "/user/edit/email", {
      token: userA.token,
      body: {
        userId: userA.id,
        email: nextEmail("unverified"),
        otpId: String(unverifiedOtp._id),
      },
    });

    assertRejected(response, "Unverified OTP cannot authorize User email mutation");

    const after = await User.findById(userA.id).select("email").lean();

    assert(after.email === before.email, "Unverified OTP leaves User email unchanged");
  }

  /*
   * ==========================================================
   * USER EMAIL - IDOR
   * ==========================================================
   */

  section("USER EMAIL - BODY USER ID INJECTION");

  {
    const victimBefore = await User.findById(userB.id).select("email").lean();

    const maliciousEmail = nextEmail("useridor");

    const response = await requestJson("PATCH", "/user/edit/email", {
      token: userA.token,
      body: {
        userId: userB.id,
        email: maliciousEmail,
        otpId: String(userEmailOtp._id),
      },
    });

    /*
     * SECURITY EXPECTATION:
     *
     * User A must NEVER be able to update User B merely by
     * supplying B's userId.
     */
    assertRejected(response, "User cannot redirect email mutation using victim userId");

    const victimAfter = await User.findById(userB.id).select("email").lean();

    assert(
      victimAfter.email === victimBefore.email,
      "Injected userId leaves victim User email unchanged",
      `Before=${victimBefore.email}, After=${victimAfter.email}`,
    );
  }

  /*
   * ==========================================================
   * USER EMAIL - LEGITIMATE
   * ==========================================================
   */

  section("USER EMAIL - LEGITIMATE MUTATION");

  {
    const legitimateEmail = nextEmail("legitimateuser");

    const otp = await createEmailOtp(userA, {
      target: legitimateEmail,
      purpose: "change_email",
    });

    const response = await requestJson("PATCH", "/user/edit/email", {
      token: userA.token,
      body: {
        userId: userA.id,
        email: legitimateEmail,
        otpId: String(otp._id),
      },
    });

    assertHttp(response, 200, "User can update own email using verified email OTP");

    const after = await User.findById(userA.id).select("email").lean();

    assert(after.email === legitimateEmail, "Legitimate User email mutation persists");

    userA.email = legitimateEmail;
  }

  /*
   * ==========================================================
   * USER OTP - INVALID IDENTIFIERS
   * ==========================================================
   */

  section("USER EMAIL - INVALID OTP IDENTIFIERS");

  {
    const response = await requestJson("PATCH", "/user/edit/email", {
      token: userA.token,
      body: {
        userId: userA.id,
        email: nextEmail("badotpid"),
        otpId: "not-a-mongodb-object-id",
      },
    });

    assertRejected(response, "Malformed otpId is rejected");

    assertNot500(response, "Malformed otpId must not become HTTP 500");
  }

  {
    const nonexistentId = new mongoose.Types.ObjectId();

    const response = await requestJson("PATCH", "/user/edit/email", {
      token: userA.token,
      body: {
        userId: userA.id,
        email: nextEmail("missingotp"),
        otpId: String(nonexistentId),
      },
    });

    assertRejected(response, "Nonexistent otpId is rejected");

    assertNot500(response, "Nonexistent otpId must not become HTTP 500");
  }

  /*
   * ==========================================================
   * VENDOR EMAIL - AUTHENTICATION
   * ==========================================================
   */

  section("VENDOR EMAIL - AUTHENTICATION");

  {
    const response = await requestJson("PATCH", "/vendor/edit/email", {
      body: {
        email: nextEmail("vendormissingjwt"),
        otpId: String(vendorEmailOtp._id),
      },
    });

    assertHttp(response, 401, "Missing JWT cannot update Vendor email");
  }

  {
    const before = await Vendor.findById(vendorA.id).select("email").lean();

    const response = await requestJson("PATCH", "/vendor/edit/email", {
      token: userA.token,
      body: {
        email: nextEmail("usercrossrole"),
        otpId: String(vendorEmailOtp._id),
      },
    });

    assertRejected(response, "User JWT cannot update Vendor email");

    const after = await Vendor.findById(vendorA.id).select("email").lean();

    assert(after.email === before.email, "User cross-role attack leaves Vendor email unchanged");
  }

  /*
   * ==========================================================
   * VENDOR EMAIL - BODY ID INJECTION
   * ==========================================================
   */

  section("VENDOR EMAIL - BODY VENDOR ID INJECTION");

  {
    const attackerBefore = await Vendor.findById(vendorA.id).select("email").lean();

    const victimBefore = await Vendor.findById(vendorB.id).select("email").lean();

    const newEmail = nextEmail("vendorinjection");

    const otp = await createEmailOtp(vendorA);

    const response = await requestJson("PATCH", "/vendor/edit/email", {
      token: vendorA.token,
      body: {
        vendorId: vendorB.id,
        email: newEmail,
        otpId: String(otp._id),
      },
    });

    /*
     * Vendor controller currently derives vendorId from req.auth.id.
     *
     * Therefore injected vendorId should be ignored and Vendor A
     * should be the only possible mutation target.
     */
    assertHttp(response, 200, "Injected vendorId cannot redirect Vendor email mutation");

    const attackerAfter = await Vendor.findById(vendorA.id).select("email").lean();

    const victimAfter = await Vendor.findById(vendorB.id).select("email").lean();

    assert(attackerAfter.email === newEmail, "JWT Vendor receives authorized email mutation");

    assert(
      victimAfter.email === victimBefore.email,
      "Injected vendorId cannot modify victim Vendor",
    );

    vendorA.email = newEmail;

    /*
     * Keep reference alive for diagnostics.
     */
    void attackerBefore;
  }

  /*
   * ==========================================================
   * PASSWORD RESET - USER TARGET SUBSTITUTION
   * ==========================================================
   */

  section("USER PASSWORD RESET - OTP TARGET BINDING");

  {
    const victimHashBefore = await userPasswordHash(userB.id);

    /*
     * This simulates:
     *
     *   attacker has SOME verifiedEmail OTP
     *              +
     *   attacker supplies VICTIM email
     *
     * Secure design MUST bind OTP to the actual verified target.
     */
    const attackerOtp = await createPasswordResetOtp(userA);

    const response = await requestJson("PATCH", "/user/edit/password", {
      body: {
        email: userB.email,
        password: ATTACK_PASSWORD,
        otpId: String(attackerOtp._id),
      },
    });

    const victimHashAfter = await userPasswordHash(userB.id);

    const victimPasswordCompromised = await passwordMatchesUser(userB.id, ATTACK_PASSWORD);

    assertRejected(response, "Arbitrary verified-email OTP cannot reset victim User password");

    assert(
      victimHashAfter === victimHashBefore,
      "Victim User password hash remains unchanged after OTP substitution attack",
    );

    assert(
      victimPasswordCompromised === false,
      "Victim User password was not changed to attacker-controlled password",
    );
  }

  /*
   * ==========================================================
   * PASSWORD RESET - VENDOR TARGET SUBSTITUTION
   * ==========================================================
   */

  section("VENDOR PASSWORD RESET - OTP TARGET BINDING");

  {
    const victimHashBefore = await vendorPasswordHash(vendorB.id);

    const attackerOtp = await createPasswordResetOtp(vendorA);

    const response = await requestJson("PATCH", "/vendor/edit/password", {
      body: {
        email: vendorB.email,
        password: ATTACK_PASSWORD,
        otpId: String(attackerOtp._id),
      },
    });

    const victimHashAfter = await vendorPasswordHash(vendorB.id);

    const victimPasswordCompromised = await passwordMatchesVendor(vendorB.id, ATTACK_PASSWORD);

    assertRejected(response, "Arbitrary verified-email OTP cannot reset victim Vendor password");

    assert(
      victimHashAfter === victimHashBefore,
      "Victim Vendor password hash remains unchanged after OTP substitution attack",
    );

    assert(
      victimPasswordCompromised === false,
      "Victim Vendor password was not changed to attacker-controlled password",
    );
  }

  /*
   * ==========================================================
   * CROSS-ROLE OTP REUSE
   * ==========================================================
   */

  section("PASSWORD RESET - CROSS ROLE OTP REUSE");

  {
    const victimHashBefore = await vendorPasswordHash(vendorB.id);

    const userContextOtp = await createPasswordResetOtp(userA);

    const response = await requestJson("PATCH", "/vendor/edit/password", {
      body: {
        email: vendorB.email,
        password: ATTACK_PASSWORD,
        otpId: String(userContextOtp._id),
      },
    });
    const victimHashAfter = await vendorPasswordHash(vendorB.id);

    assertRejected(response, "Generic/User-context OTP cannot authorize Vendor password reset");

    assert(
      victimHashAfter === victimHashBefore,
      "Cross-role OTP reuse leaves Vendor password unchanged",
    );
  }

  /*
   * ==========================================================
   * OTP REPLAY
   * ==========================================================
   */

  section("OTP REPLAY");

  {
    const firstEmail = nextEmail("replayone");
    const secondEmail = nextEmail("replaytwo");

    const otp = await createEmailOtp(userA, {
      target: firstEmail,
      purpose: "change_email",
    });

    const first = await requestJson("PATCH", "/user/edit/email", {
      token: userA.token,
      body: {
        userId: userA.id,
        email: firstEmail,
        otpId: String(otp._id),
      },
    });

    assertHttp(first, 200, "First use of verified OTP succeeds");

    const second = await requestJson("PATCH", "/user/edit/email", {
      token: userA.token,
      body: {
        userId: userA.id,
        email: secondEmail,
        otpId: String(otp._id),
      },
    });

    /*
     * A secure sensitive-action OTP should normally be one-time.
     */
    assertRejected(second, "Verified OTP cannot be replayed for second sensitive mutation");

    const after = await User.findById(userA.id).select("email").lean();

    assert(
      after.email === firstEmail,
      "OTP replay cannot perform second User email mutation",
      `Current email=${after.email}`,
    );

    userA.email = after.email;
  }

  /*
   * ==========================================================
   * WRONG VERIFICATION TYPE - PASSWORD
   * ==========================================================
   */

  section("PASSWORD RESET - WRONG OTP TYPE");

  {
    const hashBefore = await userPasswordHash(userA.id);

    const phoneOnlyOtp = await createPhoneOtp(userA);

    const response = await requestJson("PATCH", "/user/edit/password", {
      body: {
        email: userA.email,
        password: NEW_PASSWORD,
        otpId: String(phoneOnlyOtp._id),
      },
    });

    assertRejected(response, "Phone-only OTP cannot authorize User password reset");

    const hashAfter = await userPasswordHash(userA.id);

    assert(hashAfter === hashBefore, "Wrong OTP type leaves User password unchanged");
  }

  /*
   * ==========================================================
   * FINAL VICTIM INTEGRITY
   * ==========================================================
   */

  section("FINAL VICTIM ACCOUNT INTEGRITY");

  {
    const userVictim = await User.findById(userB.id).select("email phoneNo password").lean();

    const vendorVictim = await Vendor.findById(vendorB.id).select("email phoneNo password").lean();

    assert(userVictim.email === userB.email, "Victim User email survives all attack attempts");

    assert(userVictim.phoneNo === userB.phoneNo, "Victim User phone survives all attack attempts");

    assert(
      vendorVictim.email === vendorB.email,
      "Victim Vendor email survives all attack attempts",
    );

    assert(
      vendorVictim.phoneNo === vendorB.phoneNo,
      "Victim Vendor phone survives all attack attempts",
    );

    assert(
      !(await passwordMatchesUser(userB.id, ATTACK_PASSWORD)),
      "Victim User password survives account-takeover attempts",
    );

    assert(
      !(await passwordMatchesVendor(vendorB.id, ATTACK_PASSWORD)),
      "Victim Vendor password survives account-takeover attempts",
    );
  }
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
  let otpsDeleted = 0;

  if (createdUsers.length) {
    const result = await User.deleteMany({
      _id: { $in: createdUsers },
    });

    usersDeleted = result.deletedCount || 0;
  }

  if (createdVendors.length) {
    const result = await Vendor.deleteMany({
      _id: { $in: createdVendors },
    });

    vendorsDeleted = result.deletedCount || 0;
  }

  if (createdOtps.length) {
    const result = await OtpAuth.deleteMany({
      _id: { $in: createdOtps },
    });

    otpsDeleted = result.deletedCount || 0;
  }

  console.log({
    usersDeleted,
    vendorsDeleted,
    otpsDeleted,
  });
}

/*
 * ============================================================
 * MAIN
 * ============================================================
 */

async function main() {
  try {
    enforceSafety();

    await connectMongo();

    await runTests();
  } catch (error) {
    suiteCrashed = true;

    console.error("\n========================================");
    console.error("TEST SUITE CRASHED");
    console.error("========================================");

    console.error(error);
  } finally {
    try {
      if (mongoose.connection.readyState === 1) {
        await cleanup();
      }
    } catch (cleanupError) {
      suiteCrashed = true;
      console.error("Cleanup failed:", cleanupError);
    }

    try {
      if (mongoose.connection.readyState !== 0) {
        await mongoose.disconnect();
        console.log("\nMongoDB disconnected.");
      }
    } catch (disconnectError) {
      console.error("MongoDB disconnect failed:", disconnectError);
    }

    section("FINAL OTP SECURITY TEST SUMMARY");

    console.log(`Assertions: ${assertions}`);
    console.log(`Passed: ${passed}`);
    console.log(`Failed: ${failed}`);

    if (suiteCrashed) {
      console.error("\nFAIL: OTP SECURITY TEST SUITE CRASHED");

      process.exitCode = 1;
      return;
    }

    if (failed > 0) {
      console.error("\nFAIL: OTP / ACCOUNT SECURITY VULNERABILITIES DETECTED");

      console.error(`
Expected security guarantees:

✓ Authenticated profile mutation uses JWT identity
✓ OTP is bound to the verified target
✓ Email OTP cannot authorize phone mutation
✓ Phone OTP cannot authorize email/password mutation
✓ OTP cannot be used against another account
✓ OTP cannot cross User/Vendor security contexts
✓ Sensitive OTP is single-use
✓ Victim passwords cannot be reset using unrelated OTP
✓ Failed attacks leave MongoDB state unchanged
`);

      process.exitCode = 1;
      return;
    }

    console.log("\nPASS: OTP / ACCOUNT SECURITY TESTS PASSED");

    console.log(`
Verified:

✓ Missing/invalid JWT cannot mutate authenticated OTP-protected profile fields

✓ Cross-role profile mutation is rejected

✓ JWT identity determines authenticated mutation ownership

✓ OTP verification type is enforced

✓ OTP target binding is enforced

✓ Cross-account OTP reuse is rejected

✓ Cross-role OTP reuse is rejected

✓ Password reset cannot target arbitrary accounts

✓ Sensitive OTP replay is rejected

✓ Victim account state remains unchanged
`);
  }
}

main();
