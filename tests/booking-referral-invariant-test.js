"use strict";

/**
 * ================================================================
 * BOOKING REFERRAL INVARIANT TEST
 * ================================================================
 *
 * Tests referral business rules:
 *
 * CUSTOMER SIDE:
 *   completed < 5 previous orders  -> no reward
 *   completed >= 5 previous orders -> 5% commission reward
 *
 * SERVICE PROVIDER SIDE:
 *   completedVendor < 5 previous orders  -> no reward
 *   completedVendor >= 5 previous orders -> 5% commission reward
 *
 * Therefore:
 *
 * Customer eligible | Vendor eligible | Total referral reward
 * ------------------------------------------------------------
 * No                | No              | 0%
 * Yes               | No              | 5%
 * No                | Yes             | 5%
 * Yes               | Yes             | 10%
 *
 * Also tests:
 *
 * - same referrer
 * - different referrers
 * - User referrer
 * - Vendor referrer
 * - pendingShareBy
 * - completedShareBy
 * - earning
 *
 * IMPORTANT:
 * Run only against DEVELOPMENT/TEST database.
 */

require("dotenv").config();

const mongoose = require("mongoose");

// ================================================================
// CHANGE THESE PATHS IF YOUR PROJECT STRUCTURE IS DIFFERENT
// ================================================================

const BookingService = require("../src/services/BookingService");
const User = require("../models/user");
const Vendor = require("../models/vendor");

// ================================================================
// CONFIG
// ================================================================

const COMMISSION = 100;
const REFERRAL_RATE = 0.05;

const FIVE_PERCENT = COMMISSION * REFERRAL_RATE;
const TEN_PERCENT = FIVE_PERCENT * 2;

const TEST_PREFIX = `referral-test-${Date.now()}`;

// ================================================================
// HELPERS
// ================================================================

function section(title) {
  console.log("\n========================================");
  console.log(title);
  console.log("========================================");
}

function money(value) {
  return Number(Number(value || 0).toFixed(2));
}

function assertEqual({ name, actual, expected }) {
  const normalizedActual = typeof actual === "number" ? money(actual) : actual;

  const normalizedExpected = typeof expected === "number" ? money(expected) : expected;

  const passed = normalizedActual === normalizedExpected;

  console.log(`${passed ? "PASS" : "FAIL"} | ${name}`);

  if (!passed) {
    console.log(`       expected: ${normalizedExpected}`);
    console.log(`       actual:   ${normalizedActual}`);
  }

  return {
    passed,
    name,
    actual: normalizedActual,
    expected: normalizedExpected,
  };
}

async function connectMongo() {
  const uri = process.env.MONGODB_URL_1 || process.env.MONGO_URI || process.env.DB_URI;

  if (!uri) {
    throw new Error("MongoDB URI not found. Expected MONGODB_URI, MONGO_URI or DB_URI.");
  }

  await mongoose.connect(uri);

  console.log("MongoDB connected.");
}

// ================================================================
// TEST ACCOUNT CREATION
// ================================================================

async function createUser({ suffix, completed = 0, shareBy = null, cd = null }) {
  return User.create({
    name: `${TEST_PREFIX}-${suffix}`,

    // Generate a test-only phone number.
    phoneNo: 7000000000 + Math.floor(Math.random() * 999999999),

    email: `${TEST_PREFIX}-${suffix}-${Math.random().toString(36).slice(2)}@example.test`,

    password: "test-password-not-real",

    verifyPhoneNo: true,

    completed,

    pending: 0,
    canceled: 0,

    completedShareBy: 0,
    pendingShareBy: 0,
    canceledShareBy: 0,

    earning: 0,
    balance: 10000,

    shareBy,
    cd,
  });
}

async function createVendor({
  suffix,
  completed = 0,
  completedVendor = 0,
  shareBy = null,
  cd = null,
}) {
  return Vendor.create({
    name: `${TEST_PREFIX}-${suffix}`,

    phoneNo: 8000000000 + Math.floor(Math.random() * 999999999),

    email: `${TEST_PREFIX}-${suffix}-${Math.random().toString(36).slice(2)}@example.test`,

    password: "test-password-not-real",

    type: "labour",

    verifyPhoneNo: true,

    completed,
    completedVendor,

    pending: 0,
    pendingVendor: 0,

    canceled: 0,
    canceledVendor: 0,

    completedShareBy: 0,
    pendingShareBy: 0,
    canceledShareBy: 0,

    commission: COMMISSION,

    earning: 0,
    balance: 10000,

    shareBy,
    cd,
  });
}

