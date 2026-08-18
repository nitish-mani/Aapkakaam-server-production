"use strict";

/**
 * ============================================================
 * PASSWORD RESET PHONE OTP SECURITY E2E TEST
 * ============================================================
 *
 * Verifies:
 *
 * - User/Vendor password reset requires verified reset_password OTP
 * - OTP is bound to exact phone
 * - OTP is bound to account type
 * - OTP is bound to account ID
 * - verify_phone/change_phone OTP cannot reset password
 * - unrelated OTP cannot reset victim password
 * - consumed OTP cannot be reused
 * - successful reset consumes OTP exactly once
 * - failed attacks do not modify victim password
 * - successful reset invalidates old password
 * - new password can log in
 *
 * NO REAL SMS IS SENT.
 *
 * Run:
 *
 * NODE_ENV=development ALLOW_AUTHORIZATION_TEST=1 \
 * node tests/password-reset-phone-otp-security-e2e-test.js
 */

const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const ENV = require("../src/config/env");

const User = require("../models/user");
const Vendor = require("../models/vendor");
const OtpAuth = require("../models/otpAuth");

const API =
  process.env.ACCOUNT_AUTH_TEST_API || process.env.API_BASE_URL || "http://localhost:3000/api";

const OLD_PASSWORD = "OldPassword@123";
const NEW_PASSWORD = "NewPassword@456";
const ATTACK_PASSWORD = "AttackerPassword@789";

let sequence = 0;

let assertions = 0;
let passed = 0;
let failed = 0;
let suiteCrashed = false;

const createdUsers = [];
const createdVendors = [];
const createdOtps = [];

/*
 * ============================================================
 * OUTPUT
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
    `Expected controlled 4xx | Response: ${safeString(response.data)}`,
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
 * DATA
 * ============================================================
 */

function nextPhone() {
  sequence += 1;

  const suffix = `${Date.now()}${process.pid}${sequence}`.slice(-9);

  return `9${suffix}`;
}

function nextEmail(prefix) {
  sequence += 1;

  return `${prefix}.${Date.now()}.${sequence}@example.test`;
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
    };
  } catch (error) {
    throw new Error(
      [
        `HTTP request failed: ${method} ${API}${path}`,
        error.message,
        "",
        "Make sure the backend is running.",
      ].join("\n"),
    );
  }
}

/*
 * ============================================================
 * SAFETY / DATABASE
 * ============================================================
 */

function assertSafeEnvironment() {
  if (process.env.ALLOW_AUTHORIZATION_TEST !== "1") {
    throw new Error("Set ALLOW_AUTHORIZATION_TEST=1 before running this suite.");
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error("Refusing to run password reset security tests in production.");
  }
}

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
 *
 * Accounts are inserted directly because this test targets
 * PASSWORD RESET, not signup.
 *
 * This avoids sending signup OTPs/SMS.
 * ============================================================
 */

async function createUser() {
  const phoneNo = nextPhone();

  const password = await bcrypt.hash(OLD_PASSWORD, 12);

  const user = await User.create({
    name: `Password Security User ${sequence}`,
    phoneNo,
    email: nextEmail("reset-user"),
    password,
    gender: "male",
    fcmToken: "",
    verifyPhoneNo: true,
    agreedToTnCnP: true,
    accountCreatedOn: new Date(),
  });

  createdUsers.push(String(user._id));

  return {
    kind: "user",
    id: String(user._id),
    phoneNo,
  };
}

async function createVendor() {
  const phoneNo = nextPhone();

  const password = await bcrypt.hash(OLD_PASSWORD, 12);

  const vendor = await Vendor.create({
    name: `Password Security Vendor ${sequence}`,
    phoneNo,
    email: nextEmail("reset-vendor"),
    password,

    type: "four wheeler",
    gender: "male",
    experience: 1,

    commission: 100,
    wageRate: 0,
    wageRateType: "",

    balance: 550,

    fcmToken: "",
    verifyPhoneNo: true,
    agreedToTnCnP: true,
    accountCreatedOn: new Date(),
  });

  createdVendors.push(String(vendor._id));

  return {
    kind: "vendor",
    id: String(vendor._id),
    phoneNo,
  };
}

/*
 * ============================================================
 * OTP CREATION
 * ============================================================
 */

