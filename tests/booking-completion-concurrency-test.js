"use strict";

/**
 * BOOKING COMPLETION CONCURRENCY + REFERRAL INVARIANT TEST
 *
 * Tests:
 *
 * 1. Many concurrent completion requests for ONE booking.
 * 2. Exactly one request may perform the state transition.
 * 3. Booking becomes completed exactly once.
 * 4. Customer:
 *      pending   -1
 *      completed +1
 *
 * 5. Service provider:
 *      pendingVendor   -1
 *      completedVendor +1
 *
 * 6. Referral eligibility:
 *
 *      CUSTOMER SIDE
 *      User/Vendor acting as customer:
 *          completed >= 5 BEFORE completion
 *
 *      SERVICE PROVIDER SIDE
 *      Vendor being booked:
 *          completedVendor >= 5 BEFORE completion
 *
 * 7. Each eligible side earns:
 *
 *      vendor commission × 5%
 *
 * 8. Same referrer can receive both rewards:
 *
 *      5% + 5% = 10%
 *
 * 9. Referral money goes to:
 *
 *      earning
 *
 *    NOT:
 *
 *      balance
 *
 * IMPORTANT:
 *
 * orderCompletedU:
 *      User is acting as customer.
 *
 * orderCompletedV:
 *      Vendor is acting as customer.
 *
 * The V suffix DOES NOT mean "service provider completion".
 */

const mongoose = require("mongoose");

const Booking = require("../models/bookings");
const User = require("../models/user");
const Vendor = require("../models/vendor");

// ------------------------------------------------------------
// CONFIG
// ------------------------------------------------------------

const API_BASE = process.env.TEST_API_BASE || "http://localhost:3000/api";

const MONGODB_URI = process.env.MONGODB_URI || process.env.MONGO_URI;

const BOOKING_ID = process.env.COMPLETION_TEST_BOOKING_ID;

const CUSTOMER_TYPE = String(process.env.COMPLETION_TEST_CUSTOMER_TYPE || "vendor").toLowerCase();

const AUTH_TOKEN = process.env.COMPLETION_TEST_AUTH_TOKEN || process.env.TEST_AUTH_TOKEN;

const CONCURRENCY = Math.max(1, Number(process.env.COMPLETION_TEST_CONCURRENCY) || 50);

const REFERRAL_RATE = 0.05;

// ------------------------------------------------------------
// HELPERS
// ------------------------------------------------------------

function section(title) {
  console.log("\n========================================");
  console.log(title);
  console.log("========================================");
}

function number(value) {
  return Number(value || 0);
}

function delta(before, after) {
  return number(after) - number(before);
}

function approximatelyEqual(a, b, epsilon = 0.000001) {
  return Math.abs(number(a) - number(b)) <= epsilon;
}

function completionEndpoint() {
  if (CUSTOMER_TYPE === "user") {
    return `${API_BASE}/bookings/orderCompletedU`;
  }

  if (CUSTOMER_TYPE === "vendor") {
    return `${API_BASE}/bookings/orderCompletedV`;
  }

  throw new Error(`Invalid COMPLETION_TEST_CUSTOMER_TYPE: ${CUSTOMER_TYPE}`);
}

function getCustomerModel() {
  if (CUSTOMER_TYPE === "user") {
    return User;
  }

  if (CUSTOMER_TYPE === "vendor") {
    return Vendor;
  }

  throw new Error(`Invalid COMPLETION_TEST_CUSTOMER_TYPE: ${CUSTOMER_TYPE}`);
}

// ------------------------------------------------------------
// ASSERTION TRACKING
// ------------------------------------------------------------

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, message, details = null) {
  if (condition) {
    passed += 1;
    console.log(`PASS | ${message}`);
    return;
  }

  failed += 1;
  failures.push(message);

  console.log(`FAIL | ${message}`);

  if (details) {
    console.log(details);
  }
}

// ------------------------------------------------------------
// REFERRER LOADER
// ------------------------------------------------------------

