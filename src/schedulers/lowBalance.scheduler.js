"use strict";

const lowBalanceQueue = require("../queues/lowBalance.queue");
const { SchedulerLogger } = require("../logger/index");

async function setupLowBalanceScheduler() {
  try {
    const schedulerId = "low-balance-daily-check";

    await lowBalanceQueue.upsertJobScheduler(
      schedulerId,
      {
        // Production: every day at 09:00
        pattern: "0 9 * * *",
      },
      {
        name: "check-low-balance",

        data: {
          type: "LOW_BALANCE_CHECK",
        },

        opts: {
          attempts: 3,
          removeOnComplete: 1300,
          removeOnFail: 500,
        },
      },
    );

    SchedulerLogger.info(
      {
        queue: "low-balance",
        schedulerId,
        schedule: "09:00 daily",
        timezone: "Asia/Kolkata",
      },
      "Low balance scheduler registered",
    );
  } catch (error) {
    SchedulerLogger.error(
      {
        err: error,
        queue: "low-balance",
        schedulerId: "low-balance-daily-check",
      },
      "Failed to register low balance scheduler",
    );

    throw error;
  }
}

module.exports = setupLowBalanceScheduler;