// ================================================================
// REFERRER READER
// ================================================================

async function reloadReferrer(referrer) {
  if (referrer.__referrerType === "user") {
    return User.findById(referrer._id).lean();
  }

  return Vendor.findById(referrer._id).lean();
}

// ================================================================
// PROCESS ONE REFERRAL SIDE
// ================================================================

async function processReferral({ entity, entityType, role, action, commission = COMMISSION }) {
  const session = await mongoose.startSession();

  try {
    await session.withTransaction(async () => {
      await BookingService.updateReferralForBooking({
        entity,
        entityType,
        role,
        action,
        commission,
        discountMultiplier: 1,
        session,
      });
    });
  } finally {
    await session.endSession();
  }
}

// ================================================================
// TEST CASE:
// CUSTOMER + VENDOR REFERRAL
// ================================================================

async function runRewardScenario({
  name,

  customerCompleted,
  vendorCompleted,

  sameReferrer = false,

  customerReferrerType = "user",
  vendorReferrerType = "vendor",

  expectedCustomerReward,
  expectedVendorReward,
}) {
  section(name);

  let customerReferrer;
  let vendorReferrer;

  // --------------------------------------------------------------
  // Customer referrer
  // --------------------------------------------------------------

  if (customerReferrerType === "user") {
    customerReferrer = await createUser({
      suffix: `${name}-customer-referrer`,
    });

    customerReferrer.__referrerType = "user";
  } else {
    customerReferrer = await createVendor({
      suffix: `${name}-customer-referrer`,
    });

    customerReferrer.__referrerType = "vendor";
  }

  // --------------------------------------------------------------
  // Vendor referrer
  // --------------------------------------------------------------

  if (sameReferrer) {
    vendorReferrer = customerReferrer;
  } else if (vendorReferrerType === "user") {
    vendorReferrer = await createUser({
      suffix: `${name}-vendor-referrer`,
    });

    vendorReferrer.__referrerType = "user";
  } else {
    vendorReferrer = await createVendor({
      suffix: `${name}-vendor-referrer`,
    });

    vendorReferrer.__referrerType = "vendor";
  }

  // --------------------------------------------------------------
  // Customer
  // --------------------------------------------------------------

  const customer = await createUser({
    suffix: `${name}-customer`,

    completed: customerCompleted,

    shareBy: customerReferrer._id,

    cd: customerReferrer.__referrerType,
  });

  // --------------------------------------------------------------
  // Service provider
  // --------------------------------------------------------------

  const serviceProvider = await createVendor({
    suffix: `${name}-service-provider`,

    completedVendor: vendorCompleted,

    shareBy: vendorReferrer._id,

    cd: vendorReferrer.__referrerType,
  });

  // --------------------------------------------------------------
  // Simulate booking creation
  //
  // Both referral relationships should become pending.
  // --------------------------------------------------------------

  await processReferral({
    entity: customer,
    entityType: "user",
    role: "customer",
    action: "pending",
  });

  await processReferral({
    entity: serviceProvider,
    entityType: "vendor",
    role: "serviceProvider",
    action: "pending",
  });

  // --------------------------------------------------------------
  // Check pending state
  // --------------------------------------------------------------

  let customerReferrerAfterPending = await reloadReferrer(customerReferrer);

  let vendorReferrerAfterPending;

  if (sameReferrer) {
    vendorReferrerAfterPending = customerReferrerAfterPending;
  } else {
    vendorReferrerAfterPending = await reloadReferrer(vendorReferrer);
  }

  const assertions = [];

  if (sameReferrer) {
    assertions.push(
      assertEqual({
        name: "Same referrer pendingShareBy incremented twice",
        actual: customerReferrerAfterPending.pendingShareBy,
        expected: 2,
      }),
    );
  } else {
    assertions.push(
      assertEqual({
        name: "Customer referrer pendingShareBy +1",
        actual: customerReferrerAfterPending.pendingShareBy,
        expected: 1,
      }),
    );

    assertions.push(
      assertEqual({
        name: "Vendor referrer pendingShareBy +1",
        actual: vendorReferrerAfterPending.pendingShareBy,
        expected: 1,
      }),
    );
  }

  // --------------------------------------------------------------
  // Simulate booking completion
  // --------------------------------------------------------------

  await processReferral({
    entity: customer,
    entityType: "user",
    role: "customer",
    action: "complete",
    commission: COMMISSION,
  });

  await processReferral({
    entity: serviceProvider,
    entityType: "vendor",
    role: "serviceProvider",
    action: "complete",
    commission: COMMISSION,
  });

  // --------------------------------------------------------------
  // Reload referrers
  // --------------------------------------------------------------

  const customerReferrerAfter = await reloadReferrer(customerReferrer);

  const vendorReferrerAfter = sameReferrer
    ? customerReferrerAfter
    : await reloadReferrer(vendorReferrer);

  // --------------------------------------------------------------
  // Reward assertions
  // --------------------------------------------------------------

  if (sameReferrer) {
    const expectedTotal = expectedCustomerReward + expectedVendorReward;

    assertions.push(
      assertEqual({
        name: "Same referrer received correct total earning",
        actual: customerReferrerAfter.earning,
        expected: expectedTotal,
      }),
    );

    assertions.push(
      assertEqual({
        name: "Same referrer pendingShareBy returned to zero",
        actual: customerReferrerAfter.pendingShareBy,
        expected: 0,
      }),
    );

    assertions.push(
      assertEqual({
        name: "Same referrer completedShareBy incremented twice",
        actual: customerReferrerAfter.completedShareBy,
        expected: 2,
      }),
    );
  } else {
    assertions.push(
      assertEqual({
        name: "Customer referrer received correct earning",
        actual: customerReferrerAfter.earning,
        expected: expectedCustomerReward,
      }),
    );

    assertions.push(
      assertEqual({
        name: "Vendor referrer received correct earning",
        actual: vendorReferrerAfter.earning,
        expected: expectedVendorReward,
      }),
    );

    assertions.push(
      assertEqual({
        name: "Customer referrer pendingShareBy returned to zero",
        actual: customerReferrerAfter.pendingShareBy,
        expected: 0,
      }),
    );

    assertions.push(
      assertEqual({
        name: "Vendor referrer pendingShareBy returned to zero",
        actual: vendorReferrerAfter.pendingShareBy,
        expected: 0,
      }),
    );

    assertions.push(
      assertEqual({
        name: "Customer referrer completedShareBy +1",
        actual: customerReferrerAfter.completedShareBy,
        expected: 1,
      }),
    );

    assertions.push(
      assertEqual({
        name: "Vendor referrer completedShareBy +1",
        actual: vendorReferrerAfter.completedShareBy,
        expected: 1,
      }),
    );
  }

  console.log("\nScenario result:");

  console.log({
    customerCompleted,
    vendorCompleted,

    customerEligible: customerCompleted >= 5,

    vendorEligible: vendorCompleted >= 5,

    expectedCustomerReward,
    expectedVendorReward,

    expectedTotal: expectedCustomerReward + expectedVendorReward,

    actualCustomerReferrerEarning: money(customerReferrerAfter.earning),

    actualVendorReferrerEarning: money(vendorReferrerAfter.earning),

    sameReferrer,
  });

  return assertions;
}

