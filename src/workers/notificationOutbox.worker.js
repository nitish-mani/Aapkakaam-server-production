const mongoose = require("mongoose");

const NotificationOutboxService = require("../services/NotificationOutboxService");

async function start() {
  try {
    /**
     * Your existing application should already have a MongoDB
     * connection helper. Use that here instead of creating a
     * second connection implementation.
     */

    await mongoose.connection.asPromise();

    // console.log("Notification Outbox Worker Started");

    await NotificationOutboxService.run();
  } catch (error) {
    // console.error("Notification Outbox Worker Failed:", error);

    process.exit(1);
  }
}

start();
