"use strict";

const { Queue } = require("bullmq");
const { connection } = require("../config/bullmq");

const QUEUE_NAME = "payment-reconciliation";

const paymentReconciliationQueue = new Queue(QUEUE_NAME, {
  connection,
  defaultJobOptions: {
    attempts: 3,

    backoff: {
      type: "exponential",
      delay: 30 * 1000,
    },

    removeOnComplete: 100,
    removeOnFail: 500,
  },
});

/**
 * Register payment reconciliation scheduler.
 *
 * Runs every 10 minutes.
 */
async function setupPaymentReconciliationScheduler() {
  const schedulerId = "payment-reconciliation-every-10-minutes";

  await paymentReconciliationQueue.upsertJobScheduler(
    schedulerId,
    {
      pattern: "*/10 * * * *",
    },
    {
      name: "payment-reconciliation",
      data: {
        type: "PAYMENT_RECONCILIATION",
      },
    },
  );

  // console.log("✅ Payment reconciliation scheduler registered: every 10 minutes");
}

module.exports = {
  paymentReconciliationQueue,
  setupPaymentReconciliationScheduler,
};
