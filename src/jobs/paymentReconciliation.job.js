"use strict";

const cron = require("node-cron");
const paymentService = require("../services/paymentService");
const { PaymentLogger } = require("../logger/index");

let running = false;

function startPaymentReconciliationJob() {
  PaymentLogger.info(
    {
      event: "PAYMENT_RECONCILIATION_JOB_REGISTERED",
      schedule: "*/10 * * * *",
    },
    "Payment reconciliation scheduler registered",
  );

  // Every 10 minutes
  cron.schedule("*/10 * * * *", async () => {
    // Prevent overlapping executions
    if (running) {
      PaymentLogger.warn(
        {
          event: "PAYMENT_RECONCILIATION_ALREADY_RUNNING",
        },
        "Previous reconciliation job is still running",
      );
      return;
    }

    running = true;
    const startedAt = Date.now();

    PaymentLogger.info(
      {
        event: "PAYMENT_RECONCILIATION_JOB_STARTED",
      },
      "Running payment reconciliation job",
    );

    try {
      const result = await paymentService.reconcilePendingPayments();

      PaymentLogger.info(
        {
          event: "PAYMENT_RECONCILIATION_JOB_COMPLETED",
          duration: Date.now() - startedAt,
          ...result,
        },
        "Payment reconciliation job completed",
      );
    } catch (err) {
      PaymentLogger.error(
        {
          err,
          event: "PAYMENT_RECONCILIATION_JOB_FAILED",
          duration: Date.now() - startedAt,
        },
        "Payment reconciliation job failed",
      );
    } finally {
      running = false;
    }
  });
}

module.exports = {
  startPaymentReconciliationJob,
};
