"use strict";

const axios = require("axios");

const API_URL = "http://localhost:3000/api/bookings/postToBookingsU";

const CONCURRENT_REQUESTS = 100;

/**
 * IMPORTANT:
 *
 * Replace this payload with the EXACT payload your booking
 * controller currently expects.
 */
const bookingPayload = {
  userId: "6a6874eaf4118f52b8d846d4",
  name: "Nitish",

  vendorId: "6a6878a6698f59feb3e20066",

  bookingDate: "Sun Aug 03 2026",

  type: "labour",

  pincode: "274201",
  phoneNo: "8299400521",
};

async function sendBooking(index) {
  const startedAt = Date.now();

  try {
    const response = await axios.post(API_URL, bookingPayload, {
      headers: {
        "Content-Type": "application/json",

        /**
         * Add authentication if your endpoint requires it.
         *
         * Example:
         */
        Authorization: `Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJwaG9uZU5vIjo3Mzc2NjEwMzYwLCJ1c2VySWQiOiI2YTY4NzRlYWY0MTE4ZjUyYjhkODQ2ZDQiLCJpYXQiOjE3ODU0MDIwMzksImV4cCI6MTc4NTY2MTIzOX0.T2sW3HJXlKVw69flovagBqm95bZF_mqv-6rEEWfXN2Q`,
      },

      /**
       * Don't let a broken request hang forever.
       */
      timeout: 10000,

      /**
       * Treat every HTTP status as a response so that
       * we can inspect 409 responses cleanly.
       */
      validateStatus: () => true,
    });

    return {
      request: index,
      status: response.status,
      durationMs: Date.now() - startedAt,
      data: response.data,
    };
  } catch (error) {
    return {
      request: index,
      status: "NETWORK_ERROR",
      durationMs: Date.now() - startedAt,
      error: error.message,
    };
  }
}

async function run() {
  console.log(`\nSending ${CONCURRENT_REQUESTS} concurrent booking requests...\n`);

  /**
   * Create all promises immediately.
   *
   * DO NOT do:
   *
   * for (...) {
   *   await sendBooking(...)
   * }
   *
   * because that would send requests sequentially.
   */
  const requests = Array.from(
    {
      length: CONCURRENT_REQUESTS,
    },
    (_, index) => sendBooking(index + 1),
  );

  const startedAt = Date.now();

  const results = await Promise.all(requests);

  const totalDuration = Date.now() - startedAt;

  console.table(
    results.map((result) => ({
      request: result.request,
      status: result.status,
      durationMs: result.durationMs,
    })),
  );

  const success = results.filter((result) => result.status >= 200 && result.status < 300);

  const conflicts = results.filter((result) => result.status === 409);

  const unexpected = results.filter(
    (result) => !((result.status >= 200 && result.status < 300) || result.status === 409),
  );

  console.log("\n==============================");
  console.log("TEST SUMMARY");
  console.log("==============================");

  console.log("Total requests:", results.length);

  console.log("Successful bookings:", success.length);

  console.log("409 conflicts:", conflicts.length);

  console.log("Unexpected responses:", unexpected.length);

  console.log("Total duration:", `${totalDuration}ms`);

  console.log("\n==============================");

  if (
    success.length === 1 &&
    conflicts.length === CONCURRENT_REQUESTS - 1 &&
    unexpected.length === 0
  ) {
    console.log("PASS: exactly one booking succeeded.");
  } else {
    console.error("FAIL: unexpected concurrency result.");
  }

  if (unexpected.length > 0) {
    console.log("\nUnexpected responses:");

    console.dir(unexpected, {
      depth: null,
    });
  }
}

run().catch((error) => {
  console.error("Concurrency test crashed:", error);

  process.exit(1);
});
