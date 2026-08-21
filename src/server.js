"use strict";

const http = require("http");
const mongoose = require("mongoose");

const ENV = require("./config/env");
const logger = require("./logger/logger");
const connectDatabase = require("./config/database");
const app = require("./app");

let server;

async function startServer() {
  await connectDatabase();

  server = http.createServer(app);

  server.listen(ENV.PORT, () => {
    logger.info(
      {
        env: ENV.NODE_ENV,
        port: ENV.PORT,
      },
      `Server started on port ${ENV.PORT} (${ENV.NODE_ENV})`,
    );
  });

  server.on("error", (err) => {
    logger.fatal(
      {
        err,
      },
      "HTTP server error",
    );

    process.exit(1);
  });
}

/**
 * Gracefully close HTTP + DB then exit.
 *
 * Guarded against being called twice and forces exit
 * after a timeout so a zombie process cannot linger.
 */
let shuttingDown = false;

async function shutdown(signalOrError, exitCode = 0) {
  if (shuttingDown) return;

  shuttingDown = true;

  logger.warn(
    {
      signalOrError,
    },
    "Shutting down...",
  );

  const forceExit = setTimeout(() => {
    logger.error("Forced shutdown after timeout");
    process.exit(1);
  }, 10_000).unref();

  try {
    // ============================================================
    // HTTP Server
    // ============================================================

    if (server) {
      await new Promise((resolve) => {
        server.close(resolve);
      });

      logger.info("HTTP server closed");
    }

    // ============================================================
    // MongoDB
    // ============================================================

    await mongoose.connection.close();

    logger.info("MongoDB connection closed");
  } catch (err) {
    logger.error(
      {
        err,
      },
      "Error during shutdown",
    );

    exitCode = 1;
  } finally {
    clearTimeout(forceExit);

    process.exit(exitCode);
  }
}

// ================================================================
// Process Signals
// ================================================================

process.on("SIGTERM", () => {
  shutdown("SIGTERM");
});

process.on("SIGINT", () => {
  shutdown("SIGINT");
});

// ================================================================
// Uncaught Exception
// ================================================================

process.on("uncaughtException", (err) => {
  logger.fatal(
    {
      err,
    },
    "Uncaught exception",
  );

  shutdown(err, 1);
});

// ================================================================
// Unhandled Promise Rejection
// ================================================================

process.on("unhandledRejection", (reason) => {
  logger.fatal(
    {
      err: reason instanceof Error ? reason : new Error(String(reason)),
    },
    "Unhandled promise rejection",
  );

  shutdown("unhandledRejection", 1);
});

// ================================================================
// Start Server
// ================================================================

startServer().catch((err) => {
  logger.fatal(
    {
      err,
    },
    "Failed to start server",
  );

  process.exit(1);
});
