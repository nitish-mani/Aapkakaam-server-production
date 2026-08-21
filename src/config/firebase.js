"use strict";

const admin = require("firebase-admin");
const ENV = require("./env");

function loadCredential() {
  // --------------------------------------------------
  // 1. Explicit service-account JSON
  // --------------------------------------------------

  if (ENV.FIREBASE_SERVICE_ACCOUNT_JSON) {
    try {
      const decoded = Buffer.from(ENV.FIREBASE_SERVICE_ACCOUNT_JSON, "base64").toString("utf8");

      const serviceAccount = JSON.parse(decoded);

      if (
        !serviceAccount.project_id ||
        !serviceAccount.client_email ||
        !serviceAccount.private_key
      ) {
        throw new Error("Service account must contain project_id, client_email and private_key");
      }

      return admin.credential.cert(serviceAccount);
    } catch (err) {
      throw new Error(`Invalid FIREBASE_SERVICE_ACCOUNT_JSON: ${err.message}`);
    }
  }

  // --------------------------------------------------
  // 2. GOOGLE_APPLICATION_CREDENTIALS
  // --------------------------------------------------

  if (ENV.GOOGLE_APPLICATION_CREDENTIALS) {
    return admin.credential.applicationDefault();
  }

  // --------------------------------------------------
  // 3. Application Default Credentials
  //
  // Useful on GCP/GKE.
  // --------------------------------------------------

  return admin.credential.applicationDefault();
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: loadCredential(),
    projectId: ENV.FIREBASE_PROJECT_ID || undefined,
  });
}

module.exports = admin;
