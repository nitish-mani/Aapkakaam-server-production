"use strict";

require("dotenv").config();

const connectDatabase = require("./config/database"); // adjust path

async function startWorkers() {
  try {
    await connectDatabase();

    console.log("MongoDB Connected");

    require("./workers/notification.worker");
    require("./workers/deadLetter.worker");

    console.log("Workers Started");
  } catch (err) {
    console.error("Worker startup failed:", err);
    process.exit(1);
  }
}

startWorkers();
