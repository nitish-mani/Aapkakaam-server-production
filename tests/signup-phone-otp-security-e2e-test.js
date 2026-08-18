"use strict";

/**
 * ============================================================
 * SIGNUP PHONE OTP AUTHORIZATION E2E SECURITY TEST
 * ============================================================
 *
 * PURPOSE
 * -------
 * Verify that User/Vendor signup cannot bypass phone OTP
 * verification and that OTP authorization is:
 *
 * - required
 * - verified
 * - purpose-bound
 * - account-type-bound
 * - phone-target-bound
 * - single-use
 *
 * IMPORTANT
 * ---------
 * This suite DOES NOT send real SMS.
 *
 * OTP authorization documents are inserted directly into the
 * development/test MongoDB database.
 *
 * SAFETY
 * ------
 * NEVER run this against production.
 *
 * Run:
 *
 * NODE_ENV=development ALLOW_AUTHORIZATION_TEST=1 \
 * node tests/signup-phone-otp-security-e2e-test.js
 * ============================================================
 */

const mongoose = require("mongoose");

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
  process.env.ACCOUNT_AUTH_TEST_API || process.env.API_BASE_URL || "http://localhost:3000/api";

const DEFAULT_PASSWORD = "Test@123456";
const TEST_OTP = "123456";

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
    return;
  }

  failed += 1;

  console.error(`✗ ${message}`);

  if (details) {
    console.error(`  ${details}`);
  }
}

function assertStatus(response, expected, message) {
  assert(
    response.status === expected,
    `${message} [HTTP ${response.status}]`,
    `Expected: ${expected} | Response: ${safeString(response.data)}`,
  );
}

function assertControlled4xx(response, message) {
  assert(
    response.status >= 400 && response.status < 500,
    `${message} [HTTP ${response.status}]`,
    `Expected controlled 4xx rejection | Response: ${safeString(response.data)}`,
  );
}

function assertNot500(response, message) {
  assert(
    response.status !== 500,
    `${message} [HTTP ${response.status}]`,
    `Response: ${safeString(response.data)}`,
  );
}

/*
 * ============================================================
 * UNIQUE TEST DATA
 * ============================================================
 */

function nextPhone() {
  /*
   * Keep generated values as valid-looking Indian 10-digit
   * mobile numbers.
   *
   * Start with 9 and vary the final digits.
   */
  sequence += 1;

  const suffix = `${Date.now()}${process.pid}${sequence}`.slice(-9);

  return `9${suffix}`;
}

function label(name) {
  sequence += 1;
  return `${name}-${Date.now()}-${sequence}`;
}

/*
 * ============================================================
 * HTTP
 * ============================================================
 */

