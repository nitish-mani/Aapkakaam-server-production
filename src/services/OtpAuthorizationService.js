"use strict";

const mongoose = require("mongoose");

const OtpAuth = require("../../models/otpAuth");
const ApiError = require("../utils/ApiError");

class OtpAuthorizationService {
  /**
   * Atomically validates and consumes an OTP authorization.
   *
   * Security guarantees:
   *
   * verify_phone:
   *   - accountType bound
   *   - phone target bound
   *   - accountId MUST be null because account does not exist yet
   *
   * reset_password:
   *   - accountType bound
   *   - accountId bound
   *   - target bound
   *
   * All purposes:
   *   - OTP must already be verified
   *   - OTP must not already be consumed
   *   - atomic single-use consumption
   */
  static async consume({ otpId, accountType, accountId = null, purpose, target }) {
    // ---------------------------------------------------------
    // Basic required parameters
    // ---------------------------------------------------------

    if (!otpId || !accountType || !purpose || target === undefined || target === null) {
      throw ApiError.badRequest("OTP authorization parameters are required");
    }

    // ---------------------------------------------------------
    // Validate account type
    // ---------------------------------------------------------

    if (!["user", "vendor", "admin"].includes(accountType)) {
      throw ApiError.badRequest("Invalid OTP account type");
    }

    // ---------------------------------------------------------
    // Validate purpose
    // ---------------------------------------------------------

    const allowedPurposes = ["verify_phone", "reset_password"];

    if (!allowedPurposes.includes(purpose)) {
      throw ApiError.badRequest("Invalid OTP authorization purpose");
    }

    // ---------------------------------------------------------
    // Validate OTP ID
    // ---------------------------------------------------------

    if (!mongoose.Types.ObjectId.isValid(otpId)) {
      throw ApiError.badRequest("Invalid OTP ID");
    }

    // ---------------------------------------------------------
    // Account binding rules
    // ---------------------------------------------------------

    if (purpose === "verify_phone") {
      /*
       * Signup happens before the User/Vendor exists.
       *
       * Therefore verify_phone authorization MUST NOT be
       * attached to an existing account.
       */
      if (accountId !== null && accountId !== undefined) {
        throw ApiError.badRequest("Account ID must not be provided for phone verification");
      }
    } else {
      /*
       * reset_password operate against an
       * existing account and MUST therefore be account-bound.
       */
      if (!accountId) {
        throw ApiError.badRequest("Account ID is required for this OTP authorization");
      }

      if (!mongoose.Types.ObjectId.isValid(accountId)) {
        throw ApiError.badRequest("Invalid account ID");
      }
    }

    // ---------------------------------------------------------
    // Normalize target
    // ---------------------------------------------------------

    const normalizedTarget = this.normalizeTarget(target, purpose);

    if (!normalizedTarget) {
      throw ApiError.badRequest("OTP authorization target is required");
    }

    // ---------------------------------------------------------
    // Build strict authorization query
    // ---------------------------------------------------------

    const query = {
      _id: otpId,

      verified: true,

      accountType,

      purpose,

      target: normalizedTarget,

      consumedAt: null,
    };

    /*
     * Critical:
     *
     * verify_phone OTPs belong to no account yet.
     *
     * Password reset/change-phone OTPs MUST belong to the
     * exact existing account.
     */
    if (purpose === "verify_phone") {
      query.accountId = null;
    } else {
      query.accountId = accountId;
    }

    // ---------------------------------------------------------
    // Atomic single-use consumption
    // ---------------------------------------------------------

    const authorization = await OtpAuth.findOneAndUpdate(
      query,
      {
        $set: {
          consumedAt: new Date(),
        },
      },
      {
        new: true,
      },
    );

    if (!authorization) {
      const logData = {
        phoneNo: target,
        reason: "invalid_expired_used_or_mismatched",
        timestamp: new Date().toISOString(),
      };

      switch (accountType) {
        case "user":
          UserLogger.warn({
            event: "USER_VERIFICATION_AUTHORIZATION_FAILED",
            ...logData,
          });
          break;

        case "vendor":
          VendorLogger.warn({
            event: "VENDOR_VERIFICATION_AUTHORIZATION_FAILED",
            ...logData,
          });
          break;

        default:
          console.warn({
            event: "UNKNOWN_ACCOUNT_VERIFICATION_AUTHORIZATION_FAILED",
            accountType: "unknown",
            ...logData,
          });
      }

      throw ApiError.forbidden("Invalid, expired, already used, or mismatched verification");
    }

    return authorization;
  }

  /**
   * Normalize OTP target.
   *
   * User/Vendor verification is now phone-only.
   */
  static normalizeTarget(target, purpose) {
    const value = String(target).trim();

    if (purpose === "verify_phone" || purpose === "reset_password") {
      return value.replace(/\s+/g, "");
    }

    return value;
  }
}

module.exports = OtpAuthorizationService;
