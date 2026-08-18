"use strict";

const { Worker } = require("bullmq");
const { connection } = require("../config/bullmq");
const logger = require("../logger/logger");

const worker = new Worker(
  "dead-letter",
  async (job) => {
    logger.error(
      {
        data: job.data,
      },
      "Dead Letter Job Received",
    );

    // Future:
    // Email Admin
    // Telegram
    // Slack
    // PagerDuty
  },
  {
    connection,
  },
);

module.exports = worker;
