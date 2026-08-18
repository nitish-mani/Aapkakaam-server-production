"use strict";

/**
 * Global Jest setup
 *
 * Responsibilities:
 * - Configure test environment
 * - Start MongoDB Replica Set (transactions supported)
 * - Connect Mongoose
 * - Clean database after every test
 * - Shutdown everything cleanly
 */

// ======================================================
// Environment
// ======================================================

process.env.NODE_ENV = "test";
process.env.RAZORPAY_KEY = "rzp_test_key";
process.env.RAZORPAY_SECRET = "rzp_test_secret";
process.env.RAZORPAY_WEBHOOK_SECRET = "rzp_test_webhook_secret";
process.env.JWT_SECRET = "test_jwt_secret";

// Never connect to production DB during tests
process.env.MONGO_URI = "mongodb://127.0.0.1:27017/aapkakaam_test";

// ======================================================
// Global Infrastructure Mocks
// ======================================================

require("./globalMocks");

// ======================================================
// Dependencies
// ======================================================

const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

jest.resetModules();

mongoose.set("strictQuery", true);

let replset;

// ======================================================
// Before All
// ======================================================

beforeAll(async () => {
  jest.setTimeout(60000);

  replset = await MongoMemoryReplSet.create({
    replSet: {
      count: 1,
      storageEngine: "wiredTiger",
    },
  });

  const uri = replset.getUri();

  await mongoose.connect(uri, {
    dbName: "jest",
  });
});

// ======================================================
// After Each
// ======================================================

afterEach(async () => {
  await Promise.all(
    Object.values(mongoose.connection.collections).map((collection) => collection.deleteMany({})),
  );

  jest.clearAllMocks();
});

// ======================================================
// After All
// ======================================================

afterAll(async () => {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }

  if (replset) {
    await replset.stop();
  }
});
