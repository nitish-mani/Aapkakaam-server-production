const express = require("express");
const cors = require("cors");
const compression = require("compression");
const helmet = require("helmet");
const mongoSanitize = require("express-mongo-sanitize");

const ENV = require("./config/env");
const logger = require("./logger/logger");

const requestLogger = require("./middleware/requestLogger");
const rateLimiter = require("./middleware/rateLimiter");
const errorHandler = require("./middleware/errorHandler");

// Route modules (legacy paths kept – controllers/models live at repo root).
const userRoutes = require("../routes/user");
const vendorRoutes = require("../routes/vendor");
const adminRoutes = require("../routes/admin");
const employeeRoutes = require("../routes/employee");
const bookingRoutes = require("../routes/bookings");
const paymentRoutes = require("../routes/payment");
const pincodeRoutes = require("../routes/pincode");
const shareRoutes = require("../routes/share");
const concernRoutes = require("../routes/concern");

const appVersionRoutes = require("../routes/appVersion");
const adminVersionRoutes = require("../routes/adminVersion");

const websiteMaintenanceRoutes = require("../routes/maintenanceRoutes");
const adminWebsiteMaintenanceRoutes = require("../routes/adminMaintenanceRoutes");
const homeBannerRoutes = require("../routes/homeBanner");
const adminHomeBannerRoutes = require("../routes/adminHomeBanner");
const adminNotificationRoutes = require("../routes/adminNotificationRoutes");

const systemRoutes = require("../routes/system");
const app = express();

/* ---------- Proxy trust (needed for correct req.ip behind LB/ingress) ---- */
if (ENV.TRUST_PROXY > 0) {
  app.set("trust proxy", ENV.TRUST_PROXY);
}

/* ---------- Security headers ------------------------------------------- */
app.use(
  helmet({
    // Allow embedding images from S3 / CDN.
    crossOriginResourcePolicy: { policy: "cross-origin" },
  }),
);

/* ---------- Response compression --------------------------------------- */
app.use(compression());

/* ---------- Body parsers ----------------------------------------------- */
app.use(
  "/api/payment/webhook",
  express.raw({
    type: "application/json",
  }),
);
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

/* ---------- NoSQL injection sanitisation ------------------------------- */
app.use(mongoSanitize());

/* ---------- CORS ------------------------------------------------------- */
const allowedOrigins = ENV.ALLOWED_ORIGINS;
app.use(
  cors({
    origin(origin, callback) {
      // Non-browser clients (curl, mobile apps, health checks) send no origin.
      if (!origin) return callback(null, true);

      // Empty allow-list in non-production means "allow all" for DX.
      if (!ENV.IS_PROD && allowedOrigins.length === 0) {
        return callback(null, true);
      }

      if (allowedOrigins.includes(origin)) return callback(null, true);

      return callback(new Error(`CORS: origin ${origin} is not allowed`));
    },
    credentials: true,
  }),
);

/* ---------- Observability ---------------------------------------------- */
app.use(requestLogger);

/* ---------- Global rate limit ----------------------------------------- */
app.use(rateLimiter);

/* ---------- Health checks --------------------------------------------- */
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", uptime: process.uptime() });
});

app.get("/api/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    service: "aapkakaam-server",
    environment: ENV.NODE_ENV,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

/* ---------- Share link redirect (Optional) ---------------------------- */

app.get("/api/category/:cd/:id", (req, res) => {
  const { cd, id } = req.params;
  const frontendUrl = ENV.FRONTEND_URL || "https://your-frontend.pages.dev";

  // Redirect to Cloudflare frontend
  res.redirect(`${frontendUrl}/category/${cd}/${id}`);
});

/* ---------- Application routes ---------------------------------------- */
app.use("/api/user", userRoutes);
app.use("/api/vendor", vendorRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/admin/app-versions", adminVersionRoutes);
app.use("/api/admin/system", systemRoutes);
app.use("/api/employee", employeeRoutes);
app.use("/api/bookings", bookingRoutes);
app.use("/api/payment", paymentRoutes);
app.use("/api/pincode", pincodeRoutes);
app.use("/api/share", shareRoutes);
app.use("/api/concerns", concernRoutes);

app.use("/api/app-version", appVersionRoutes);

app.use("/api/website-maintenance", websiteMaintenanceRoutes);

app.use("/api/admin/website-maintenance", adminWebsiteMaintenanceRoutes);

app.use("/api/home-banner", homeBannerRoutes);
app.use("/api/admin/home-banner", adminHomeBannerRoutes);

app.use("/api/admin", adminNotificationRoutes);

/* ---------- 404 handler ----------------------------------------------- */
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `Route not found: ${req.method} ${req.originalUrl}`,
  });
});

/* ---------- Global error handler (MUST be last) ----------------------- */
app.use(errorHandler);

// Expose logger for other modules to reuse the same instance.
app.locals.logger = logger;

module.exports = app;
