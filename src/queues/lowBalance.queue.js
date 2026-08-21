"use strict";

const { Queue } = require("bullmq");
const { connection } = require("../config/bullmq");

const QUEUE_NAME = "low-balance";

const lowBalanceQueue = new Queue(QUEUE_NAME, {
  connection,
});

module.exports = lowBalanceQueue;
