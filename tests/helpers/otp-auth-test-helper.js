"use strict";

const OtpAuth = require("../../models/otpAuth");

/**
 * Creates a VERIFIED signup OTP authorization directly in the test DB.
 *
 * Important:
 * - This does NOT bypass production signup authorization.
 * - The real signup endpoint still calls OtpAuthorizationService.consume().
 * - This only avoids sending a real SMS during unrelated booking tests.
 */
async function createVerifiedSignupOtp({ phoneNo, accountType }) {
  if (!phoneNo) {
    throw new Error("phoneNo is required");
  }

  if (!["user", "vendor"].includes(accountType)) {
    throw new Error(`Invalid accountType for signup OTP: ${accountType}`);
  }

  const normalizedPhone = String(phoneNo).trim().replace(/\s+/g, "");

  const otp = await OtpAuth.create({
    otp: "123456",

    purpose: "verify_phone",
    accountType,
    accountId: null,
    target: normalizedPhone,

    verified: true,
    consumedAt: null,
  });

  return String(otp._id);
}

module.exports = {
  createVerifiedSignupOtp,
};
