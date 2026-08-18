"use strict";

const axios = require("axios");

/**
 * ============================================================
 * CONFIGURATION
 * ============================================================
 *
 * Replace these with your actual routes.
 */
const BASE_URL = "http://localhost:3000";

const BOOKING_ID = "YOUR_ACTIVE_BOOKING_ID";

/**
 * Replace these routes with your real endpoints.
 *
 * Examples:
 * /api/booking/cancel/:id
 * /api/booking/complete/:id
 */
const CANCEL_URL = `${BASE_URL}/api/bookings/cancelOrderU`;

const COMPLETE_URL = `${BASE_URL}/api/bookings/orderCompletedU`;

/**
 * Add your development authentication token if required.
 *
 * Do NOT commit a real production token.
 */
const TOKEN = `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJwaG9uZU5vIjo3Mzc2NjEwMzYwLCJ1c2VySWQiOiI2YTY4NzRlYWY0MTE4ZjUyYjhkODQ2ZDQiLCJpYXQiOjE3ODU0MDIwMzksImV4cCI6MTc4NTY2MTIzOX0.T2sW3HJXlKVw69flovagBqm95bZF_mqv-6rEEWfXN2Q`;

/**
 * Number of simultaneous requests of EACH type.
 *
 * 20 cancel + 20 complete = 40 total.
 */
const CANCEL_REQUESTS = 20;
const COMPLETE_REQUESTS = 20;

/**
 * Change HTTP methods if your routes use PATCH/PUT instead.
 */
const CANCEL_METHOD = "patch";
const COMPLETE_METHOD = "patch";

function headers() {
  const result = {
    "Content-Type": "application/json",
  };

  if (TOKEN && TOKEN !== "YOUR_DEV_TOKEN") {
    result.Authorization = `Bearer ${TOKEN}`;
  }

  return result;
}

async function sendRequest({ index, operation, url, method }) {
  const startedAt = Date.now();

  try {
    const response = await axios({
      method,
      url,

      headers: headers(),

      /**
       * Add request body here if your controller requires one.
       */
      data: {bookingId:"6a6b170d3b0e8e943f3f76fe"},

      timeout: 10000,

      /**
       * We want to inspect 409/400/etc rather than Axios
       * throwing for them.
       */
      validateStatus: () => true,
    });

    return {
      index,
      operation,
      status: response.status,
      durationMs: Date.now() - startedAt,
      data: response.data,
    };
  } catch (error) {
    return {
      index,
      operation,
      status: "NETWORK_ERROR",
      durationMs: Date.now() - startedAt,
      error: error.message,
    };
  }
}

async function run() {
  console.log("\n========================================");
  console.log("BOOKING CANCEL vs COMPLETE RACE TEST");
  console.log("========================================");

  console.log("Booking:", BOOKING_ID);
  console.log("Cancel requests:", CANCEL_REQUESTS);
  console.log("Complete requests:", COMPLETE_REQUESTS);
  console.log("Total:", CANCEL_REQUESTS + COMPLETE_REQUESTS);

  /**
   * ----------------------------------------------------------
   * Build CANCEL requests
   * ----------------------------------------------------------
   */
  const cancelRequests = Array.from({ length: CANCEL_REQUESTS }, (_, index) =>
    sendRequest({
      index: index + 1,
      operation: "CANCEL",
      url: CANCEL_URL,
      method: CANCEL_METHOD,
    }),
  );

  /**
   * ----------------------------------------------------------
   * Build COMPLETE requests
   * ----------------------------------------------------------
   */
  const completeRequests = Array.from({ length: COMPLETE_REQUESTS }, (_, index) =>
    sendRequest({
      index: index + 1,
      operation: "COMPLETE",
      url: COMPLETE_URL,
      method: COMPLETE_METHOD,
    }),
  );

  /**
   * IMPORTANT:
   *
   * Both groups are created before Promise.all().
   * This makes cancel and complete requests race each other.
   */
  const requests = [...cancelRequests, ...completeRequests];

  const startedAt = Date.now();

  const results = await Promise.all(requests);

  const totalDuration = Date.now() - startedAt;

  /**
   * ----------------------------------------------------------
   * DISPLAY RESULTS
   * ----------------------------------------------------------
   */

  console.table(
    results.map((result) => ({
      operation: result.operation,
      request: result.index,
      status: result.status,
      durationMs: result.durationMs,
    })),
  );

  /**
   * ----------------------------------------------------------
   * GROUP RESULTS
   * ----------------------------------------------------------
   */

  const cancelResults = results.filter((result) => result.operation === "CANCEL");

  const completeResults = results.filter((result) => result.operation === "COMPLETE");

  const cancelSuccess = cancelResults.filter(
    (result) => typeof result.status === "number" && result.status >= 200 && result.status < 300,
  );

  const completeSuccess = completeResults.filter(
    (result) => typeof result.status === "number" && result.status >= 200 && result.status < 300,
  );

  const networkErrors = results.filter((result) => result.status === "NETWORK_ERROR");

  const serverErrors = results.filter(
    (result) => typeof result.status === "number" && result.status >= 500,
  );

  console.log("\n========================================");
  console.log("TEST SUMMARY");
  console.log("========================================");

  console.log("Cancel successes:", cancelSuccess.length);

  console.log("Complete successes:", completeSuccess.length);

  console.log("Network errors:", networkErrors.length);

  console.log("Server errors:", serverErrors.length);

  console.log("Total duration:", `${totalDuration}ms`);

  console.log("\nIMPORTANT: HTTP success count alone does not");

  console.log("determine PASS/FAIL because your endpoints may");

  console.log("intentionally be idempotent.");

  if (networkErrors.length > 0) {
    console.error("\nFAIL: network errors occurred.");
  }

  if (serverErrors.length > 0) {
    console.error("\nFAIL: HTTP 5xx responses occurred.");
  }

  console.log("\nNow verify the final MongoDB booking state.");
}

run().catch((error) => {
  console.error("Race test crashed:", error);

  process.exit(1);
});
