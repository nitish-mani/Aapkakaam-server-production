"use strict";

const { Queue } = require("bullmq");
const { connection } = require("../config/bullmq");

const deadLetterQueue = new Queue("dead-letter", {
  connection,

  defaultJobOptions: {
    removeOnComplete: false,
    removeOnFail: false,
  },
});

async function addDeadLetterJob(data) {
  return deadLetterQueue.add("dead-letter", data, {
    jobId: `${data.notificationId}-${Date.now()}`,
  });
}

module.exports = {
  deadLetterQueue,
  addDeadLetterJob,
};