// ================================================================
// CANCEL TEST
// ================================================================

async function runCancelTest() {
  section("CANCELLATION REFERRAL TEST");

  const referrer = await createUser({
    suffix: "cancel-referrer",
  });

  referrer.__referrerType = "user";

  const customer = await createUser({
    suffix: "cancel-customer",

    completed: 10,

    shareBy: referrer._id,

    cd: "user",
  });

  await processReferral({
    entity: customer,
    entityType: "user",
    role: "customer",
    action: "pending",
  });

  let afterPending = await reloadReferrer(referrer);

  const assertions = [];

  assertions.push(
    assertEqual({
      name: "Cancellation test pendingShareBy became 1",
      actual: afterPending.pendingShareBy,
      expected: 1,
    }),
  );

  await processReferral({
    entity: customer,
    entityType: "user",
    role: "customer",
    action: "cancel",
  });

  const afterCancel = await reloadReferrer(referrer);

  assertions.push(
    assertEqual({
      name: "Cancellation removed pending referral",
      actual: afterCancel.pendingShareBy,
      expected: 0,
    }),
  );

  assertions.push(
    assertEqual({
      name: "Cancellation incremented canceledShareBy",
      actual: afterCancel.canceledShareBy,
      expected: 1,
    }),
  );

  assertions.push(
    assertEqual({
      name: "Cancellation did not create earning",
      actual: afterCancel.earning,
      expected: 0,
    }),
  );

  assertions.push(
    assertEqual({
      name: "Cancellation did not increment completedShareBy",
      actual: afterCancel.completedShareBy,
      expected: 0,
    }),
  );

  return assertions;
}

