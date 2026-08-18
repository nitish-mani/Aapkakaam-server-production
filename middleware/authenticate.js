const jwt = require("jsonwebtoken");

const ENV = require("../src/config/env");
const { AuthLogger } = require("../src/logger/index");

const User = require("../models/user");
const Vendor = require("../models/vendor");
const Admin = require("../models/admin");
const Employee = require("../models/employee");

async function authenticate(req, res, next) {
  try {
    let token = req.get("Authorization");

    // ============================================================
    // Authorization header
    // ============================================================

    if (!token) {
      req.log?.warn(
        {
          ip: req.ip,
          method: req.method,
          url: req.originalUrl,
        },
        "Missing Authorization header",
      );

      return res.status(401).json({
        success: false,
        message: "Authorization token missing.",
      });
    }

    // ============================================================
    // Remove Bearer prefix
    // ============================================================

    if (token.startsWith("Bearer ")) {
      token = token.slice(7);
    }

    // ============================================================
    // Authentication strategies
    // ============================================================

    const authStrategies = [
      {
        role: "user",
        secret: ENV.JWT_USER_SECRET,
        model: User,
        reqKey: "user",
      },
      {
        role: "vendor",
        secret: ENV.JWT_VENDOR_SECRET,
        model: Vendor,
        reqKey: "vendor",
      },
      {
        role: "admin",
        secret: ENV.JWT_ADMIN_SECRET,
        model: Admin,
        reqKey: "admin",
      },
      {
        role: "employee",
        secret: ENV.JWT_EMPLOYEE_SECRET,
        model: Employee,
        reqKey: "employee",
      },
    ];

    // ============================================================
    // Try authentication strategies
    // ============================================================

    for (const strategy of authStrategies) {
      try {
        const decoded = jwt.verify(token, strategy.secret);

        const id =
          decoded.id ||
          decoded._id ||
          decoded.userId ||
          decoded.vendorId ||
          decoded.adminId ||
          decoded.employeeId;

        if (!id) {
          continue;
        }

        // ========================================================
        // Find account
        // ========================================================

        const account = await strategy.model.findById(id).select("-password");

        // IMPORTANT:
        // Check account before accessing account._id
        if (!account) {
          continue;
        }

        // ========================================================
        // ACCOUNT STATUS CHECK
        // ========================================================

        if (account.status === "blocked" && req.originalUrl != "/api/concerns") {
          req.log?.warn(
            {
              authId: account._id.toString(),
              role: strategy.role,
              status: account.status,
              method: req.method,
              url: req.originalUrl,
              ip: req.ip,
            },
            "Blocked account attempted access",
          );

          return res.status(403).json({
            success: false,
            message: "Your account has been blocked. Please contact support.",
            code: "ACCOUNT_BLOCKED",
          });
        }

        // ========================================================
        // ONLY ACTIVE ACCOUNTS ARE ALLOWED
        // ========================================================

        if (account.status !== "active" && req.originalUrl != "/api/concerns") {
          req.log?.warn(
            {
              authId: account._id.toString(),
              role: strategy.role,
              status: account.status,
              method: req.method,
              url: req.originalUrl,
              ip: req.ip,
            },
            "Inactive account attempted access",
          );

          return res.status(403).json({
            success: false,
            message: "Your account is not active.",
            code: "ACCOUNT_INACTIVE",
          });
        }

        // ========================================================
        // BACKWARD COMPATIBILITY
        // ========================================================

        req[strategy.reqKey] = account;

        // ========================================================
        // STANDARD AUTH OBJECT
        // ========================================================

        req.auth = {
          id: account._id.toString(),
          role: strategy.role,
          payload: decoded,
        };

        // ========================================================
        // AUTH LOGGER
        // ========================================================

        req.log = (req.log || AuthLogger).child({
          authId: account._id.toString(),
          role: strategy.role,
        });

        req.log.info(
          {
            method: req.method,
            url: req.originalUrl,
          },
          "Authentication successful",
        );

        // ========================================================
        // ALLOW REQUEST
        // ========================================================

        return next();
      } catch (err) {
        // Token doesn't match this authentication strategy.
        // Try the next strategy.
      }
    }

    // ============================================================
    // No strategy accepted the token
    // ============================================================

    req.log?.warn(
      {
        method: req.method,
        url: req.originalUrl,
        ip: req.ip,
      },
      "Invalid authentication token",
    );

    return res.status(401).json({
      success: false,
      message: "Invalid or expired token.",
    });
  } catch (err) {
    // ============================================================
    // Unexpected authentication error
    // ============================================================

    (req.log || AuthLogger).error(
      {
        err,
        method: req.method,
        url: req.originalUrl,
      },
      "Authentication middleware failed",
    );

    return res.status(500).json({
      success: false,
      message: "Authentication failed.",
    });
  }
}

module.exports = authenticate;
