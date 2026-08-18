/**
 * Firebase Admin SDK initialisation.
 *
 * Credentials are resolved in this order:
 *   1. FIREBASE_SERVICE_ACCOUNT_JSON  (base64-encoded service account JSON)
 *   2. GOOGLE_APPLICATION_CREDENTIALS (absolute path to service account JSON)
 *   3. Application Default Credentials (metadata server on GCP / GKE)
 *
 * Never hardcode file paths — they are non-portable and leak developer info.
 */
const admin = require("firebase-admin");
const ENV = require("./env");

function loadCredential() {
  if (ENV.FIREBASE_SERVICE_ACCOUNT_JSON) {
    try {
      const decoded = Buffer.from(
        ENV.FIREBASE_SERVICE_ACCOUNT_JSON,
        "base64",
      ).toString("utf8");
      const serviceAccount = JSON.parse(decoded);
      return admin.credential.cert(serviceAccount);
    } catch (err) {
      throw new Error(
        `Invalid FIREBASE_SERVICE_ACCOUNT_JSON (expected base64-encoded JSON): ${err.message}`,
      );
    }
  }

  if (ENV.GOOGLE_APPLICATION_CREDENTIALS) {
    // firebase-admin will pick up GOOGLE_APPLICATION_CREDENTIALS automatically.
    return admin.credential.applicationDefault();
  }

  // Fall back to ADC (works on GCP without any env vars).
  return admin.credential.applicationDefault();
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: loadCredential(),
    projectId: ENV.FIREBASE_PROJECT_ID,
  });
}

module.exports = admin;
