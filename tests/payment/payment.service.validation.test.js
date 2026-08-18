/**
 * payment.service.validation.test.js
 * Tests for validation functions: validatePaymentFields, validateAmount, verifySignature, validateOwnership
 */

"use strict";

const crypto = require("crypto");
const { mockUserModel, mockVendorModel } = require("../helpers/mock");
const { createUser, createVendor, generateTestSignature } = require("../helpers/fixtures");

jest.mock("../../src/logger/logger", () => require("../helpers/mock").mockLogger);
jest.mock("../../src/config/env", () => ({
  RAZORPAY_SECRET: "test_secret_key",
}));

jest.mock("../../models/user", () => require("../helpers/mock").mockUserModel);
jest.mock("../../models/vendor", () => require("../helpers/mock").mockVendorModel);

const paymentService = require("../../src/services/paymentService");
const User = require("../../models/user");
const Vendor = require("../../models/vendor");
const ENV = require("../../src/config/env");

describe("Payment Validation Service", () => {
  describe("validatePaymentFields()", () => {
    test("should not throw for valid payment fields", () => {
      expect(() => {
        paymentService.validatePaymentFields("order_123", "pay_123", "signature_123");
      }).not.toThrow();
    });

    test("should throw when order id is missing", () => {
      try {
        paymentService.validatePaymentFields(null, "pay_123", "signature");
        fail("Expected error");
      } catch (err) {
        expect(err.message).toBe("Missing required payment fields");
        expect(err.code).toBe("MISSING_PAYMENT_FIELDS");
      }
    });

    test("should throw when payment id is missing", () => {
      try {
        paymentService.validatePaymentFields("order", "", "signature");
        fail("Expected error");
      } catch (err) {
        expect(err.message).toBe("Missing required payment fields");
        expect(err.code).toBe("MISSING_PAYMENT_FIELDS");
      }
    });

    test("should throw when signature is missing", () => {
      try {
        paymentService.validatePaymentFields("order", "payment", undefined);
        fail("Expected error");
      } catch (err) {
        expect(err.message).toBe("Missing required payment fields");
        expect(err.code).toBe("MISSING_PAYMENT_FIELDS");
      }
    });

    test("should reject all empty strings", () => {
      try {
        paymentService.validatePaymentFields("", "", "");
        fail("Expected error");
      } catch (err) {
        expect(err.code).toBe("MISSING_PAYMENT_FIELDS");
      }
    });
  });

  describe("validateAmount()", () => {
    test("should accept valid amount", () => {
      expect(paymentService.validateAmount(500)).toBe(500);
    });

    test("should convert numeric string", () => {
      expect(paymentService.validateAmount("250")).toBe(250);
    });

    test("should reject NaN", () => {
      try {
        paymentService.validateAmount("abc");
        fail("Expected error");
      } catch (err) {
        expect(err.code).toBe("INVALID_AMOUNT");
        expect(err.message).toBe("Invalid payment amount");
      }
    });

    test("should reject zero", () => {
      try {
        paymentService.validateAmount(0);
        fail("Expected error");
      } catch (err) {
        expect(err.code).toBe("INVALID_AMOUNT");
        expect(err.message).toBe("Amount must be greater than zero");
      }
    });

    test("should reject negative amount", () => {
      try {
        paymentService.validateAmount(-100);
        fail("Expected error");
      } catch (err) {
        expect(err.message).toBe("Amount must be greater than zero");
      }
    });

    test("should reject unrealistic amount", () => {
      try {
        paymentService.validateAmount(1000001);
        fail("Expected error");
      } catch (err) {
        expect(err.code).toBe("AMOUNT_TOO_LARGE");
        expect(err.message).toBe("Amount exceeds maximum allowed limit");
      }
    });
  });

  describe("verifySignature()", () => {
    test("should verify a valid Razorpay signature", () => {
      const orderId = "order_ABC123";
      const paymentId = "pay_XYZ123";
      const signature = generateTestSignature(orderId, paymentId, ENV.RAZORPAY_SECRET);

      expect(() => {
        paymentService.verifySignature(orderId, paymentId, signature);
      }).not.toThrow();
    });

    test("should reject invalid signature", () => {
      try {
        paymentService.verifySignature("order1", "payment1", "invalid_signature");
        fail("Expected error");
      } catch (err) {
        expect(err.code).toBe("INVALID_PAYMENT_SIGNATURE");
        expect(err.message).toBe("Invalid payment signature");
      }
    });

    test("should reject modified payment id", () => {
      const signature = generateTestSignature("order123", "payment123", ENV.RAZORPAY_SECRET);

      try {
        paymentService.verifySignature("order123", "payment999", signature);
        fail("Expected error");
      } catch (err) {
        expect(err.code).toBe("INVALID_PAYMENT_SIGNATURE");
      }
    });

    test("should reject modified order id", () => {
      const signature = generateTestSignature("order123", "payment123", ENV.RAZORPAY_SECRET);

      try {
        paymentService.verifySignature("order999", "payment123", signature);
        fail("Expected error");
      } catch (err) {
        expect(err.code).toBe("INVALID_PAYMENT_SIGNATURE");
      }
    });

    test("should throw SIGNATURE_VERIFICATION_FAILED when crypto fails", () => {
      jest.spyOn(crypto, "createHmac").mockImplementationOnce(() => {
        throw new Error("crypto failed");
      });

      try {
        paymentService.verifySignature("order123", "payment123", "signature");
        fail("Expected error");
      } catch (err) {
        expect(err.code).toBe("SIGNATURE_VERIFICATION_FAILED");
        expect(err.message).toBe("Signature verification failed");
      }
    });

    test("should reject signature with different length", () => {
      try {
        paymentService.verifySignature("order123", "payment123", "abc");
        fail("Expected error");
      } catch (err) {
        expect(err.code).toBe("INVALID_PAYMENT_SIGNATURE");
      }
    });

    test("should reject empty signature", () => {
      try {
        paymentService.verifySignature("order123", "payment123", "");
        fail("Expected error");
      } catch (err) {
        expect(err.code).toBe("INVALID_PAYMENT_SIGNATURE");
      }
    });
  });

  describe("validateOwnership()", () => {
    beforeEach(() => {
      jest.clearAllMocks();
      jest.spyOn(User, "findById");
      jest.spyOn(Vendor, "findById");
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    test("should validate user ownership", async () => {
      const mockUser = createUser();
      User.findById.mockImplementation(() => ({
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue(mockUser),
      }));

      await expect(
        paymentService.validateOwnership(
          {
            _id: "txn1",
            userId: { toString: () => mockUser._id.toString() },
          },
          mockUser._id.toString(),
          null,
        ),
      ).resolves.toBeUndefined();
    });

    test("should validate vendor ownership", async () => {
      const mockVendor = createVendor();
      Vendor.findById.mockImplementation(() => ({
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue(mockVendor),
      }));

      await expect(
        paymentService.validateOwnership(
          {
            _id: "txn1",
            vendorId: { toString: () => mockVendor._id.toString() },
          },
          null,
          mockVendor._id.toString(),
        ),
      ).resolves.toBeUndefined();
    });

    test("should reject user ownership mismatch", async () => {
      await expect(
        paymentService.validateOwnership(
          {
            _id: "txn1",
            userId: { toString: () => "userA" },
          },
          "userB",
          null,
        ),
      ).rejects.toMatchObject({
        code: "USER_OWNERSHIP_MISMATCH",
      });
    });

    test("should reject vendor ownership mismatch", async () => {
      await expect(
        paymentService.validateOwnership(
          {
            _id: "txn1",
            vendorId: { toString: () => "vendorA" },
          },
          null,
          "vendorB",
        ),
      ).rejects.toMatchObject({
        code: "VENDOR_OWNERSHIP_MISMATCH",
      });
    });

    test("should throw USER_NOT_FOUND", async () => {
      User.findById.mockImplementation(() => ({
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue(null),
      }));

      await expect(
        paymentService.validateOwnership(
          {
            _id: "txn1",
            userId: { toString: () => "user1" },
          },
          "user1",
          null,
        ),
      ).rejects.toMatchObject({
        code: "USER_NOT_FOUND",
      });
    });

    test("should throw VENDOR_NOT_FOUND", async () => {
      Vendor.findById.mockImplementation(() => ({
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue(null),
      }));

      await expect(
        paymentService.validateOwnership(
          {
            _id: "txn1",
            vendorId: { toString: () => "vendor1" },
          },
          null,
          "vendor1",
        ),
      ).rejects.toMatchObject({
        code: "VENDOR_NOT_FOUND",
      });
    });

    test("should skip user lookup when userId not supplied", async () => {
      const mockVendor = createVendor();
      Vendor.findById.mockImplementation(() => ({
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue(mockVendor),
      }));

      await paymentService.validateOwnership(
        {
          _id: "txn1",
          vendorId: { toString: () => mockVendor._id.toString() },
        },
        null,
        mockVendor._id.toString(),
      );

      expect(User.findById).not.toHaveBeenCalled();
      expect(Vendor.findById).toHaveBeenCalledTimes(1);
    });
  });
});