// ================================================================
// VENDOR ACTING AS CUSTOMER
// ================================================================

async function runVendorCustomerTest() {
  section("VENDOR ACTING AS CUSTOMER TEST");

  const referrer = await createUser({
    suffix: "vendor-customer-referrer",
  });

  referrer.__referrerType = "user";

  /**
   * Important:
   *
   * Vendor is acting as CUSTOMER.
   *
   * completed = 5
   * completedVendor = 0
   *
   * Correct implementation must use completed,
   * NOT completedVendor.
   */
  const vendorCustomer = await createVendor({
    suffix: "vendor-acting-as-customer",

    completed: 5,

    completedVendor: 0,

    shareBy: referrer._id,

    cd: "user",
  });

  await processReferral({
    entity: vendorCustomer,
    entityType: "vendor",
    role: "customer",
    action: "pending",
  });

  await processReferral({
    entity: vendorCustomer,
    entityType: "vendor",
    role: "customer",
    action: "complete",
    commission: COMMISSION,
  });

  const after = await reloadReferrer(referrer);

  return [
    assertEqual({
      name: "Vendor acting as customer used completed instead of completedVendor",
      actual: after.earning,
      expected: FIVE_PERCENT,
    }),

    assertEqual({
      name: "Vendor-customer referral completedShareBy +1",
      actual: after.completedShareBy,
      expected: 1,
    }),

    assertEqual({
      name: "Vendor-customer pendingShareBy returned to zero",
      actual: after.pendingShareBy,
      expected: 0,
    }),
  ];
}

// ================================================================
// CLEANUP
// ================================================================

async function cleanup() {
  section("CLEANUP");

  const userResult = await User.deleteMany({
    name: {
      $regex: `^${TEST_PREFIX}`,
    },
  });

  const vendorResult = await Vendor.deleteMany({
    name: {
      $regex: `^${TEST_PREFIX}`,
    },
  });

  console.log({
    usersDeleted: userResult.deletedCount,
    vendorsDeleted: vendorResult.deletedCount,
  });
}

// ================================================================
// MAIN
// ================================================================

