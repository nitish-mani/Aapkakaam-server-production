const fs = require("fs");
const path = require("path");
const pino = require("pino");

const logDir = path.join(process.cwd(), "logs");

if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

const transport = pino.transport({
  targets: [
    {
      target: "pino/file",
      options: {
        destination: path.join(logDir, "app.log"),
        mkdir: true,
      },
      level: process.env.LOG_LEVEL || "info",
    },
    {
      target: "pino/file",
      options: {
        destination: path.join(logDir, "error.log"),
        mkdir: true,
      },
      level: "error",
    },
  ],
});

const logger = pino(
  {
    level: process.env.LOG_LEVEL || "info",

    // Keep UTC timestamp (recommended)
    timestamp: pino.stdTimeFunctions.isoTime,

    base: {
      service: "aapkakaam-api",
    },

    // Add IST timestamp
    mixin() {
      return {
        istTime: new Date().toLocaleString("en-IN", {
          timeZone: "Asia/Kolkata",
          hour12: false,
        }),
      };
    },
  },
  transport,
);
module.exports = logger;
