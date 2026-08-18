"use strict";

const { Queue, Worker, QueueEvents, Job, FlowProducer } = require("bullmq");

const connection = {
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: Number(process.env.REDIS_PORT) || 6379,
  password: process.env.REDIS_PASSWORD || undefined,

  maxRetriesPerRequest: null,
  enableReadyCheck: true,

  retryStrategy(times) {
    return Math.min(times * 100, 3000);
  },
};

module.exports = {
  Queue,
  Worker,
  QueueEvents,
  Job,
  FlowProducer,
  connection,
};
