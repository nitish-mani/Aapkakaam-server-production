/**
 * Centralised nodemailer transporter, configured from environment.
 *
 * Prevents SMTP credentials from being hardcoded across controllers and
 * keeps a single connection pool across the process. Reads:
 *
 *   SMTP_HOST      (default: smtp.gmail.com)
 *   SMTP_PORT      (default: 587)
 *   SMTP_USER      (required to send)
 *   SMTP_PASS      (required to send)
 *   SMTP_FROM      (default: SMTP_USER)
 *   SMTP_SECURE    ("true" for 465, otherwise false)
 */
const nodemailer = require("nodemailer");

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;

  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || "smtp.gmail.com",
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === "true",
    auth:
      process.env.SMTP_USER && process.env.SMTP_PASS
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined,
    pool: true,
    maxConnections: 5,
    maxMessages: 100,
  });

  return transporter;
}

function getFromAddress() {
  return process.env.SMTP_FROM || process.env.SMTP_USER || "no-reply@example.com";
}

module.exports = { getTransporter, getFromAddress };
