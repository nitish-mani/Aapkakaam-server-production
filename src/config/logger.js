const fs = require("fs");
const path = require("path");
const pino = require("pino");

const logDir = path.join(process.cwd(), "logs");

if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

const transport =
  process.env.NODE_ENV === "production"
    ? pino.transport({
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
      })
    : pino.transport({
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "SYS:standard",
          ignore: "pid,hostname",
        },
      });

const logger = pino(
  {
    level: process.env.LOG_LEVEL || "info",
    timestamp: pino.stdTimeFunctions.isoTime,
    base: {
      service: "aapkakaam-api",
    },
  },
  transport,
);

module.exports = logger;
