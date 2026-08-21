"use strict";

const { Worker } = require("bullmq");

const { connection } = require("../config/bullmq");
const paymentService = require("../services/paymentService");
const { PaymentLogger } = require("../logger/index");

const QUEUE_NAME = "payment-reconciliation";

const worker = new Worker(
  QUEUE_NAME,

  async (job) => {
    const startedAt = Date.now();

    PaymentLogger.info(
      {
        event: "PAYMENT_RECONCILIATION_JOB_STARTED",
        queue: QUEUE_NAME,
        jobId: job.id,
        attempt: job.attemptsMade + 1,
      },
      "Running payment reconciliation job",
    );

    try {
      const result = await paymentService.reconcilePendingPayments();

      PaymentLogger.info(
        {
          event: "PAYMENT_RECONCILIATION_JOB_COMPLETED",

          queue: QUEUE_NAME,

          jobId: job.id,

          duration: Date.now() - startedAt,

          ...result,
        },
        "Payment reconciliation job completed",
      );

      return result;
    } catch (error) {
      PaymentLogger.error(
        {
          event: "PAYMENT_RECONCILIATION_JOB_FAILED",

          queue: QUEUE_NAME,

          jobId: job.id,

          attemptsMade: job.attemptsMade,

          duration: Date.now() - startedAt,

          err: error,
        },
        "Payment reconciliation job failed",
      );

      throw error;
    }
  },

  {
    connection,

    // Only one reconciliation job at a time.
    concurrency: 1,
  },
);

// ============================================================
// Worker events
// ============================================================

worker.on("ready", () => {
  PaymentLogger.info(
    {
      event: "PAYMENT_RECONCILIATION_WORKER_READY",
      queue: QUEUE_NAME,
    },
    "Payment reconciliation worker ready",
  );
});

worker.on("active", (job) => {
  PaymentLogger.debug(
    {
      event: "PAYMENT_RECONCILIATION_JOB_ACTIVE",
      queue: QUEUE_NAME,
      jobId: job.id,
    },
    "Payment reconciliation job started processing",
  );
});

worker.on("completed", (job, result) => {
  PaymentLogger.info(
    {
      event: "PAYMENT_RECONCILIATION_WORKER_COMPLETED",
      queue: QUEUE_NAME,
      jobId: job.id,
      result,
    },
    "Payment reconciliation worker completed job",
  );
});

worker.on("failed", (job, error) => {
  PaymentLogger.error(
    {
      event: "PAYMENT_RECONCILIATION_WORKER_FAILED",
      queue: QUEUE_NAME,
      jobId: job?.id,
      attemptsMade: job?.attemptsMade,
      err: error,
    },
    "Payment reconciliation worker failed job",
  );
});

worker.on("error", (error) => {
  PaymentLogger.error(
    {
      event: "PAYMENT_RECONCILIATION_WORKER_ERROR",
      queue: QUEUE_NAME,
      err: error,
    },
    "Payment reconciliation worker error",
  );
});

module.exports = worker;
