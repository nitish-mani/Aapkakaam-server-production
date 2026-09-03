"use strict";

require("dotenv").config();

const connectDatabase = require("./config/database");

const setupLowBalanceScheduler = require("./schedulers/lowBalance.scheduler");

const { setupPaymentReconciliationScheduler } = require("./queues/paymentReconciliation.queue");

const NotificationOutboxService = require("./services/NotificationOutboxService");

async function startWorkers() {
  try {
    // ============================================================
    // MongoDB
    // ============================================================

    await connectDatabase();

    // console.log("MongoDB Connected");

    // ============================================================
    // Notification Worker
    // ============================================================

    require("./workers/notification.worker");

    // ============================================================
    // Notification Outbox Worker
    // ============================================================

    NotificationOutboxService.run().catch((err) => {
      // console.error("Notification Outbox Worker stopped unexpectedly:", err);

      process.exit(1);
    });

    // ============================================================
    // Dead Letter Worker
    // ============================================================

    require("./workers/deadLetter.worker");

    // ============================================================
    // Low Balance Worker
    // ============================================================

    require("./workers/lowBalance.worker");

    // ============================================================
    // Payment Reconciliation Worker
    // ============================================================

    require("./workers/paymentReconciliation.worker");

    // ============================================================
    // Low Balance Scheduler
    // ============================================================

    await setupLowBalanceScheduler();

    // ============================================================
    // Payment Reconciliation Scheduler
    // ============================================================

    await setupPaymentReconciliationScheduler();

    // ============================================================
    // Startup Logs
    // ============================================================

    // console.log("Notification Worker Started");

    // console.log("Notification Outbox Worker Started");

    //  console.log("Dead Letter Worker Started");

    // console.log("Low Balance Worker Started");

    // console.log("Low Balance Scheduler Started");

    // console.log("Payment Reconciliation Worker Started");

    // console.log("Payment Reconciliation Scheduler Started");

    // console.log("All Workers Started");
  } catch (err) {
    console.error("Worker startup failed:", err);

    process.exit(1);
  }
}

startWorkers();