async function createOtp({
  account,
  phoneNo,
  accountType,
  accountId,
  purpose = "reset_password",
  verified = true,
  consumed = false,
}) {
  const resolvedType = accountType || account?.kind;

  const resolvedAccountId = accountId !== undefined ? accountId : account?.id;

  const resolvedPhone = phoneNo || account?.phoneNo;

  const otp = await OtpAuth.create({
    otp: "123456",

    purpose,

    accountType: resolvedType,

    accountId: resolvedAccountId,

    target: String(resolvedPhone).trim().replace(/\s+/g, ""),

    verified,

    consumedAt: consumed ? new Date() : null,
  });

  createdOtps.push(String(otp._id));

  return otp;
}

/*
 * ============================================================
 * DB HELPERS
 * ============================================================
 */

async function getAccount(account) {
  if (account.kind === "user") {
    return User.findById(account.id).lean();
  }

  return Vendor.findById(account.id).lean();
}

async function passwordHash(account) {
  const doc = await getAccount(account);

  return doc?.password;
}

async function passwordMatches(account, password) {
  const hash = await passwordHash(account);

  if (!hash) {
    return false;
  }

  return bcrypt.compare(password, hash);
}

async function getOtp(id) {
  return OtpAuth.findById(id).lean();
}

/*
 * ============================================================
 * API HELPERS
 * ============================================================
 */

function passwordEndpoint(account) {
  return account.kind === "user" ? "/user/edit/password" : "/vendor/edit/password";
}

function loginEndpoint(account) {
  return account.kind === "user" ? "/user/login" : "/vendor/login";
}

async function resetPassword(
  account,
  { phoneNo = account.phoneNo, password = NEW_PASSWORD, otpId } = {},
) {
  return requestJson("PATCH", passwordEndpoint(account), {
    body: {
      phoneNo,
      password,
      otpId,
    },
  });
}

async function login(account, password) {
  return requestJson("POST", loginEndpoint(account), {
    body: {
      phoneNo: account.phoneNo,
      password,
      fcmToken: "",
    },
  });
}

/*
 * ============================================================
 * SECURITY TEST FOR ONE ACCOUNT TYPE
 * ============================================================
 */