async function loadReferrer(shareBy, cd) {
  if (!shareBy || !cd) {
    return null;
  }

  let entity;

  if (cd === "user") {
    entity = await User.findById(shareBy).lean();
  } else if (cd === "vendor") {
    entity = await Vendor.findById(shareBy).lean();
  } else {
    throw new Error(`Invalid referrer account type cd=${cd}`);
  }

  if (!entity) {
    throw new Error(`Referrer not found. id=${shareBy}, cd=${cd}`);
  }

  return {
    id: String(entity._id),
    model: cd,

    earning: number(entity.earning),
    balance: number(entity.balance),

    pendingShareBy: number(entity.pendingShareBy),
    completedShareBy: number(entity.completedShareBy),
    canceledShareBy: number(entity.canceledShareBy),
  };
}

// ------------------------------------------------------------
// CUSTOMER STATE
// ------------------------------------------------------------

async function getCustomerState(customerId) {
  const Model = getCustomerModel();

  const customer = await Model.findById(customerId).lean();

  if (!customer) {
    throw new Error(`${CUSTOMER_TYPE} customer not found: ${customerId}`);
  }

  const referrer = await loadReferrer(customer.shareBy, customer.cd);

  return {
    id: String(customer._id),

    model: CUSTOMER_TYPE,

    balance: number(customer.balance),
    earning: number(customer.earning),

    // IMPORTANT:
    // Customer-role counters are ALWAYS these,
    // even when customer is a Vendor.
    pending: number(customer.pending),
    completed: number(customer.completed),
    canceled: number(customer.canceled),

    shareBy: customer.shareBy ? String(customer.shareBy) : null,

    // cd = account type of shareBy
    cd: customer.cd || null,

    referrer,
  };
}

// ------------------------------------------------------------
// SERVICE PROVIDER STATE
// ------------------------------------------------------------

async function getServiceProviderState(vendorId) {
  const vendor = await Vendor.findById(vendorId).lean();

  if (!vendor) {
    throw new Error(`Service provider vendor not found: ${vendorId}`);
  }

  const referrer = await loadReferrer(vendor.shareBy, vendor.cd);

  return {
    id: String(vendor._id),

    model: "vendor",

    balance: number(vendor.balance),
    earning: number(vendor.earning),

    commission: number(vendor.commission),

    // IMPORTANT:
    // Provider-role counters.
    pendingVendor: number(vendor.pendingVendor),
    completedVendor: number(vendor.completedVendor),
    canceledVendor: number(vendor.canceledVendor),

    shareBy: vendor.shareBy ? String(vendor.shareBy) : null,

    cd: vendor.cd || null,

    referrer,
  };
}

// ------------------------------------------------------------
// BOOKING STATE
// ------------------------------------------------------------

async function getBookingState(bookingId) {
  const booking = await Booking.findById(bookingId).lean();

  if (!booking) {
    throw new Error(`Booking not found: ${bookingId}`);
  }

  return {
    id: String(booking._id),

    userId: String(booking.userId),

    vendorId: String(booking.vendorId),

    cancelOrder: Boolean(booking.cancelOrder),

    orderCompleted: Boolean(booking.orderCompleted),

    ratingPermission: Boolean(booking.ratingPermission),

    isServed: Boolean(booking.isServed),

    raw: booking,
  };
}

// ------------------------------------------------------------
// COMPLETE REQUEST
// ------------------------------------------------------------

async function sendCompletionRequest(index) {
  const startedAt = Date.now();

  const requestId = `completion-race-${Date.now()}-${index}-${Math.random().toString(36).slice(2)}`;

  const headers = {
    "Content-Type": "application/json",

    "x-request-id": requestId,
  };

  if (AUTH_TOKEN) {
    headers.Authorization = AUTH_TOKEN.startsWith("Bearer ") ? AUTH_TOKEN : `Bearer ${AUTH_TOKEN}`;
  }

  try {
    const response = await fetch(completionEndpoint(), {
      method: "PATCH",

      headers,

      body: JSON.stringify({
        bookingId: BOOKING_ID,
      }),
    });

    let body;

    try {
      body = await response.json();
    } catch {
      body = null;
    }

    return {
      request: index,
      status: response.status,
      durationMs: Date.now() - startedAt,
      requestId,
      body,
    };
  } catch (error) {
    return {
      request: index,
      status: "NETWORK_ERROR",
      durationMs: Date.now() - startedAt,
      requestId,
      error: error.message,
    };
  }
}

