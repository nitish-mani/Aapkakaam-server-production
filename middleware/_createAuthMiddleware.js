const jwt = require("jsonwebtoken");
const { AuthLogger } = require("../src/logger/index");

function unauthorized(req, res, reason = "Unauthorized") {
  AuthLogger.warn(
    {
      ip: req.ip,
      method: req.method,
      url: req.originalUrl,
      userAgent: req.get("user-agent"),
      reason,
    },
    "Authentication failed",
  );

  return res.status(401).json({
    success: false,
    message: "Not authenticated.",
  });
}

function createAuthMiddleware({ secret, payloadKey, reqKey, role }) {
  if (!secret) {
    throw new Error(`createAuthMiddleware: missing secret for payloadKey="${payloadKey}"`);
  }

  if (!role) {
    throw new Error(`createAuthMiddleware: missing role for payloadKey="${payloadKey}"`);
  }

  return function authMiddleware(req, res, next) {
    const authHeader = req.get("Authorization");

    if (!authHeader) {
      return unauthorized(req, res, "Missing Authorization header");
    }

    const parts = authHeader.split(" ");

    const token =
      parts.length === 2 && /^Bearer$/i.test(parts[0]) ? parts[1] : parts[parts.length - 1];

    if (!token) {
      return unauthorized(req, res, "Missing token");
    }

    let decoded;

    try {
      decoded = jwt.verify(token, secret);
    } catch (err) {
      AuthLogger.warn(
        {
          err,

          ip: req.ip,
          method: req.method,
          url: req.originalUrl,
        },
        "JWT verification failed",
      );

      return unauthorized(req, res, "Invalid or expired token");
    }

    const value = decoded?.[payloadKey];

    if (!value) {
      return unauthorized(req, res, `Missing JWT payload key: ${payloadKey}`);
    }

    // Backward compatibility
    req[reqKey] = value;

    // Standard authentication object
    req.auth = {
      id: value,
      role,
      payload: decoded,
    };

    // Request-scoped AuthLogger
    req.log = (req.log || AuthLogger).child({
      authId: value,
      role,
    });

    return next();
  };
}

module.exports = createAuthMiddleware;