async function requestJson(method, path, { body } = {}) {
  const options = {
    method,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
  };

  if (body !== undefined) {
    options.body = JSON.stringify(body);
  }

  try {
    const response = await fetch(`${API}${path}`, options);

    let data;

    const text = await response.text();

    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }

    return {
      status: response.status,
      data,
    };
  } catch (error) {
    throw new Error(
      [
        `HTTP request failed: ${method} ${API}${path}`,
        error.message,
        "",
        "Make sure the backend is running before executing this suite.",
      ].join("\n"),
    );
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
 * SAFETY
 * ============================================================
 */

function assertSafeEnvironment() {
  if (process.env.ALLOW_AUTHORIZATION_TEST !== "1") {
    throw new Error(
      [
        "Authorization security tests are disabled.",
        "",
        "Run with:",
        "",
        "ALLOW_AUTHORIZATION_TEST=1",
      ].join("\n"),
    );
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error("Refusing to run signup OTP security tests in production.");
  }
}

/*
 * ============================================================
 * OTP HELPERS
 * ============================================================
 */

async function createOtp({
  phoneNo,
  accountType,
  verified = false,
  consumed = false,
  purpose = "verify_phone",
}) {
  const otp = await OtpAuth.create({
    otp: TEST_OTP,

    purpose,

    accountType,

    accountId: null,

    target: String(phoneNo).trim().replace(/\s+/g, ""),

    verified,

    consumedAt: consumed ? new Date() : null,
  });

  createdOtps.push(String(otp._id));

  return otp;
}

/*
 * ============================================================
 * SIGNUP BODY HELPERS
 * ============================================================
 */

function userSignupBody({ phoneNo, otpId, name = label("OTP Security User") } = {}) {
  const body = {
    name,
    phoneNo,
    password: DEFAULT_PASSWORD,
    gender: "male",
    fcmToken: "",
    agreedToTnCnP: true,
  };

  if (otpId !== undefined) {
    body.validPhoneNoId = otpId;
  }

  return body;
}

function vendorSignupBody({ phoneNo, otpId, name = label("OTP Security Vendor") } = {}) {
  const body = {
    name,
    phoneNo,
    password: DEFAULT_PASSWORD,

    type: "four wheeler",
    experience: 1,
    gender: "male",

    fcmToken: "",
    agreedToTnCnP: true,
  };

  if (otpId !== undefined) {
    body.validPhoneNoId = otpId;
  }

  return body;
}

/*
 * ============================================================
 * DB STATE HELPERS
 * ============================================================
 */

async function userByPhone(phoneNo) {
  return User.findOne({
    phoneNo,
  }).lean();
}

async function vendorByPhone(phoneNo) {
  return Vendor.findOne({
    phoneNo,
  }).lean();
}

async function refreshOtp(otpId) {
  return OtpAuth.findById(otpId).lean();
}

async function trackCreatedAccount(phoneNo) {
  const [user, vendor] = await Promise.all([
    User.findOne({ phoneNo }).select("_id").lean(),
    Vendor.findOne({ phoneNo }).select("_id").lean(),
  ]);

  if (user) {
    createdUsers.push(String(user._id));
  }

  if (vendor) {
    createdVendors.push(String(vendor._id));
  }
}

/*
 * ============================================================
 * TESTS
 * ============================================================
 */

async function runTests() {
  /*
   * ==========================================================
   * USER - MISSING OTP
   * ==========================================================
   */

  section("USER SIGNUP - MISSING OTP");

  {
    const phoneNo = nextPhone();

    const response = await requestJson("POST", "/user/signup", {
      body: userSignupBody({
        phoneNo,
      }),
    });

    assertStatus(response, 400, "User signup requires phone verification");

    const user = await userByPhone(phoneNo);

    assert(!user, "Missing OTP cannot create User");
  }

  /*
   * ==========================================================
   * USER - MALFORMED OTP
   * ==========================================================
   */

  section("USER SIGNUP - MALFORMED OTP ID");

  {
    const phoneNo = nextPhone();

    const response = await requestJson("POST", "/user/signup", {
      body: userSignupBody({
        phoneNo,
        otpId: "not-a-valid-object-id",
      }),
    });

    assertStatus(response, 400, "Malformed OTP ID is rejected");

    assertNot500(response, "Malformed OTP ID must not produce HTTP 500");

    const user = await userByPhone(phoneNo);

    assert(!user, "Malformed OTP ID cannot create User");
  }

  /*
   * ==========================================================
   * USER - NONEXISTENT OTP
   * ==========================================================
   */

  section("USER SIGNUP - NONEXISTENT OTP");

  {
    const phoneNo = nextPhone();

    const fakeOtpId = new mongoose.Types.ObjectId().toString();

    const response = await requestJson("POST", "/user/signup", {
      body: userSignupBody({
        phoneNo,
        otpId: fakeOtpId,
      }),
    });

    assertStatus(response, 403, "Nonexistent OTP authorization is rejected");

    assertNot500(response, "Nonexistent OTP must not produce HTTP 500");

    const user = await userByPhone(phoneNo);

    assert(!user, "Nonexistent OTP cannot create User");
  }

  /*
   * ==========================================================
   * USER - UNVERIFIED OTP
   * ==========================================================
   */

  section("USER SIGNUP - UNVERIFIED OTP");

  {
    const phoneNo = nextPhone();

    const otp = await createOtp({
      phoneNo,
      accountType: "user",
      verified: false,
    });

    const response = await requestJson("POST", "/user/signup", {
      body: userSignupBody({
        phoneNo,
        otpId: String(otp._id),
      }),
    });

    assertStatus(response, 403, "Unverified OTP cannot authorize User signup");

    const user = await userByPhone(phoneNo);

    assert(!user, "Unverified OTP creates no User");

    const currentOtp = await refreshOtp(otp._id);

    assert(
      currentOtp && currentOtp.consumedAt === null,
      "Rejected unverified OTP remains unconsumed",
    );
  }

  /*
   * ==========================================================
   * USER - WRONG PHONE TARGET
   * ==========================================================
   */

  section("USER SIGNUP - OTP TARGET BINDING");

  {
    const authorizedPhone = nextPhone();
    const attackerPhone = nextPhone();

    const otp = await createOtp({
      phoneNo: authorizedPhone,
      accountType: "user",
      verified: true,
    });

    const response = await requestJson("POST", "/user/signup", {
      body: userSignupBody({
        phoneNo: attackerPhone,
        otpId: String(otp._id),
      }),
    });

    assertStatus(response, 403, "OTP for one phone cannot authorize another User phone");

    const attacker = await userByPhone(attackerPhone);

    assert(!attacker, "Wrong-target OTP cannot create attacker User");

    const authorized = await userByPhone(authorizedPhone);

    assert(!authorized, "Wrong-target attack does not create authorized-phone User");

    const currentOtp = await refreshOtp(otp._id);

    assert(currentOtp && currentOtp.consumedAt === null, "Target mismatch does not consume OTP");
  }

  /*
   * ==========================================================
   * USER - CROSS ROLE
   * ==========================================================
   */

  section("USER SIGNUP - VENDOR OTP CROSS ROLE");

  {
    const phoneNo = nextPhone();

    const vendorOtp = await createOtp({
      phoneNo,
      accountType: "vendor",
      verified: true,
    });

    const response = await requestJson("POST", "/user/signup", {
      body: userSignupBody({
        phoneNo,
        otpId: String(vendorOtp._id),
      }),
    });

    assertStatus(response, 403, "Vendor OTP cannot authorize User signup");

    const user = await userByPhone(phoneNo);

    assert(!user, "Vendor OTP creates no User");

    const currentOtp = await refreshOtp(vendorOtp._id);

    assert(
      currentOtp && currentOtp.consumedAt === null,
      "Cross-role rejection does not consume Vendor OTP",
    );
  }

  /*
   * ==========================================================
   * USER - ALREADY CONSUMED OTP
   * ==========================================================
   */

  section("USER SIGNUP - PRE-CONSUMED OTP");

  {
    const phoneNo = nextPhone();

    const otp = await createOtp({
      phoneNo,
      accountType: "user",
      verified: true,
      consumed: true,
    });

    const response = await requestJson("POST", "/user/signup", {
      body: userSignupBody({
        phoneNo,
        otpId: String(otp._id),
      }),
    });

    assertStatus(response, 403, "Already-consumed OTP cannot authorize User signup");

    const user = await userByPhone(phoneNo);

    assert(!user, "Consumed OTP creates no User");
  }

  /*
   * ==========================================================
   * USER - VALID SIGNUP
   * ==========================================================
   */

  section("USER SIGNUP - VALID VERIFIED OTP");

  let successfulUserOtp;
  let successfulUserPhone;

  {
    successfulUserPhone = nextPhone();

    successfulUserOtp = await createOtp({
      phoneNo: successfulUserPhone,
      accountType: "user",
      verified: true,
    });

    const response = await requestJson("POST", "/user/signup", {
      body: userSignupBody({
        phoneNo: successfulUserPhone,
        otpId: String(successfulUserOtp._id),
      }),
    });

    assertStatus(response, 201, "Verified matching User OTP authorizes signup");

    await trackCreatedAccount(successfulUserPhone);

    const user = await userByPhone(successfulUserPhone);

    assert(Boolean(user), "Valid OTP creates User in MongoDB");

    assert(user && user.verifyPhoneNo === true, "Successfully created User is phone verified");

    assert(
      user && String(user.phoneNo) === String(successfulUserPhone),
      "Created User phone matches OTP target",
    );

    const currentOtp = await refreshOtp(successfulUserOtp._id);

    assert(currentOtp && currentOtp.verified === true, "Successful signup uses verified OTP");

    assert(
      currentOtp && currentOtp.consumedAt instanceof Date,
      "Successful User signup consumes OTP authorization",
    );
  }

  /*
   * ==========================================================
   * USER - OTP REPLAY
   * ==========================================================
   */

  section("USER SIGNUP - OTP REPLAY");

  {
    /*
     * Use a different phone intentionally.
     *
     * The original phone now exists, so attempting the same
     * phone would hit the duplicate-account check before the
     * OTP authorization check.
     *
     * We want to prove the consumed OTP itself cannot be reused.
     */
    const replayPhone = nextPhone();

    const response = await requestJson("POST", "/user/signup", {
      body: userSignupBody({
        phoneNo: replayPhone,
        otpId: String(successfulUserOtp._id),
      }),
    });

    assertControlled4xx(response, "Consumed User OTP cannot be replayed");

    assertNot500(response, "User OTP replay must not produce HTTP 500");

    const replayUser = await userByPhone(replayPhone);

    assert(!replayUser, "Replayed User OTP cannot create second account");

    const originalUser = await userByPhone(successfulUserPhone);

    assert(Boolean(originalUser), "OTP replay leaves original User intact");
  }

  /*
   * ==========================================================
   * VENDOR - MISSING OTP
   * ==========================================================
   */

  section("VENDOR SIGNUP - MISSING OTP");

  {
    const phoneNo = nextPhone();

    const response = await requestJson("POST", "/vendor/signup", {
      body: vendorSignupBody({
        phoneNo,
      }),
    });

    assertStatus(response, 400, "Vendor signup requires phone verification");

    const vendor = await vendorByPhone(phoneNo);

    assert(!vendor, "Missing OTP cannot create Vendor");
  }

  /*
   * ==========================================================
   * VENDOR - MALFORMED OTP
   * ==========================================================
   */

  section("VENDOR SIGNUP - MALFORMED OTP ID");

  {
    const phoneNo = nextPhone();

    const response = await requestJson("POST", "/vendor/signup", {
      body: vendorSignupBody({
        phoneNo,
        otpId: "invalid-otp-id",
      }),
    });

    assertStatus(response, 400, "Malformed Vendor OTP ID is rejected");

    assertNot500(response, "Malformed Vendor OTP ID must not produce HTTP 500");

    const vendor = await vendorByPhone(phoneNo);

    assert(!vendor, "Malformed OTP cannot create Vendor");
  }

  /*
   * ==========================================================
   * VENDOR - NONEXISTENT OTP
   * ==========================================================
   */

  section("VENDOR SIGNUP - NONEXISTENT OTP");

  {
    const phoneNo = nextPhone();

    const fakeOtpId = new mongoose.Types.ObjectId().toString();

    const response = await requestJson("POST", "/vendor/signup", {
      body: vendorSignupBody({
        phoneNo,
        otpId: fakeOtpId,
      }),
    });

    assertStatus(response, 403, "Nonexistent Vendor OTP is rejected");

    assertNot500(response, "Nonexistent Vendor OTP must not produce HTTP 500");

    const vendor = await vendorByPhone(phoneNo);

    assert(!vendor, "Nonexistent OTP cannot create Vendor");
  }

  /*
   * ==========================================================
   * VENDOR - UNVERIFIED OTP
   * ==========================================================
   */

  section("VENDOR SIGNUP - UNVERIFIED OTP");

  {
    const phoneNo = nextPhone();

    const otp = await createOtp({
      phoneNo,
      accountType: "vendor",
      verified: false,
    });

    const response = await requestJson("POST", "/vendor/signup", {
      body: vendorSignupBody({
        phoneNo,
        otpId: String(otp._id),
      }),
    });

    assertStatus(response, 403, "Unverified OTP cannot authorize Vendor signup");

    const vendor = await vendorByPhone(phoneNo);

    assert(!vendor, "Unverified OTP creates no Vendor");

    const currentOtp = await refreshOtp(otp._id);

    assert(currentOtp && currentOtp.consumedAt === null, "Rejected Vendor OTP remains unconsumed");
  }

  /*
   * ==========================================================
   * VENDOR - WRONG PHONE
   * ==========================================================
   */

  section("VENDOR SIGNUP - OTP TARGET BINDING");

  {
    const authorizedPhone = nextPhone();
    const attackerPhone = nextPhone();

    const otp = await createOtp({
      phoneNo: authorizedPhone,
      accountType: "vendor",
      verified: true,
    });

    const response = await requestJson("POST", "/vendor/signup", {
      body: vendorSignupBody({
        phoneNo: attackerPhone,
        otpId: String(otp._id),
      }),
    });

    assertStatus(response, 403, "OTP for one phone cannot authorize another Vendor phone");

    const attacker = await vendorByPhone(attackerPhone);

    assert(!attacker, "Wrong-target OTP cannot create attacker Vendor");

    const currentOtp = await refreshOtp(otp._id);

    assert(
      currentOtp && currentOtp.consumedAt === null,
      "Vendor target mismatch does not consume OTP",
    );
  }

  /*
   * ==========================================================
   * VENDOR - USER OTP CROSS ROLE
   * ==========================================================
   */

  section("VENDOR SIGNUP - USER OTP CROSS ROLE");

  {
    const phoneNo = nextPhone();

    const userOtp = await createOtp({
      phoneNo,
      accountType: "user",
      verified: true,
    });

    const response = await requestJson("POST", "/vendor/signup", {
      body: vendorSignupBody({
        phoneNo,
        otpId: String(userOtp._id),
      }),
    });

    assertStatus(response, 403, "User OTP cannot authorize Vendor signup");

    const vendor = await vendorByPhone(phoneNo);

    assert(!vendor, "User OTP creates no Vendor");

    const currentOtp = await refreshOtp(userOtp._id);

    assert(
      currentOtp && currentOtp.consumedAt === null,
      "Cross-role rejection does not consume User OTP",
    );
  }

  /*
   * ==========================================================
   * VENDOR - PRE-CONSUMED OTP
   * ==========================================================
   */

  section("VENDOR SIGNUP - PRE-CONSUMED OTP");

  {
    const phoneNo = nextPhone();

    const otp = await createOtp({
      phoneNo,
      accountType: "vendor",
      verified: true,
      consumed: true,
    });

    const response = await requestJson("POST", "/vendor/signup", {
      body: vendorSignupBody({
        phoneNo,
        otpId: String(otp._id),
      }),
    });

    assertStatus(response, 403, "Already-consumed OTP cannot authorize Vendor signup");

    const vendor = await vendorByPhone(phoneNo);

    assert(!vendor, "Consumed OTP creates no Vendor");
  }

  /*
   * ==========================================================
   * VENDOR - VALID SIGNUP
   * ==========================================================
   */

  section("VENDOR SIGNUP - VALID VERIFIED OTP");

  let successfulVendorOtp;
  let successfulVendorPhone;

  {
    successfulVendorPhone = nextPhone();

    successfulVendorOtp = await createOtp({
      phoneNo: successfulVendorPhone,
      accountType: "vendor",
      verified: true,
    });

    const response = await requestJson("POST", "/vendor/signup", {
      body: vendorSignupBody({
        phoneNo: successfulVendorPhone,
        otpId: String(successfulVendorOtp._id),
      }),
    });

    assertStatus(response, 201, "Verified matching Vendor OTP authorizes signup");

    await trackCreatedAccount(successfulVendorPhone);

    const vendor = await vendorByPhone(successfulVendorPhone);

    assert(Boolean(vendor), "Valid OTP creates Vendor in MongoDB");

    assert(
      vendor && vendor.verifyPhoneNo === true,
      "Successfully created Vendor is phone verified",
    );

    assert(
      vendor && String(vendor.phoneNo) === String(successfulVendorPhone),
      "Created Vendor phone matches OTP target",
    );

    const currentOtp = await refreshOtp(successfulVendorOtp._id);

    assert(
      currentOtp && currentOtp.verified === true,
      "Successful Vendor signup uses verified OTP",
    );

    assert(
      currentOtp && currentOtp.consumedAt instanceof Date,
      "Successful Vendor signup consumes OTP authorization",
    );
  }

  /*
   * ==========================================================
   * VENDOR - OTP REPLAY
   * ==========================================================
   */

  section("VENDOR SIGNUP - OTP REPLAY");

  {
    const replayPhone = nextPhone();

    const response = await requestJson("POST", "/vendor/signup", {
      body: vendorSignupBody({
        phoneNo: replayPhone,
        otpId: String(successfulVendorOtp._id),
      }),
    });

    assertControlled4xx(response, "Consumed Vendor OTP cannot be replayed");

    assertNot500(response, "Vendor OTP replay must not produce HTTP 500");

    const replayVendor = await vendorByPhone(replayPhone);

    assert(!replayVendor, "Replayed Vendor OTP cannot create second account");

    const originalVendor = await vendorByPhone(successfulVendorPhone);

    assert(Boolean(originalVendor), "OTP replay leaves original Vendor intact");
  }

  /*
   * ==========================================================
   * ACCOUNT-TYPE ISOLATION - SAME TARGET
   * ==========================================================
   */

  section("OTP ACCOUNT-TYPE ISOLATION");

  {
    const phoneNo = nextPhone();

    const userOtp = await createOtp({
      phoneNo,
      accountType: "user",
      verified: true,
    });

    const vendorAttack = await requestJson("POST", "/vendor/signup", {
      body: vendorSignupBody({
        phoneNo,
        otpId: String(userOtp._id),
      }),
    });

    assertStatus(vendorAttack, 403, "User authorization cannot cross into Vendor signup");

    const [user, vendor] = await Promise.all([userByPhone(phoneNo), vendorByPhone(phoneNo)]);

    assert(!user && !vendor, "Cross-role OTP attack creates no account");

    const currentOtp = await refreshOtp(userOtp._id);

    assert(
      currentOtp && currentOtp.consumedAt === null,
      "Cross-role attack leaves valid OTP unconsumed",
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
      _id: {
        $in: createdUsers,
      },
    });

    usersDeleted += result.deletedCount || 0;
  }

  if (createdVendors.length) {
    const result = await Vendor.deleteMany({
      _id: {
        $in: createdVendors,
      },
    });

    vendorsDeleted += result.deletedCount || 0;
  }

  if (createdOtps.length) {
    const result = await OtpAuth.deleteMany({
      _id: {
        $in: createdOtps,
      },
    });

    otpsDeleted += result.deletedCount || 0;
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
    assertSafeEnvironment();

    await connectMongo();

    section("SIGNUP PHONE OTP AUTHORIZATION E2E SECURITY TEST");

    console.log({
      api: API,
      nodeEnv: process.env.NODE_ENV,
    });

    await runTests();
  } catch (error) {
    suiteCrashed = true;

    section("TEST SUITE CRASHED");

    console.error(error);
  } finally {
    if (mongoose.connection.readyState === 1) {
      try {
        await cleanup();
      } catch (cleanupError) {
        suiteCrashed = true;

        console.error("Cleanup failed:", cleanupError);
      }

      await mongoose.disconnect();

      console.log("\nMongoDB disconnected.");
    }

    section("FINAL SIGNUP OTP SECURITY TEST SUMMARY");

    console.log(`Assertions: ${assertions}`);
    console.log(`Passed: ${passed}`);
    console.log(`Failed: ${failed}`);

    if (suiteCrashed) {
      console.error("\nFAIL: SIGNUP OTP SECURITY TEST SUITE CRASHED");

      process.exitCode = 1;
      return;
    }

    if (failed > 0) {
      console.error("\nFAIL: SIGNUP OTP SECURITY VULNERABILITIES DETECTED");

      process.exitCode = 1;
      return;
    }

    console.log("\nPASS: SIGNUP PHONE OTP SECURITY TESTS PASSED");

    console.log(`
Verified:

✓ Signup requires phone OTP authorization

✓ Malformed OTP IDs are rejected safely

✓ Nonexistent OTP IDs are rejected safely

✓ Unverified OTP cannot create an account

✓ OTP authorization is bound to exact phone number

✓ User OTP cannot authorize Vendor signup

✓ Vendor OTP cannot authorize User signup

✓ OTP authorization is bound to account type

✓ Valid verified User OTP creates User

✓ Valid verified Vendor OTP creates Vendor

✓ Successful signup marks phone as verified

✓ Successful signup atomically consumes OTP

✓ Already-consumed OTP cannot authorize signup

✓ Consumed OTP cannot be replayed

✓ Failed OTP attacks create no accounts

✓ Cross-role attacks do not consume valid OTPs

✓ OTP target mismatch does not consume valid OTP

✓ Failed security requests do not produce HTTP 500
`);
  }
}

main();
