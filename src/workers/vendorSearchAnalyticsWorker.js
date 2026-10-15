"use strict";

const { randomUUID } = require("node:crypto");

const VendorSearchOutbox = require("../../models/VendorSearchOutbox");
const VendorSearchEvent = require("../../models/VendorSearchEvent");

const BATCH_SIZE = 50;
const MAX_ATTEMPTS = 8;
const LEASE_MS = 60_000;
const IDLE_DELAY_MS = 1_000;
const ERROR_DELAY_MS = 3_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function getRetryDelay(attempts) {
  return Math.min(1_000 * 2 ** Math.max(0, attempts - 1), 60_000);
}

/**
 * Move abandoned PROCESSING events to FAILED when
 * their retry budget has been exhausted.
 */
async function recoverExhaustedEvents() {
  const expiredBefore = new Date(Date.now() - LEASE_MS);

  const result = await VendorSearchOutbox.updateMany(
    {
      status: "PROCESSING",
      attempts: { $gte: MAX_ATTEMPTS },
      lockedAt: { $lte: expiredBefore },
    },
    {
      $set: {
        status: "FAILED",
        lastError: "Maximum attempts exhausted after worker lease expired",
        lockedAt: null,
        lockToken: null,
      },
    },
  );

  if (result.modifiedCount > 0) {
    console.error("VENDOR_SEARCH_EXHAUSTED_EVENTS_RECOVERED", {
      count: result.modifiedCount,
    });
  }
}

/**
 * Atomically claim one event.
 * Attempts increments when a processing attempt begins.
 */
async function claimOne() {
  const now = new Date();
  const expiredBefore = new Date(now.getTime() - LEASE_MS);
  const lockToken = randomUUID();

  return VendorSearchOutbox.findOneAndUpdate(
    {
      attempts: { $lt: MAX_ATTEMPTS },
      availableAt: { $lte: now },
      $or: [
        { status: "PENDING" },
        {
          status: "PROCESSING",
          lockedAt: { $lte: expiredBefore },
        },
      ],
    },
    {
      $set: {
        status: "PROCESSING",
        lockedAt: now,
        lockToken,
      },
      $inc: {
        attempts: 1,
      },
    },
    {
      sort: {
        availableAt: 1,
        createdAt: 1,
      },
      new: true,
    },
  ).lean();
}

/**
 * Process one event.
 */
async function processOutboxEvent(event) {
  const ownership = {
    _id: event._id,
    status: "PROCESSING",
    lockToken: event.lockToken,
  };

  try {
    // Idempotent destination write.
    // eventId must have a unique index in vendor_search_events.
    await VendorSearchEvent.updateOne(
      { eventId: event.eventId },
      {
        $setOnInsert: {
          eventId: event.eventId,
          searchBy: event.searchBy,
          searchById: event.searchById,
          sessionId: event.sessionId,
          type: event.type,
          pincode: event.pincode,
          bookingDate: event.bookingDate,
          minRating: event.minRating,
          minWageRate: event.minWageRate,
          page: event.page,
          resultCount: event.resultCount,
          candidateCount: event.candidateCount,
          vendorIds: event.vendorIds,
          cacheHit: event.cacheHit ?? null,
          durationMs: event.durationMs,
          platform: event.platform,
        },
      },
      { upsert: true },
    );

    // Complete only if this worker still owns the event.
    const update = await VendorSearchOutbox.updateOne(ownership, {
      $set: {
        status: "COMPLETED",
        processedAt: new Date(),
        lastError: null,
        lockedAt: null,
        lockToken: null,
      },
    });

    if (update.matchedCount === 0) {
      console.warn("VENDOR_SEARCH_OUTBOX_LOCK_LOST", {
        eventId: event.eventId,
      });
    }
  } catch (error) {
    const attempts = event.attempts;
    const permanentlyFailed = attempts >= MAX_ATTEMPTS;

    try {
      const retryUpdate = await VendorSearchOutbox.updateOne(ownership, {
        $set: {
          status: permanentlyFailed ? "FAILED" : "PENDING",
          availableAt: new Date(Date.now() + getRetryDelay(attempts)),
          lastError: String(error.message || error).slice(0, 2000),
          lockedAt: null,
          lockToken: null,
        },
      });

      if (retryUpdate.matchedCount === 0) {
        console.warn("VENDOR_SEARCH_OUTBOX_LOCK_LOST", {
          eventId: event.eventId,
        });
      }
    } catch (retryError) {
      // Leave the event recoverable if this update also fails.
      console.error("VENDOR_SEARCH_OUTBOX_RETRY_UPDATE_FAILED", {
        eventId: event.eventId,
        message: retryError.message,
      });
    }

    console.error("VENDOR_SEARCH_OUTBOX_PROCESSING_FAILED", {
      eventId: event.eventId,
      attempts,
      permanentlyFailed,
      message: error.message,
    });
  }
}

/**
 * Process up to BATCH_SIZE events.
 */
async function runOnce() {
  await recoverExhaustedEvents();

  let processed = 0;

  for (let i = 0; i < BATCH_SIZE; i += 1) {
    const event = await claimOne();

    if (!event) {
      break;
    }

    await processOutboxEvent(event);
    processed += 1;
  }

  return processed;
}

/**
 * Continuously process pending events.
 */
async function run() {
  console.log("Vendor Search Analytics Worker started");

  while (true) {
    try {
      const processed = await runOnce();

      if (processed === 0) {
        await sleep(IDLE_DELAY_MS);
      }
    } catch (error) {
      console.error("VENDOR_SEARCH_ANALYTICS_WORKER_ERROR", {
        message: error.message,
      });

      await sleep(ERROR_DELAY_MS);
    }
  }
}

module.exports = {
  run,
  runOnce,
};
