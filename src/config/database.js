const mongoose = require("mongoose");
const ENV = require("./env");

async function connectDatabase() {
  try {
    mongoose.set("strictQuery", true);

    await mongoose.connect(ENV.MONGO_URI, {
      maxPoolSize: ENV.MONGO_MAX_POOL_SIZE,
      minPoolSize: ENV.MONGO_MIN_POOL_SIZE,
      serverSelectionTimeoutMS: ENV.MONGO_SERVER_SELECTION_TIMEOUT_MS,
      socketTimeoutMS: ENV.MONGO_SOCKET_TIMEOUT_MS,
      connectTimeoutMS: ENV.MONGO_CONNECT_TIMEOUT_MS,
      retryWrites: true,
      retryReads: true,
    });

    // console.log(`✅ MongoDB Connected (${ENV.NODE_ENV})`);

    mongoose.connection.on("error", (err) => {
      console.error("❌ MongoDB Error:", err);
    });

    mongoose.connection.on("disconnected", () => {
      console.warn("⚠ MongoDB Disconnected");
    });

    mongoose.connection.on("reconnected", () => {
      // console.log("✅ MongoDB Reconnected");
    });

    process.on("SIGINT", async () => {
      await mongoose.connection.close();
      // console.log("🛑 MongoDB Connection Closed");
      process.exit(0);
    });

    return mongoose.connection;
  } catch (error) {
    console.error("❌ MongoDB Connection Failed");
    console.error(error);
    process.exit(1);
  }
}

module.exports = connectDatabase;