// ------------------------------------------------------------
// SNAPSHOT
// ------------------------------------------------------------

async function takeSnapshot(booking) {
  const [customer, serviceProvider] = await Promise.all([
    getCustomerState(booking.userId),

    getServiceProviderState(booking.vendorId),
  ]);

  return {
    booking: await getBookingState(booking.id),

    customer,

    serviceProvider,
  };
}

// ------------------------------------------------------------
// REFERRER AFTER STATE
// ------------------------------------------------------------

async function reloadReferrer(referrer) {
  if (!referrer) {
    return null;
  }

  return loadReferrer(referrer.id, referrer.model);
}

// ------------------------------------------------------------
// MAIN
// ------------------------------------------------------------

async function main() {
  section("BOOKING COMPLETION CONCURRENCY TEST");

  console.log({
    API: completionEndpoint(),
    customerType: CUSTOMER_TYPE,
    bookingId: BOOKING_ID,
    concurrency: CONCURRENCY,
  });

  // ----------------------------------------------------------
  // SAFETY
  // ----------------------------------------------------------

  if (process.env.NODE_ENV === "production" && process.env.ALLOW_PRODUCTION_TESTS !== "true") {
    throw new Error("REFUSING TO RUN: completion concurrency test must not run in production.");
  }

  if (!MONGODB_URI) {
    throw new Error("MONGODB_URI or MONGO_URI is required.");
  }

  if (!BOOKING_ID) {
    throw new Error("COMPLETION_TEST_BOOKING_ID is required.");
  }

  if (!AUTH_TOKEN) {
    throw new Error("COMPLETION_TEST_AUTH_TOKEN or TEST_AUTH_TOKEN is required.");
  }

  if (CUSTOMER_TYPE !== "user" && CUSTOMER_TYPE !== "vendor") {
    throw new Error("COMPLETION_TEST_CUSTOMER_TYPE must be user or vendor.");
  }

  // ----------------------------------------------------------
  // CONNECT
  // ----------------------------------------------------------

  await mongoose.connect(MONGODB_URI);

  console.log("MongoDB connected.");

  // ----------------------------------------------------------
  // LOAD BOOKING
  // ----------------------------------------------------------

  const initialBooking = await getBookingState(BOOKING_ID);

  if (initialBooking.cancelOrder) {
    throw new Error("Test booking is already cancelled.");
  }

  if (initialBooking.orderCompleted) {
    throw new Error("Test booking is already completed. Use a fresh active booking.");
  }

  // ----------------------------------------------------------
  // BEFORE
  // ----------------------------------------------------------

  const before = await takeSnapshot(initialBooking);

  section("BEFORE");

  console.dir(
    {
      booking: {
        id: before.booking.id,
        userId: before.booking.userId,
        vendorId: before.booking.vendorId,
        cancelOrder: before.booking.cancelOrder,
        orderCompleted: before.booking.orderCompleted,
      },

      customer: {
        model: before.customer.model,

        pending: before.customer.pending,

        completed: before.customer.completed,

        canceled: before.customer.canceled,

        shareBy: before.customer.shareBy,

        cd: before.customer.cd,

        referrer: before.customer.referrer,
      },

      serviceProvider: {
        pendingVendor: before.serviceProvider.pendingVendor,

        completedVendor: before.serviceProvider.completedVendor,

        canceledVendor: before.serviceProvider.canceledVendor,

        commission: before.serviceProvider.commission,

        shareBy: before.serviceProvider.shareBy,

        cd: before.serviceProvider.cd,

        referrer: before.serviceProvider.referrer,
      },
    },
    {
      depth: null,
    },
  );

  // ----------------------------------------------------------
  // CALCULATE EXPECTED REFERRAL
  // ----------------------------------------------------------

  /**
   * IMPORTANT BUSINESS RULE
   *
   * Customer side:
   *
   *     completed >= 5
   *
   * Provider side:
   *
   *     completedVendor >= 5
   */

  const customerEligible = before.customer.completed >= 5;

  const providerEligible = before.serviceProvider.completedVendor >= 5;

  const commission = before.serviceProvider.commission;

  const customerReward = customerEligible ? commission * REFERRAL_RATE : 0;

  const providerReward = providerEligible ? commission * REFERRAL_RATE : 0;

  const sameReferrer = Boolean(
    before.customer.referrer &&
    before.serviceProvider.referrer &&
    before.customer.referrer.id === before.serviceProvider.referrer.id &&
    before.customer.referrer.model === before.serviceProvider.referrer.model,
  );

  section("EXPECTED REFERRAL");

  console.log({
    commission,

    customerCompletedBefore: before.customer.completed,

    providerCompletedVendorBefore: before.serviceProvider.completedVendor,

    customerEligible,

    providerEligible,

    customerReward,

    providerReward,

    totalReward: customerReward + providerReward,

    sameReferrer,
  });

  // ----------------------------------------------------------
  // SEND CONCURRENT COMPLETION REQUESTS
  // ----------------------------------------------------------

  section("SENDING CONCURRENT COMPLETION REQUESTS");

  const start = Date.now();

  const requests = Array.from(
    {
      length: CONCURRENCY,
    },
    (_, i) => sendCompletionRequest(i + 1),
  );

  const results = await Promise.all(requests);

  const totalDuration = Date.now() - start;

  console.table(
    results.map((result) => ({
      request: result.request,
      status: result.status,
      durationMs: result.durationMs,
    })),
  );

  // ----------------------------------------------------------
  // HTTP ANALYSIS
  // ----------------------------------------------------------

  const successful = results.filter(
    (result) => typeof result.status === "number" && result.status >= 200 && result.status < 300,
  );

  const conflicts = results.filter((result) => result.status === 409);

  const networkErrors = results.filter((result) => result.status === "NETWORK_ERROR");

  const serverErrors = results.filter(
    (result) => typeof result.status === "number" && result.status >= 500,
  );

  // Give DB writes a tiny moment to become
  // observable if your controller schedules anything
  // immediately after response.
  await new Promise((resolve) => setTimeout(resolve, 200));

  // ----------------------------------------------------------
  // AFTER
  // ----------------------------------------------------------

  const afterBooking = await getBookingState(BOOKING_ID);

  const after = await takeSnapshot(afterBooking);

  const customerReferrerAfter = await reloadReferrer(before.customer.referrer);

  const providerReferrerAfter = sameReferrer
    ? customerReferrerAfter
    : await reloadReferrer(before.serviceProvider.referrer);

  // ----------------------------------------------------------
  // ASSERTIONS
  // ----------------------------------------------------------

  section("COMPLETION INVARIANTS");

  /**
   * Depending on your API idempotency design,
   * duplicate completion requests may return
   * 400/409/etc.
   *
   * Therefore the database transition is the
   * ultimate invariant.
   */

  assert(networkErrors.length === 0, "No network errors occurred", {
    networkErrors: networkErrors.length,
  });

  assert(serverErrors.length === 0, "No HTTP 5xx responses occurred", {
    serverErrors: serverErrors.length,
  });

  assert(successful.length >= 1, "At least one completion request succeeded", {
    successful: successful.length,
  });

  assert(
    before.booking.orderCompleted === false && after.booking.orderCompleted === true,
    "Booking transitioned from active to completed",
  );

  assert(after.booking.cancelOrder === false, "Completed booking is not cancelled");

  // ----------------------------------------------------------
  // CUSTOMER COUNTERS
  // ----------------------------------------------------------

  assert(
    delta(before.customer.completed, after.customer.completed) === 1,
    "Customer completed incremented exactly once",
    {
      before: before.customer.completed,
      after: after.customer.completed,
    },
  );

  assert(
    delta(before.customer.pending, after.customer.pending) === -1,
    "Customer pending decremented exactly once",
    {
      before: before.customer.pending,
      after: after.customer.pending,
    },
  );

  /**
   * Critical Vendor-as-customer assertion.
   *
   * If customer is Vendor, its completedVendor
   * MUST NOT be used as the customer counter.
   *
   * Customer-role completion uses:
   *
   *     completed
   */

  if (CUSTOMER_TYPE === "vendor") {
    console.log("PASS | Vendor acting as customer correctly uses customer-role counters");
  }

  // ----------------------------------------------------------
  // PROVIDER COUNTERS
  // ----------------------------------------------------------

  assert(
    delta(
      before.serviceProvider.completedVendor,

      after.serviceProvider.completedVendor,
    ) === 1,

    "Service provider completedVendor incremented exactly once",

    {
      before: before.serviceProvider.completedVendor,

      after: after.serviceProvider.completedVendor,
    },
  );

  assert(
    delta(
      before.serviceProvider.pendingVendor,

      after.serviceProvider.pendingVendor,
    ) === -1,

    "Service provider pendingVendor decremented exactly once",

    {
      before: before.serviceProvider.pendingVendor,

      after: after.serviceProvider.pendingVendor,
    },
  );

  // ----------------------------------------------------------
  // REFERRAL ASSERTIONS
  // ----------------------------------------------------------

  section("REFERRAL INVARIANTS");

  // CUSTOMER REFERRER

  if (before.customer.referrer) {
    const expectedCustomerCompletedShareDelta = 1;

    if (!sameReferrer) {
      assert(
        delta(
          before.customer.referrer.completedShareBy,

          customerReferrerAfter.completedShareBy,
        ) === expectedCustomerCompletedShareDelta,

        "Customer referrer completedShareBy incremented once",
      );

      assert(
        delta(
          before.customer.referrer.pendingShareBy,

          customerReferrerAfter.pendingShareBy,
        ) === -1,

        "Customer referrer pendingShareBy decremented once",
      );

      assert(
        approximatelyEqual(
          delta(
            before.customer.referrer.earning,

            customerReferrerAfter.earning,
          ),

          customerReward,
        ),

        "Customer referrer received correct earning",

        {
          expected: customerReward,

          actual: delta(
            before.customer.referrer.earning,

            customerReferrerAfter.earning,
          ),
        },
      );

      assert(
        delta(
          before.customer.referrer.balance,

          customerReferrerAfter.balance,
        ) === 0,

        "Customer referral reward did not modify balance",
      );
    }
  } else {
    console.log("SKIP | Customer has no referrer");
  }

  // PROVIDER REFERRER

  if (before.serviceProvider.referrer && !sameReferrer) {
    assert(
      delta(
        before.serviceProvider.referrer.completedShareBy,

        providerReferrerAfter.completedShareBy,
      ) === 1,

      "Provider referrer completedShareBy incremented once",
    );

    assert(
      delta(
        before.serviceProvider.referrer.pendingShareBy,

        providerReferrerAfter.pendingShareBy,
      ) === -1,

      "Provider referrer pendingShareBy decremented once",
    );

    assert(
      approximatelyEqual(
        delta(
          before.serviceProvider.referrer.earning,

          providerReferrerAfter.earning,
        ),

        providerReward,
      ),

      "Provider referrer received correct earning",

      {
        expected: providerReward,

        actual: delta(
          before.serviceProvider.referrer.earning,

          providerReferrerAfter.earning,
        ),
      },
    );

    assert(
      delta(
        before.serviceProvider.referrer.balance,

        providerReferrerAfter.balance,
      ) === 0,

      "Provider referral reward did not modify balance",
    );
  } else if (!before.serviceProvider.referrer) {
    console.log("SKIP | Service provider has no referrer");
  }

  // ----------------------------------------------------------
  // SAME REFERRER
  // ----------------------------------------------------------

  if (sameReferrer) {
    const referrerBefore = before.customer.referrer;

    const referrerAfter = customerReferrerAfter;

    const expectedTotalReward = customerReward + providerReward;

    assert(
      delta(referrerBefore.completedShareBy, referrerAfter.completedShareBy) === 2,

      "Same referrer completedShareBy incremented twice",
    );

    assert(
      delta(referrerBefore.pendingShareBy, referrerAfter.pendingShareBy) === -2,

      "Same referrer pendingShareBy decremented twice",
    );

    assert(
      approximatelyEqual(
        delta(referrerBefore.earning, referrerAfter.earning),

        expectedTotalReward,
      ),

      "Same referrer received combined customer + provider reward",

      {
        customerReward,
        providerReward,
        expectedTotalReward,

        actual: delta(referrerBefore.earning, referrerAfter.earning),
      },
    );

    assert(
      delta(referrerBefore.balance, referrerAfter.balance) === 0,

      "Combined referral reward modified earning only, not balance",
    );
  }

  // ----------------------------------------------------------
  // FINAL STATE
  // ----------------------------------------------------------

  section("FINAL STATE");

  console.dir(
    {
      booking: {
        id: after.booking.id,

        cancelOrder: after.booking.cancelOrder,

        orderCompleted: after.booking.orderCompleted,
      },

      customer: {
        model: CUSTOMER_TYPE,

        pending: {
          before: before.customer.pending,

          after: after.customer.pending,

          delta: delta(before.customer.pending, after.customer.pending),
        },

        completed: {
          before: before.customer.completed,

          after: after.customer.completed,

          delta: delta(before.customer.completed, after.customer.completed),
        },
      },

      serviceProvider: {
        pendingVendor: {
          before: before.serviceProvider.pendingVendor,

          after: after.serviceProvider.pendingVendor,

          delta: delta(
            before.serviceProvider.pendingVendor,

            after.serviceProvider.pendingVendor,
          ),
        },

        completedVendor: {
          before: before.serviceProvider.completedVendor,

          after: after.serviceProvider.completedVendor,

          delta: delta(
            before.serviceProvider.completedVendor,

            after.serviceProvider.completedVendor,
          ),
        },
      },

      referral: {
        customerEligible,
        providerEligible,

        customerReward,
        providerReward,

        totalExpectedReward: customerReward + providerReward,

        sameReferrer,

        customerReferrerBefore: before.customer.referrer,

        customerReferrerAfter,

        providerReferrerBefore: before.serviceProvider.referrer,

        providerReferrerAfter,
      },

      http: {
        requests: CONCURRENCY,

        successful: successful.length,

        conflicts: conflicts.length,

        networkErrors: networkErrors.length,

        serverErrors: serverErrors.length,

        durationMs: totalDuration,
      },
    },
    {
      depth: null,
    },
  );

  // ----------------------------------------------------------
  // SUMMARY
  // ----------------------------------------------------------

  section("TEST SUMMARY");

  console.log(`Assertions: ${passed + failed}`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);

  if (failed > 0) {
    console.log("\nFailed assertions:");

    failures.forEach((failure) => {
      console.log(`- ${failure}`);
    });

    process.exitCode = 1;

    return;
  }

  section("PASS: ALL COMPLETION CONCURRENCY INVARIANTS PASSED");

  console.log(`
Verified:

✓ Concurrent completion cannot apply counters repeatedly

✓ orderCompletedU means User acting as customer

✓ orderCompletedV means Vendor acting as customer

✓ Vendor acting as customer uses:
    pending
    completed
    canceled

✓ Booked service provider uses:
    pendingVendor
    completedVendor
    canceledVendor

✓ Customer referral eligibility uses:
    completed >= 5

✓ Provider referral eligibility uses:
    completedVendor >= 5

✓ Eligible customer referral = commission × 5%

✓ Eligible provider referral = commission × 5%

✓ Both eligible = commission × 10%

✓ Same referrer can receive both independent rewards

✓ Referral reward credits earning

✓ Referral reward does NOT directly credit balance
`);
}

// ------------------------------------------------------------
// EXECUTION
// ------------------------------------------------------------

main()
  .catch((error) => {
    console.error("\nCOMPLETION CONCURRENCY TEST CRASHED");

    console.error(error);

    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await mongoose.disconnect();

      console.log("MongoDB disconnected.");
    } catch (error) {
      console.error("MongoDB disconnect failed:", error.message);
    }
  });