async function runAccountTests(account, oppositeAccount) {
  const title = account.kind.toUpperCase();

  /*
   * ----------------------------------------------------------
   * MISSING OTP
   * ----------------------------------------------------------
   */

  section(`${title} PASSWORD RESET - MISSING OTP`);

  {
    const before = await passwordHash(account);

    const response = await resetPassword(account, {
      otpId: undefined,
      password: ATTACK_PASSWORD,
    });

    assertControlled4xx(response, `${title} password reset requires OTP`);

    assertNot500(response, `Missing ${title} OTP must not produce HTTP 500`);

    const after = await passwordHash(account);

    assert(before === after, `Missing OTP leaves ${title} password unchanged`);
  }

  /*
   * ----------------------------------------------------------
   * MALFORMED OTP ID
   * ----------------------------------------------------------
   */

  section(`${title} PASSWORD RESET - MALFORMED OTP`);

  {
    const before = await passwordHash(account);

    const response = await resetPassword(account, {
      otpId: "invalid-object-id",
      password: ATTACK_PASSWORD,
    });

    assertStatus(response, 400, `Malformed ${title} OTP ID is rejected`);

    assertNot500(response, `Malformed ${title} OTP ID must not produce HTTP 500`);

    const after = await passwordHash(account);

    assert(before === after, `Malformed OTP leaves ${title} password unchanged`);
  }

  /*
   * ----------------------------------------------------------
   * NONEXISTENT OTP
   * ----------------------------------------------------------
   */

  section(`${title} PASSWORD RESET - NONEXISTENT OTP`);

  {
    const before = await passwordHash(account);

    const response = await resetPassword(account, {
      otpId: new mongoose.Types.ObjectId().toString(),
      password: ATTACK_PASSWORD,
    });

    assertControlled4xx(response, `Nonexistent ${title} OTP is rejected`);

    assertNot500(response, `Nonexistent ${title} OTP must not produce HTTP 500`);

    const after = await passwordHash(account);

    assert(before === after, `Nonexistent OTP leaves ${title} password unchanged`);
  }

  /*
   * ----------------------------------------------------------
   * UNVERIFIED OTP
   * ----------------------------------------------------------
   */

  section(`${title} PASSWORD RESET - UNVERIFIED OTP`);

  {
    const otp = await createOtp({
      account,
      verified: false,
    });

    const before = await passwordHash(account);

    const response = await resetPassword(account, {
      otpId: String(otp._id),
      password: ATTACK_PASSWORD,
    });

    assertStatus(response, 403, `Unverified OTP cannot reset ${title} password`);

    const after = await passwordHash(account);

    assert(before === after, `Unverified OTP leaves ${title} password unchanged`);

    const currentOtp = await getOtp(otp._id);

    assert(
      currentOtp && currentOtp.consumedAt === null,
      `Rejected unverified ${title} OTP remains unconsumed`,
    );
  }

  /*
   * ----------------------------------------------------------
   * WRONG PHONE TARGET
   * ----------------------------------------------------------
   */

  section(`${title} PASSWORD RESET - TARGET BINDING`);

  {
    const attackerPhone = nextPhone();

    const otp = await createOtp({
      account,
    });

    const before = await passwordHash(account);

    const response = await resetPassword(account, {
      phoneNo: attackerPhone,
      otpId: String(otp._id),
      password: ATTACK_PASSWORD,
    });

    assertStatus(response, 403, `${title} reset OTP cannot authorize another phone`);

    const after = await passwordHash(account);

    assert(before === after, `Phone target mismatch leaves ${title} password unchanged`);

    const currentOtp = await getOtp(otp._id);

    assert(
      currentOtp && currentOtp.consumedAt === null,
      `${title} target mismatch does not consume OTP`,
    );
  }

  /*
   * ----------------------------------------------------------
   * ACCOUNT-ID SUBSTITUTION ATTACK
   * ----------------------------------------------------------
   */

  section(`${title} PASSWORD RESET - ACCOUNT ID BINDING`);

  {
    /*
     * OTP target uses victim's phone, but accountId points to
     * another account of the same/cross context.
     *
     * consume() must reject it.
     */

    const wrongId = oppositeAccount.id;

    const otp = await createOtp({
      phoneNo: account.phoneNo,
      accountType: account.kind,
      accountId: wrongId,
      purpose: "reset_password",
      verified: true,
    });

    const before = await passwordHash(account);

    const response = await resetPassword(account, {
      otpId: String(otp._id),
      password: ATTACK_PASSWORD,
    });

    assertStatus(response, 403, `${title} OTP with wrong account binding is rejected`);

    const after = await passwordHash(account);

    assert(before === after, `Wrong account binding leaves ${title} password unchanged`);

    const currentOtp = await getOtp(otp._id);

    assert(
      currentOtp && currentOtp.consumedAt === null,
      `Wrong account binding does not consume ${title} OTP`,
    );
  }

  /*
   * ----------------------------------------------------------
   * CROSS ROLE
   * ----------------------------------------------------------
   */

  section(`${title} PASSWORD RESET - CROSS ROLE OTP`);

  {
    const oppositeType = account.kind === "user" ? "vendor" : "user";

    const otp = await createOtp({
      phoneNo: account.phoneNo,
      accountType: oppositeType,
      accountId: account.id,
      purpose: "reset_password",
      verified: true,
    });

    const before = await passwordHash(account);

    const response = await resetPassword(account, {
      otpId: String(otp._id),
      password: ATTACK_PASSWORD,
    });

    assertStatus(response, 403, `${oppositeType} OTP cannot reset ${title} password`);

    const after = await passwordHash(account);

    assert(before === after, `Cross-role OTP leaves ${title} password unchanged`);

    const currentOtp = await getOtp(otp._id);

    assert(
      currentOtp && currentOtp.consumedAt === null,
      `Cross-role rejection does not consume OTP`,
    );
  }

  /*
   * ----------------------------------------------------------
   * WRONG PURPOSE: VERIFY PHONE
   * ----------------------------------------------------------
   */

  section(`${title} PASSWORD RESET - VERIFY_PHONE OTP REUSE`);

  {
    /*
     * verify_phone OTPs normally have accountId=null.
     */

    const otp = await createOtp({
      phoneNo: account.phoneNo,
      accountType: account.kind,
      accountId: null,
      purpose: "verify_phone",
      verified: true,
    });

    const before = await passwordHash(account);

    const response = await resetPassword(account, {
      otpId: String(otp._id),
      password: ATTACK_PASSWORD,
    });

    assertStatus(response, 403, `verify_phone OTP cannot reset ${title} password`);

    const after = await passwordHash(account);

    assert(before === after, `verify_phone OTP leaves ${title} password unchanged`);

    const currentOtp = await getOtp(otp._id);

    assert(currentOtp && currentOtp.consumedAt === null, `Wrong-purpose OTP is not consumed`);
  }

  /*
   * ----------------------------------------------------------
   * WRONG PURPOSE: CHANGE PHONE
   * ----------------------------------------------------------
   */

  section(`${title} PASSWORD RESET - CHANGE_PHONE OTP REUSE`);

  {
    const otp = await createOtp({
      account,
      purpose: "change_phone",
      verified: true,
    });

    const before = await passwordHash(account);

    const response = await resetPassword(account, {
      otpId: String(otp._id),
      password: ATTACK_PASSWORD,
    });

    assertStatus(response, 403, `change_phone OTP cannot reset ${title} password`);

    const after = await passwordHash(account);

    assert(before === after, `change_phone OTP leaves ${title} password unchanged`);

    const currentOtp = await getOtp(otp._id);

    assert(
      currentOtp && currentOtp.consumedAt === null,
      `Wrong-purpose change_phone OTP remains unconsumed`,
    );
  }

  /*
   * ----------------------------------------------------------
   * PRE-CONSUMED OTP
   * ----------------------------------------------------------
   */

  section(`${title} PASSWORD RESET - PRE-CONSUMED OTP`);

  {
    const otp = await createOtp({
      account,
      verified: true,
      consumed: true,
    });

    const before = await passwordHash(account);

    const response = await resetPassword(account, {
      otpId: String(otp._id),
      password: ATTACK_PASSWORD,
    });

    assertStatus(response, 403, `Consumed OTP cannot reset ${title} password`);

    const after = await passwordHash(account);

    assert(before === after, `Consumed OTP leaves ${title} password unchanged`);
  }

  /*
   * ----------------------------------------------------------
   * VALID RESET
   * ----------------------------------------------------------
   */

  section(`${title} PASSWORD RESET - VALID OTP`);

  let successfulOtp;

  {
    successfulOtp = await createOtp({
      account,
      verified: true,
    });

    const before = await passwordHash(account);

    const response = await resetPassword(account, {
      otpId: String(successfulOtp._id),
      password: NEW_PASSWORD,
    });

    assert(
      response.status >= 200 && response.status < 300,
      `${title} password can be reset with valid OTP [HTTP ${response.status}]`,
      `Response: ${safeString(response.data)}`,
    );

    const after = await passwordHash(account);

    assert(before !== after, `Valid OTP changes ${title} password hash`);

    assert(
      await passwordMatches(account, NEW_PASSWORD),
      `${title} password hash matches new password`,
    );

    assert(
      !(await passwordMatches(account, OLD_PASSWORD)),
      `${title} old password is no longer valid`,
    );

    const currentOtp = await getOtp(successfulOtp._id);

    assert(
      currentOtp && currentOtp.consumedAt instanceof Date,
      `Successful ${title} password reset consumes OTP`,
    );
  }

  /*
   * ----------------------------------------------------------
   * REPLAY
   * ----------------------------------------------------------
   */

  section(`${title} PASSWORD RESET - OTP REPLAY`);

  {
    const before = await passwordHash(account);

    const response = await resetPassword(account, {
      otpId: String(successfulOtp._id),
      password: ATTACK_PASSWORD,
    });

    assertStatus(response, 403, `${title} password-reset OTP cannot be replayed`);

    assertNot500(response, `${title} OTP replay must not produce HTTP 500`);

    const after = await passwordHash(account);

    assert(before === after, `${title} OTP replay cannot modify password`);

    assert(
      await passwordMatches(account, NEW_PASSWORD),
      `${title} retains legitimate password after replay attack`,
    );

    assert(
      !(await passwordMatches(account, ATTACK_PASSWORD)),
      `Replay cannot install attacker-controlled ${title} password`,
    );
  }

  /*
   * ----------------------------------------------------------
   * LOGIN BEHAVIOUR
   * ----------------------------------------------------------
   */

  section(`${title} PASSWORD RESET - LOGIN VALIDATION`);

  {
    const oldLogin = await login(account, OLD_PASSWORD);

    assert(
      oldLogin.status >= 400 && oldLogin.status < 500,
      `${title} old password cannot login after reset [HTTP ${oldLogin.status}]`,
      `Response: ${safeString(oldLogin.data)}`,
    );

    const newLogin = await login(account, NEW_PASSWORD);

    assert(
      newLogin.status >= 200 && newLogin.status < 300,
      `${title} new password successfully logs in [HTTP ${newLogin.status}]`,
      `Response: ${safeString(newLogin.data)}`,
    );
  }
}