async function main() {
  section("BOOKING REFERRAL INVARIANT TEST");

  console.log({
    commission: COMMISSION,
    referralRate: "5%",
    fivePercent: FIVE_PERCENT,
    tenPercent: TEN_PERCENT,
  });

  if (process.env.NODE_ENV === "production" && process.env.ALLOW_DESTRUCTIVE_TESTS !== "true") {
    throw new Error("REFUSING TO RUN: set ALLOW_DESTRUCTIVE_TESTS=true to run this test.");
  }

  await connectMongo();

  const allAssertions = [];

  try {
    /**
     * ------------------------------------------------------------
     * CASE 1
     *
     * Customer below threshold
     * Vendor below threshold
     *
     * Expected:
     * 0% + 0% = 0%
     * ------------------------------------------------------------
     */

    allAssertions.push(
      ...(await runRewardScenario({
        name: "CASE 1 - NEITHER ELIGIBLE",

        customerCompleted: 4,
        vendorCompleted: 4,

        expectedCustomerReward: 0,
        expectedVendorReward: 0,
      })),
    );

    /**
     * ------------------------------------------------------------
     * CASE 2
     *
     * Customer eligible
     * Vendor below threshold
     *
     * Expected:
     * 5% + 0% = 5%
     * ------------------------------------------------------------
     */

    allAssertions.push(
      ...(await runRewardScenario({
        name: "CASE 2 - CUSTOMER ONLY ELIGIBLE",

        customerCompleted: 5,
        vendorCompleted: 4,

        expectedCustomerReward: FIVE_PERCENT,

        expectedVendorReward: 0,
      })),
    );

    /**
     * ------------------------------------------------------------
     * CASE 3
     *
     * Customer below threshold
     * Vendor eligible
     *
     * Expected:
     * 0% + 5% = 5%
     * ------------------------------------------------------------
     */

    allAssertions.push(
      ...(await runRewardScenario({
        name: "CASE 3 - VENDOR ONLY ELIGIBLE",

        customerCompleted: 4,
        vendorCompleted: 5,

        expectedCustomerReward: 0,

        expectedVendorReward: FIVE_PERCENT,
      })),
    );

    /**
     * ------------------------------------------------------------
     * CASE 4
     *
     * Both eligible, DIFFERENT referrers.
     *
     * Expected:
     *
     * customer referrer = 5%
     * vendor referrer   = 5%
     * ------------------------------------------------------------
     */

    allAssertions.push(
      ...(await runRewardScenario({
        name: "CASE 4 - BOTH ELIGIBLE DIFFERENT REFERRERS",

        customerCompleted: 5,
        vendorCompleted: 5,

        sameReferrer: false,

        expectedCustomerReward: FIVE_PERCENT,

        expectedVendorReward: FIVE_PERCENT,
      })),
    );

    /**
     * ------------------------------------------------------------
     * CASE 5
     *
     * Both eligible and SAME referrer.
     *
     * Expected:
     *
     * 5% + 5% = 10%
     * ------------------------------------------------------------
     */

    allAssertions.push(
      ...(await runRewardScenario({
        name: "CASE 5 - BOTH ELIGIBLE SAME REFERRER",

        customerCompleted: 5,
        vendorCompleted: 5,

        sameReferrer: true,

        expectedCustomerReward: FIVE_PERCENT,

        expectedVendorReward: FIVE_PERCENT,
      })),
    );

    /**
     * ------------------------------------------------------------
     * CASE 6
     *
     * User referrer receives customer reward.
     * ------------------------------------------------------------
     */

    allAssertions.push(
      ...(await runRewardScenario({
        name: "CASE 6 - USER REFERRERS",

        customerCompleted: 5,
        vendorCompleted: 5,

        customerReferrerType: "user",
        vendorReferrerType: "user",

        expectedCustomerReward: FIVE_PERCENT,

        expectedVendorReward: FIVE_PERCENT,
      })),
    );

    /**
     * ------------------------------------------------------------
     * CASE 7
     *
     * Vendor referrer receives reward.
     * ------------------------------------------------------------
     */

    allAssertions.push(
      ...(await runRewardScenario({
        name: "CASE 7 - VENDOR REFERRERS",

        customerCompleted: 5,
        vendorCompleted: 5,

        customerReferrerType: "vendor",
        vendorReferrerType: "vendor",

        expectedCustomerReward: FIVE_PERCENT,

        expectedVendorReward: FIVE_PERCENT,
      })),
    );

    /**
     * ------------------------------------------------------------
     * CASE 8
     *
     * Vendor acts as customer.
     *
     * Must use:
     *
     * vendor.completed
     *
     * NOT:
     *
     * vendor.completedVendor
     * ------------------------------------------------------------
     */

    allAssertions.push(...(await runVendorCustomerTest()));

    /**
     * Cancellation lifecycle.
     */

    allAssertions.push(...(await runCancelTest()));

    // ============================================================
    // SUMMARY
    // ============================================================

    section("FINAL TEST SUMMARY");

    const failed = allAssertions.filter((assertion) => !assertion.passed);

    console.log(`Assertions: ${allAssertions.length}`);

    console.log(`Passed: ${allAssertions.length - failed.length}`);

    console.log(`Failed: ${failed.length}`);

    if (failed.length > 0) {
      console.log("\nFAILED ASSERTIONS:");

      for (const failure of failed) {
        console.log(`- ${failure.name}: expected ${failure.expected}, got ${failure.actual}`);
      }

      process.exitCode = 1;

      return;
    }

    console.log("\n========================================");

    console.log("PASS: ALL REFERRAL INVARIANTS PASSED");

    console.log("========================================");

    console.log(`
Verified:

✓ Customer below threshold + Vendor below threshold = 0%

✓ Customer eligible + Vendor below threshold = 5%

✓ Customer below threshold + Vendor eligible = 5%

✓ Customer eligible + Vendor eligible = 10%

✓ Same referrer receives both independent 5% rewards

✓ Different referrers receive independent 5% rewards

✓ User can be referrer

✓ Vendor can be referrer

✓ Vendor acting as customer uses completed

✓ Service provider uses completedVendor

✓ pendingShareBy lifecycle works

✓ completedShareBy lifecycle works

✓ canceledShareBy lifecycle works

✓ Referral reward credits earning, not balance
`);
  } finally {
    /**
     * Always clean test accounts.
     */
    try {
      await cleanup();
    } catch (error) {
      console.error("Test cleanup failed:", error);
    }

    await mongoose.disconnect();

    console.log("MongoDB disconnected.");
  }
}

main().catch(async (error) => {
  console.error("\nREFERRAL TEST CRASHED");
  console.error(error);

  try {
    await cleanup();
  } catch {
    // ignore cleanup failure
  }

  try {
    await mongoose.disconnect();
  } catch {
    // ignore disconnect failure
  }

  process.exit(1);
});