/*
 * ============================================================
 * VICTIM SUBSTITUTION ATTACK
 * ============================================================
 */

async function runVictimSubstitutionTest({ attacker, victim }) {
  const title = victim.kind.toUpperCase();

  section(`${title} PASSWORD RESET - VICTIM OTP SUBSTITUTION ATTACK`);

  /*
   * Attacker has a legitimate reset OTP for their OWN account.
   *
   * They then send:
   *
   * victim phone + attacker OTP
   *
   * This is one of the most important account takeover tests.
   */

  const otp = await createOtp({
    account: attacker,
    verified: true,
  });

  const victimBefore = await passwordHash(victim);

  const attackerBefore = await passwordHash(attacker);

  const response = await resetPassword(victim, {
    phoneNo: victim.phoneNo,
    otpId: String(otp._id),
    password: ATTACK_PASSWORD,
  });

  assertStatus(response, 403, `Attacker OTP cannot reset victim ${title} password`);

  assertNot500(response, `Victim substitution attack must not produce HTTP 500`);

  const victimAfter = await passwordHash(victim);

  const attackerAfter = await passwordHash(attacker);

  assert(
    victimBefore === victimAfter,
    `Victim ${title} password survives attacker OTP substitution`,
  );

  assert(attackerBefore === attackerAfter, `OTP substitution does not mutate attacker account`);

  const currentOtp = await getOtp(otp._id);

  assert(
    currentOtp && currentOtp.consumedAt === null,
    `Rejected victim substitution does not consume attacker's valid OTP`,
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
  let otpsDeleted = 0;

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

  if (createdOtps.length) {
    const result = await OtpAuth.deleteMany({
      _id: {
        $in: createdOtps,
      },
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
    assertSafeEnvironment();

    await connectMongo();

    section("PASSWORD RESET PHONE OTP SECURITY E2E TEST");

    console.log({
      api: API,
      nodeEnv: process.env.NODE_ENV,
    });

    /*
     * Two accounts of each type are useful because we need
     * attacker/victim separation.
     */

    const userA = await createUser();
    const userB = await createUser();

    const vendorA = await createVendor();
    const vendorB = await createVendor();

    /*
     * Run general security checks.
     *
     * userA / vendorA eventually receive NEW_PASSWORD.
     */

    await runAccountTests(userA, userB);

    await runAccountTests(vendorA, vendorB);

    /*
     * Use untouched B accounts as victims.
     *
     * Their passwords should remain OLD_PASSWORD.
     */

    await runVictimSubstitutionTest({
      attacker: userA,
      victim: userB,
    });

    await runVictimSubstitutionTest({
      attacker: vendorA,
      victim: vendorB,
    });

    /*
     * --------------------------------------------------------
     * FINAL VICTIM INTEGRITY
     * --------------------------------------------------------
     */

    section("FINAL VICTIM ACCOUNT INTEGRITY");

    assert(await passwordMatches(userB, OLD_PASSWORD), "Victim User retains original password");

    assert(
      !(await passwordMatches(userB, ATTACK_PASSWORD)),
      "Victim User never receives attacker password",
    );

    assert(await passwordMatches(vendorB, OLD_PASSWORD), "Victim Vendor retains original password");

    assert(
      !(await passwordMatches(vendorB, ATTACK_PASSWORD)),
      "Victim Vendor never receives attacker password",
    );
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

    section("FINAL PASSWORD RESET SECURITY TEST SUMMARY");

    console.log(`Assertions: ${assertions}`);
    console.log(`Passed: ${passed}`);
    console.log(`Failed: ${failed}`);

    if (suiteCrashed) {
      console.error("\nFAIL: PASSWORD RESET SECURITY TEST SUITE CRASHED");

      process.exitCode = 1;
      return;
    }

    if (failed > 0) {
      console.error("\nFAIL: PASSWORD RESET SECURITY VULNERABILITIES DETECTED");

      process.exitCode = 1;
      return;
    }

    console.log("\nPASS: PASSWORD RESET PHONE OTP SECURITY TESTS PASSED");

    console.log(`
Verified:

✓ Password reset requires OTP authorization

✓ Malformed OTP IDs are safely rejected

✓ Nonexistent OTP IDs are safely rejected

✓ Unverified OTP cannot reset password

✓ Password-reset OTP is bound to exact phone

✓ Password-reset OTP is bound to account ID

✓ Password-reset OTP is bound to User/Vendor role

✓ User OTP cannot authorize Vendor password reset

✓ Vendor OTP cannot authorize User password reset

✓ verify_phone OTP cannot authorize password reset

✓ change_phone OTP cannot authorize password reset

✓ Consumed OTP cannot authorize password reset

✓ Successful reset consumes OTP exactly once

✓ Password-reset OTP cannot be replayed

✓ Attacker OTP cannot reset victim account

✓ Failed attacks do not modify password hashes

✓ Successful reset changes password hash

✓ Old password stops working after reset

✓ New password successfully logs in

✓ Victim User password survives account takeover attacks

✓ Victim Vendor password survives account takeover attacks

✓ Security failures do not produce HTTP 500
`);
  }
}

main();
