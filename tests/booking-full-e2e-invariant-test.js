"use strict";

require("dotenv").config();

const axios = require("axios");
const mongoose = require("mongoose");

const Bookings = require("../models/bookings");
const User = require("../models/user");
const Vendor = require("../models/vendor");
const Share = require("../models/share");

let Notification = null;
const USER_AUTH_PREFIX = "/user";
const VENDOR_AUTH_PREFIX = "/vendor";
const BOOKING_PREFIX = "/bookings";
/*
 * =========================================================
 * TEST RESULT TRACKING
 * =========================================================
 */

let assertions = 0;
// let passed = 0;
// let failed = 0;

const failures = [];
for (const candidate of [
  "../models/notification",
  "../models/notifications",
  "../models/Notification",
]) {
  try {
    Notification = require(candidate);
    break;
  } catch {
    // ignore
  }
}

const API_BASE = process.env.API_URL || "http://localhost:3000/api";

const MONGODB_URI = process.env.MONGODB_URL_1 || process.env.MONGODB_URL_1 || process.env.DB_URI;

const ALLOW_DESTRUCTIVE_TESTS =
  process.env.ALLOW_DESTRUCTIVE_TESTS === "true" || process.env.ALLOW_TESTS === "true";

const HTTP_TIMEOUT = Math.max(5000, Number(process.env.TEST_HTTP_TIMEOUT_MS) || 20000);

const DEFAULT_PASSWORD = process.env.TEST_ACCOUNT_PASSWORD || "Test@123456";

const BOOKING_TYPE = process.env.TEST_BOOKING_TYPE || "four wheeler";
const PINCODE = process.env.TEST_PINCODE || "274201";

const AUTH_PREFIX_CANDIDATES = [
  "",
  "/user",
  "/users",
  "/api/user",
  "/api/users",
  "/auth/user",
  "/auth/users",
  "/account/user",
  "/account/users",
];

const http = axios.create({
  baseURL: API_BASE,
  timeout: HTTP_TIMEOUT,
  validateStatus: () => true,
});

const createdUsers = [];
const createdVendors = [];
const createdBookings = [];
const createdPhones = [];
const createdEmails = [];

let userAuthPrefix = null;
let vendorAuthPrefix = null;

let phoneSeq = 0;
let emailSeq = 0;
let bookingSeq = 0;

let passed = 0;
let failed = 0;
const failureMessages = [];

function section(title) {
  console.log("\n========================================");
  console.log(title);
  console.log("========================================");
}

function ok(condition, message, details = null) {
  assertions += 1;

  if (condition) {
    passed += 1;
    console.log(`PASS | ${message}`);
    return true;
  }

  failed += 1;

  const failure = {
    message,
    details,
  };

  failures.push(failure);
  failureMessages.push(message);

  console.log(`FAIL | ${message}`);

  if (details !== null && details !== undefined) {
    console.dir(details, {
      depth: null,
    });
  }

  return false;
}

function near(actual, expected, epsilon = 0.000001) {
  return Math.abs(Number(actual) - Number(expected)) <= epsilon;
}

function n(value) {
  return Number(value || 0);
}

function delta(before, after) {
  return n(after) - n(before);
}

function makeId(prefix) {
  bookingSeq += 1;
  return `${prefix}-${Date.now()}-${bookingSeq}-${Math.random().toString(36).slice(2, 8)}`;
}

function nextPhone() {
  phoneSeq += 1;

  /*
   * Generate a unique Indian-style 10 digit test number.
   *
   * Date.now() gives enough variation between separate
   * test executions, while phoneSeq guarantees uniqueness
   * within the current execution.
   */

  const timePart = Date.now().toString().slice(-7);

  const seqPart = String(phoneSeq % 100).padStart(2, "0");

  return Number(`9${timePart}${seqPart}`);
}

function nextEmail(kind) {
  emailSeq += 1;
  return `${kind}.${Date.now()}.${emailSeq}.${Math.random().toString(36).slice(2, 8)}@example.test`;
}

function pastDate(daysAgo) {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  return date.toDateString();
}

function authHeader(token) {
  if (!token) return {};

  return {
    Authorization: token.startsWith("Bearer ") ? token : `Bearer ${token}`,
  };
}

async function requestJson(method, url, { body, headers } = {}) {
  return http.request({
    method,
    url,
    data: body,
    headers,
  });
}

function extractId(response, kind) {
  const data = response?.data || {};

  return String(
    data[`${kind}Id`] ||
      data.userId ||
      data.vendorId ||
      data.id ||
      data._id ||
      data?.data?.[`${kind}Id`] ||
      data?.data?.userId ||
      data?.data?.vendorId ||
      data?.data?.id ||
      data?.data?._id,
  );
}

async function signupAndLoginUser({ label, sharedBy = null, cd = null }) {
  const prefix = USER_AUTH_PREFIX;

  const phoneNo = nextPhone("user");
  const email = nextEmail("user");
  const name = label;

  const signupBody = {
    name,
    phoneNo,
    email,
    password: DEFAULT_PASSWORD,
    gender: "male",
    sharedBy,
    cd,
    fcmToken: "",
    agreedToTnCnP: true,
  };

  const signupRes = await requestJson("post", `${prefix}/signup`, {
    body: signupBody,
  });

  if (!(signupRes.status >= 200 && signupRes.status < 300)) {
    throw new Error(`User signup failed (${signupRes.status}): ${JSON.stringify(signupRes.data)}`);
  }

  const userId = extractId(signupRes, "user");

  const seed = {
    balance: 2000,
    earning: 0,

    pending: 0,
    completed: 0,
    canceled: 0,

    pendingVendor: 0,
    completedVendor: 0,
    canceledVendor: 0,

    pendingShareBy: 0,
    completedShareBy: 0,
    canceledShareBy: 0,

    transactionCount: 0,
    totalDiscount: 0,

    shareBy: sharedBy,
    cd,
  };

  await User.updateOne({ _id: userId }, { $set: seed });

  const loginRes = await requestJson("post", `${prefix}/login`, {
    body: {
      phoneNo,
      password: DEFAULT_PASSWORD,
    },
  });

  if (!(loginRes.status >= 200 && loginRes.status < 300)) {
    throw new Error(`User login failed (${loginRes.status}): ${JSON.stringify(loginRes.data)}`);
  }

  createdUsers.push(userId);
  createdPhones.push(phoneNo);
  createdEmails.push(email);

  return {
    kind: "user",
    id: userId,
    phoneNo,
    email,
    name,
    token: loginRes.data.token,
    prefix,
  };
}

async function signupAndLoginVendor({ label, sharedBy = null, cd = null, type = BOOKING_TYPE }) {
  const prefix = VENDOR_AUTH_PREFIX;

  const phoneNo = nextPhone("vendor");
  const email = nextEmail("vendor");
  const name = label;

  const signupBody = {
    name,
    phoneNo,
    email,
    password: DEFAULT_PASSWORD,
    type,
    experience: 1,
    gender: "male",
    sharedBy,
    cd,
    fcmToken: "",
    agreedToTnCnP: true,
  };

  /*
   * -------------------------------------------------------
   * SIGNUP
   * -------------------------------------------------------
   */

  const signupRes = await requestJson("post", `${prefix}/signup`, {
    body: signupBody,
  });

  if (signupRes.status !== 201) {
    throw new Error(
      [
        "Vendor signup failed.",
        `Label: ${label}`,
        `Status: ${signupRes.status}`,
        `Response: ${JSON.stringify(signupRes.data)}`,
      ].join("\n"),
    );
  }

  /*
   * IMPORTANT:
   *
   * Real vendor signup response:
   *
   * {
   *   message,
   *   vendorId,
   *   commission,
   *   initialBalance
   * }
   *
   * Do not use generic extractId() here.
   */

  const vendorId = signupRes.data?.vendorId != null ? String(signupRes.data.vendorId) : null;

  if (!vendorId) {
    throw new Error(
      [
        "Vendor signup returned 201 but vendorId is missing.",
        `Label: ${label}`,
        `Response: ${JSON.stringify(signupRes.data)}`,
      ].join("\n"),
    );
  }

  /*
   * -------------------------------------------------------
   * VERIFY DATABASE CREATION
   * -------------------------------------------------------
   *
   * This prevents the test from continuing with an ID that
   * does not actually belong to a Vendor document.
   */

  let vendor = await Vendor.findById(vendorId).lean();

  if (!vendor) {
    /*
     * Diagnostic fallback:
     *
     * Search by the unique test phone number. This tells us
     * whether the API created the Vendor under a different
     * ID or whether signup did not persist it at all.
     */

    const vendorByPhone = await Vendor.findOne({
      phoneNo,
    }).lean();

    if (vendorByPhone) {
      throw new Error(
        [
          "Vendor signup returned a vendorId that does not match the persisted Vendor.",
          `Label: ${label}`,
          `Returned vendorId: ${vendorId}`,
          `Persisted vendorId: ${vendorByPhone._id}`,
          `Phone: ${phoneNo}`,
          `Signup response: ${JSON.stringify(signupRes.data)}`,
        ].join("\n"),
      );
    }

    throw new Error(
      [
        "Vendor signup returned 201 but no Vendor document exists.",
        `Label: ${label}`,
        `Returned vendorId: ${vendorId}`,
        `Phone: ${phoneNo}`,
        `Signup response: ${JSON.stringify(signupRes.data)}`,
      ].join("\n"),
    );
  }

  /*
   * Register cleanup immediately.
   *
   * Do this BEFORE any later operation can throw.
   */

  createdVendors.push(vendorId);
  createdPhones.push(phoneNo);
  createdEmails.push(email);

  /*
   * -------------------------------------------------------
   * SEED TEST STATE
   * -------------------------------------------------------
   */

  const seed = {
    balance: 2000,
    earning: 0,

    pending: 0,
    completed: 0,
    canceled: 0,

    pendingVendor: 0,
    completedVendor: 0,
    canceledVendor: 0,

    pendingShareBy: 0,
    completedShareBy: 0,
    canceledShareBy: 0,

    transactionCount: 0,
    totalDiscount: 0,

    shareBy: sharedBy,
    cd,
    type,
  };

  const seedResult = await Vendor.updateOne(
    {
      _id: vendorId,
    },
    {
      $set: seed,
    },
  );

  if (seedResult.matchedCount !== 1) {
    throw new Error(
      [
        "Failed to seed test Vendor.",
        `Label: ${label}`,
        `Vendor ID: ${vendorId}`,
        `matchedCount: ${seedResult.matchedCount}`,
        `modifiedCount: ${seedResult.modifiedCount}`,
      ].join("\n"),
    );
  }

  /*
   * Verify seeded state.
   */

  vendor = await Vendor.findById(vendorId).lean();

  if (!vendor) {
    throw new Error(`Vendor disappeared after seed update: ${vendorId}`);
  }

  /*
   * -------------------------------------------------------
   * LOGIN
   * -------------------------------------------------------
   */

  const loginRes = await requestJson("post", `${prefix}/login`, {
    body: {
      phoneNo,
      password: DEFAULT_PASSWORD,
    },
  });

  if (loginRes.status !== 200) {
    throw new Error(
      [
        "Vendor login failed.",
        `Label: ${label}`,
        `Vendor ID: ${vendorId}`,
        `Phone: ${phoneNo}`,
        `Status: ${loginRes.status}`,
        `Response: ${JSON.stringify(loginRes.data)}`,
      ].join("\n"),
    );
  }

  const token = loginRes.data?.token;

  if (!token) {
    throw new Error(
      [
        "Vendor login returned 200 but JWT token is missing.",
        `Label: ${label}`,
        `Vendor ID: ${vendorId}`,
        `Response: ${JSON.stringify(loginRes.data)}`,
      ].join("\n"),
    );
  }

  /*
   * Login should refer to exactly the Vendor we created.
   */

  if (loginRes.data?.vendorId && String(loginRes.data.vendorId) !== vendorId) {
    throw new Error(
      [
        "Vendor login identity mismatch.",
        `Signup vendorId: ${vendorId}`,
        `Login vendorId: ${loginRes.data.vendorId}`,
        `Phone: ${phoneNo}`,
      ].join("\n"),
    );
  }

  return {
    kind: "vendor",
    id: vendorId,
    phoneNo,
    email,
    name,
    token,
    prefix,
    type,
  };
}

async function setUserMetrics(userId, patch) {
  await User.updateOne({ _id: userId }, { $set: patch });
}

async function setVendorMetrics(vendorId, patch) {
  await Vendor.updateOne({ _id: vendorId }, { $set: patch });
}

async function loadUserState(userId) {
  const doc = await User.findById(userId).lean();

  if (!doc) {
    throw new Error(`User not found: ${userId}`);
  }

  return {
    kind: "user",
    id: String(doc._id),
    name: doc.name,
    phoneNo: doc.phoneNo,

    balance: n(doc.balance),
    earning: n(doc.earning),

    pending: n(doc.pending),
    completed: n(doc.completed),
    canceled: n(doc.canceled),

    pendingVendor: n(doc.pendingVendor),
    completedVendor: n(doc.completedVendor),
    canceledVendor: n(doc.canceledVendor),

    pendingShareBy: n(doc.pendingShareBy),
    completedShareBy: n(doc.completedShareBy),
    canceledShareBy: n(doc.canceledShareBy),

    shareBy: doc.shareBy ? String(doc.shareBy) : null,

    cd: doc.cd || null,

    transactionCount: n(doc.transactionCount),
    totalDiscount: n(doc.totalDiscount),
  };
}

async function loadVendorState(vendorId) {
  const doc = await Vendor.findById(vendorId).lean();

  if (!doc) {
    throw new Error(`Vendor not found: ${vendorId}`);
  }

  return {
    kind: "vendor",
    id: String(doc._id),
    name: doc.name,
    phoneNo: doc.phoneNo,
    type: doc.type,

    commission: n(doc.commission),

    balance: n(doc.balance),
    earning: n(doc.earning),

    pending: n(doc.pending),
    completed: n(doc.completed),
    canceled: n(doc.canceled),

    pendingVendor: n(doc.pendingVendor),
    completedVendor: n(doc.completedVendor),
    canceledVendor: n(doc.canceledVendor),

    pendingShareBy: n(doc.pendingShareBy),
    completedShareBy: n(doc.completedShareBy),
    canceledShareBy: n(doc.canceledShareBy),

    shareBy: doc.shareBy ? String(doc.shareBy) : null,

    cd: doc.cd || null,

    transactionCount: n(doc.transactionCount),
    totalDiscount: n(doc.totalDiscount),
  };
}

async function loadReferrerState(referrer) {
  if (!referrer) {
    return null;
  }

  return referrer.kind === "user" ? loadUserState(referrer.id) : loadVendorState(referrer.id);
}

async function loadAccountByKind(kind, id) {
  return kind === "user" ? loadUserState(id) : loadVendorState(id);
}

async function createBooking({ flowType, customer, provider, bookingDate }) {
  const normalizedFlowType = String(flowType).trim().toUpperCase();

  if (!["U", "V"].includes(normalizedFlowType)) {
    throw new Error(`Invalid booking flowType: ${flowType}`);
  }

  const suffix = normalizedFlowType;

  const route = `${BOOKING_PREFIX}/postToBookings${suffix}`;

  const body = {
    userId: customer.id,
    vendorId: provider.id,
    bookingDate,
    type: BOOKING_TYPE,
    pincode: PINCODE,
  };

  if (flowType === "V") {
    body.name = customer.name;
    body.phoneNo = customer.phoneNo;
    body.vill = "Test Village";
    body.post = "Test Post";
    body.dist = "Test District";
  }

  const res = await requestJson("post", route, {
    body,
    headers: authHeader(customer.token),
  });

  if (res.status < 200 || res.status >= 300) {
    throw new Error(
      `Booking creation failed (${res.status}) for ${route}: ${JSON.stringify(res.data)}`,
    );
  }

  const bookingId = res.data?.data?.bookingId || res.data?.bookingId || null;

  return {
    status: res.status,
    body: res.data,
    bookingId,
  };
}

async function fetchBookingIdFromOrders({ flowType, customer, provider, bookingDate }) {
  const normalizedFlowType = String(flowType).trim().toUpperCase();

  if (!["U", "V"].includes(normalizedFlowType)) {
    throw new Error(`Invalid booking flowType: ${flowType}`);
  }

  const suffix = normalizedFlowType;

  const route = `${BOOKING_PREFIX}/getOrders${suffix}/${customer.id}/1`;

  const res = await requestJson("get", route, {
    headers: authHeader(customer.token),
  });

  if (res.status < 200 || res.status >= 300) {
    throw new Error(`getOrders failed (${res.status}) for ${route}: ${JSON.stringify(res.data)}`);
  }

  const orders = res.data?.orders || res.data?.data?.orders || [];

  const order = orders.find((o) => {
    const orderName = String(o?.name || "");

    const orderDate = String(o?.date || "");

    const orderType = String(o?.type || "");

    return orderName === provider.name && orderDate === bookingDate && orderType === BOOKING_TYPE;
  });

  if (!order) {
    throw new Error(
      `Created booking not found in getOrders response for ${route}. Orders: ${JSON.stringify(
        orders,
      )}`,
    );
  }

  return {
    status: res.status,
    body: res.data,

    bookingId: String(order.bookingId || order._id || ""),

    order,
    orders,
  };
}

async function completeBooking({ flowType, customer, bookingId }) {
  const normalizedFlowType = String(flowType).trim().toUpperCase();

  if (!["U", "V"].includes(normalizedFlowType)) {
    throw new Error(`Invalid booking flowType: ${flowType}`);
  }

  const suffix = normalizedFlowType;

  const route = `${BOOKING_PREFIX}/orderCompleted${suffix}`;

  return requestJson("patch", route, {
    body: { bookingId },
    headers: authHeader(customer.token),
  });
}

async function cancelBooking({ flowType, customer, bookingId }) {
  const normalizedFlowType = String(flowType).trim().toUpperCase();

  if (!["U", "V"].includes(normalizedFlowType)) {
    throw new Error(`Invalid booking flowType: ${flowType}`);
  }

  const suffix = normalizedFlowType;

  const route = `${BOOKING_PREFIX}/cancelOrder${suffix}`;

  return requestJson("patch", route, {
    body: { bookingId },
    headers: authHeader(customer.token),
  });
}

async function concurrentAction({ flowType, customer, bookingId, action, concurrency = 20 }) {
  const sender = action === "complete" ? completeBooking : cancelBooking;

  const results = await Promise.all(
    Array.from({ length: concurrency }, (_, i) =>
      sender({
        flowType,
        customer,
        bookingId,
        requestId: makeId(`${action}-${i + 1}`),
      }).then((res) => ({
        request: i + 1,
        status: res.status,
        data: res.data,
      })),
    ),
  );

  return results;
}

function summarizeConcurrent(results) {
  const success = results.filter((r) => r.status >= 200 && r.status < 300);

  const fail400 = results.filter((r) => r.status === 400);

  const fail409 = results.filter((r) => r.status === 409);

  const other = results.filter(
    (r) => ![400, 409].includes(r.status) && !(r.status >= 200 && r.status < 300),
  );

  return {
    success,
    fail400,
    fail409,
    other,
  };
}

async function snapshotBookingParticipants({
  flowType,
  customer,
  provider,
  customerReferrer,
  providerReferrer,
}) {
  const customerState = await loadAccountByKind(customer.kind, customer.id);

  const providerState = await loadAccountByKind(provider.kind, provider.id);

  const customerReferrerState = await loadReferrerState(customerReferrer);

  const providerReferrerState = await loadReferrerState(providerReferrer);

  return {
    customer: customerState,
    provider: providerState,
    customerReferrer: customerReferrerState,
    providerReferrer: providerReferrerState,
  };
}

function rewardAmount(commission) {
  return Number((Number(commission) * 0.05).toFixed(6));
}

function rewardExpected({ eligible, commission }) {
  return eligible ? rewardAmount(commission) : 0;
}

function assertStateDelta({ label, before, after, key, expectedDelta }) {
  return ok(
    delta(before[key], after[key]) === expectedDelta,

    `${label} ${key} delta ${expectedDelta}`,

    {
      before: before[key],
      after: after[key],

      actualDelta: delta(before[key], after[key]),

      expectedDelta,
    },
  );
}

function assertNoBalanceChange(label, before, after) {
  return ok(
    near(before.balance, after.balance),

    `${label} balance unchanged`,

    {
      before: before.balance,
      after: after.balance,
    },
  );
}
async function runCompletionScenario({
  title,
  flowType,
  customerKind,
  customerCompleted,
  providerCompletedVendor,
  customerReferrerKind,
  providerReferrerKind,
  sameReferrer = false,
}) {
  section(title);

  let customerReferrer;
  let providerReferrer;

  if (sameReferrer) {
    customerReferrer =
      customerReferrerKind === "user"
        ? await signupAndLoginUser({
            label: `${title} SAME REFERRER`,
          })
        : await signupAndLoginVendor({
            label: `${title} SAME REFERRER`,
          });

    providerReferrer = customerReferrer;
  } else {
    customerReferrer =
      customerReferrerKind === "user"
        ? await signupAndLoginUser({
            label: `${title} CUSTOMER REFERRER`,
          })
        : await signupAndLoginVendor({
            label: `${title} CUSTOMER REFERRER`,
          });

    providerReferrer =
      providerReferrerKind === "user"
        ? await signupAndLoginUser({
            label: `${title} PROVIDER REFERRER`,
          })
        : await signupAndLoginVendor({
            label: `${title} PROVIDER REFERRER`,
          });
  }

  const customer =
    customerKind === "user"
      ? await signupAndLoginUser({
          label: `${title} CUSTOMER`,
          sharedBy: customerReferrer.id,
          cd: customerReferrer.kind,
        })
      : await signupAndLoginVendor({
          label: `${title} VENDOR CUSTOMER`,
          sharedBy: customerReferrer.id,
          cd: customerReferrer.kind,
        });

  const provider = await signupAndLoginVendor({
    label: `${title} SERVICE PROVIDER`,
    sharedBy: providerReferrer.id,
    cd: providerReferrer.kind,
  });

  /*
   * Important business rule:
   *
   * Person acting as customer:
   *   pending / completed / canceled
   *
   * Vendor being booked:
   *   pendingVendor / completedVendor / canceledVendor
   *
   * Therefore even when a Vendor acts as the customer,
   * its referral eligibility uses `completed`, NOT
   * `completedVendor`.
   */

  if (customer.kind === "user") {
    await setUserMetrics(customer.id, {
      completed: customerCompleted,
      pending: 0,
      canceled: 0,
      balance: 2000,
    });
  } else {
    await setVendorMetrics(customer.id, {
      completed: customerCompleted,
      pending: 0,
      canceled: 0,

      // Deliberately different so the test catches
      // accidental use of completedVendor.
      completedVendor: 99,

      balance: 2000,
    });
  }

  await setVendorMetrics(provider.id, {
    completedVendor: providerCompletedVendor,
    pendingVendor: 0,
    canceledVendor: 0,
    balance: 2000,
  });

  /*
   * Signup increments shareCount but referral booking
   * accounting should start from a known clean state.
   */

  if (customerReferrer.kind === "user") {
    await setUserMetrics(customerReferrer.id, {
      earning: 0,
      balance: 2000,
      pendingShareBy: 0,
      completedShareBy: 0,
      canceledShareBy: 0,
    });
  } else {
    await setVendorMetrics(customerReferrer.id, {
      earning: 0,
      balance: 2000,
      pendingShareBy: 0,
      completedShareBy: 0,
      canceledShareBy: 0,
    });
  }

  if (!sameReferrer) {
    if (providerReferrer.kind === "user") {
      await setUserMetrics(providerReferrer.id, {
        earning: 0,
        balance: 2000,
        pendingShareBy: 0,
        completedShareBy: 0,
        canceledShareBy: 0,
      });
    } else {
      await setVendorMetrics(providerReferrer.id, {
        earning: 0,
        balance: 2000,
        pendingShareBy: 0,
        completedShareBy: 0,
        canceledShareBy: 0,
      });
    }
  }

  const bookingDate = pastDate(10 + bookingSeq);

  const before = await snapshotBookingParticipants({
    flowType,
    customer,
    provider,
    customerReferrer,
    providerReferrer,
  });

  console.log("BEFORE:");
  console.dir(before, {
    depth: null,
  });

  /*
   * -----------------------------------------------------
   * CREATE BOOKING
   * -----------------------------------------------------
   */

  const createResult = await createBooking({
    flowType,
    customer,
    provider,
    bookingDate,
  });

  ok(createResult.status === 201, "Booking creation returned 201", createResult);

  /*
   * Do NOT trust bookingId from the create response for
   * this E2E test.
   *
   * This explicitly verifies the real frontend flow:
   *
   * create booking
   *       ↓
   * getOrdersU / getOrdersV
   *       ↓
   * receive bookingId
   *       ↓
   * complete/cancel using that bookingId
   */

  const orderResult = await fetchBookingIdFromOrders({
    flowType,
    customer,
    provider,
    bookingDate,
  });

  const bookingId = orderResult.bookingId;

  if (!bookingId) {
    throw new Error("getOrders returned the created booking but no bookingId");
  }

  createdBookings.push(bookingId);

  ok(mongoose.Types.ObjectId.isValid(bookingId), "getOrders returned valid bookingId", {
    bookingId,
  });

  ok(
    String(orderResult.order.bookingId || orderResult.order._id) === String(bookingId),
    "Booking ID came from getOrders response",
  );

  const bookingAfterCreate = await Bookings.findById(bookingId).lean();

  ok(Boolean(bookingAfterCreate), "Created booking exists in MongoDB");

  ok(
    bookingAfterCreate &&
      bookingAfterCreate.cancelOrder === false &&
      bookingAfterCreate.orderCompleted === false,
    "Created booking is active",
    bookingAfterCreate,
  );

  const afterCreate = await snapshotBookingParticipants({
    flowType,
    customer,
    provider,
    customerReferrer,
    providerReferrer,
  });

  /*
   * Customer accounting
   */

  assertStateDelta({
    label: "Customer",
    before: before.customer,
    after: afterCreate.customer,
    key: "pending",
    expectedDelta: 1,
  });

  /*
   * Service-provider accounting
   */

  assertStateDelta({
    label: "Service provider",
    before: before.provider,
    after: afterCreate.provider,
    key: "pendingVendor",
    expectedDelta: 1,
  });

  /*
   * Referral pending lifecycle.
   *
   * Customer shareBy receives one pending referral.
   * Provider shareBy receives another pending referral.
   *
   * If both shareBy values identify the same account,
   * that account must receive TWO increments.
   */

  if (sameReferrer) {
    const beforeRef = before.customerReferrer;

    const afterRef = afterCreate.customerReferrer;

    assertStateDelta({
      label: "Same referrer",
      before: beforeRef,
      after: afterRef,
      key: "pendingShareBy",
      expectedDelta: 2,
    });
  } else {
    assertStateDelta({
      label: "Customer referrer",
      before: before.customerReferrer,
      after: afterCreate.customerReferrer,
      key: "pendingShareBy",
      expectedDelta: 1,
    });

    assertStateDelta({
      label: "Provider referrer",
      before: before.providerReferrer,
      after: afterCreate.providerReferrer,
      key: "pendingShareBy",
      expectedDelta: 1,
    });
  }

  /*
   * No referral earning should be paid merely for
   * creating the booking.
   */

  if (sameReferrer) {
    ok(
      near(before.customerReferrer.earning, afterCreate.customerReferrer.earning),
      "Same referrer earning unchanged while booking is pending",
      {
        before: before.customerReferrer.earning,
        after: afterCreate.customerReferrer.earning,
      },
    );
  } else {
    ok(
      near(before.customerReferrer.earning, afterCreate.customerReferrer.earning),
      "Customer referrer earning unchanged while booking is pending",
    );

    ok(
      near(before.providerReferrer.earning, afterCreate.providerReferrer.earning),
      "Provider referrer earning unchanged while booking is pending",
    );
  }

  /*
   * -----------------------------------------------------
   * COMPLETE BOOKING
   * -----------------------------------------------------
   */

  const completionRes = await completeBooking({
    flowType,
    customer,
    bookingId,
  });

  ok(
    completionRes.status >= 200 && completionRes.status < 300,
    `${flowType} completion endpoint succeeded`,
    {
      status: completionRes.status,
      body: completionRes.data,
    },
  );

  const afterComplete = await snapshotBookingParticipants({
    flowType,
    customer,
    provider,
    customerReferrer,
    providerReferrer,
  });

  const completedBooking = await Bookings.findById(bookingId).lean();

  ok(completedBooking?.orderCompleted === true, "Booking marked completed", completedBooking);

  ok(
    completedBooking?.cancelOrder === false,
    "Completed booking is not canceled",
    completedBooking,
  );

  /*
   * Customer lifecycle:
   *
   * pending -> completed
   */

  assertStateDelta({
    label: "Customer",
    before: afterCreate.customer,
    after: afterComplete.customer,
    key: "pending",
    expectedDelta: -1,
  });

  assertStateDelta({
    label: "Customer",
    before: afterCreate.customer,
    after: afterComplete.customer,
    key: "completed",
    expectedDelta: 1,
  });

  /*
   * Service-provider lifecycle:
   *
   * pendingVendor -> completedVendor
   */

  assertStateDelta({
    label: "Service provider",
    before: afterCreate.provider,
    after: afterComplete.provider,
    key: "pendingVendor",
    expectedDelta: -1,
  });

  assertStateDelta({
    label: "Service provider",
    before: afterCreate.provider,
    after: afterComplete.provider,
    key: "completedVendor",
    expectedDelta: 1,
  });

  /*
   * -----------------------------------------------------
   * REFERRAL ELIGIBILITY
   * -----------------------------------------------------
   *
   * Rule:
   *
   * customer eligibility:
   *   completed BEFORE this completion >= 5
   *
   * provider eligibility:
   *   completedVendor BEFORE this completion >= 5
   *
   * Reward:
   *
   * customer referral = commission × 5%
   * provider referral = commission × 5%
   *
   * Therefore:
   *
   * neither eligible -> 0%
   * only one eligible -> 5%
   * both eligible -> 10%
   */

  const commission = before.provider.commission;

  const customerEligible = before.customer.completed >= 5;

  const providerEligible = before.provider.completedVendor >= 5;

  const expectedCustomerReward = rewardExpected({
    eligible: customerEligible,
    commission,
  });

  const expectedProviderReward = rewardExpected({
    eligible: providerEligible,
    commission,
  });

  const expectedTotalReward = expectedCustomerReward + expectedProviderReward;

  console.log("\nREFERRAL EXPECTATION:");
  console.dir(
    {
      commission,

      customerCompletedBefore: before.customer.completed,

      providerCompletedVendorBefore: before.provider.completedVendor,

      customerEligible,
      providerEligible,

      expectedCustomerReward,
      expectedProviderReward,
      expectedTotalReward,
    },
    { depth: null },
  );

  /*
   * Earning is credited.
   * Balance must NOT be credited.
   *
   * Sharer later decides whether to:
   *
   * - withdraw earning to bank, or
   * - move earning into wallet balance.
   */

  if (sameReferrer) {
    const earningDelta = delta(
      before.customerReferrer.earning,
      afterComplete.customerReferrer.earning,
    );

    ok(
      near(earningDelta, expectedTotalReward),
      `Same referrer earning increased by ${expectedTotalReward}`,
      {
        before: before.customerReferrer.earning,
        after: afterComplete.customerReferrer.earning,
        actualDelta: earningDelta,
        expectedDelta: expectedTotalReward,
      },
    );

    assertNoBalanceChange("Same referrer", before.customerReferrer, afterComplete.customerReferrer);

    assertStateDelta({
      label: "Same referrer",
      before: afterCreate.customerReferrer,
      after: afterComplete.customerReferrer,
      key: "pendingShareBy",
      expectedDelta: -2,
    });

    assertStateDelta({
      label: "Same referrer",
      before: before.customerReferrer,
      after: afterComplete.customerReferrer,
      key: "completedShareBy",
      expectedDelta: 2,
    });
  } else {
    const customerEarningDelta = delta(
      before.customerReferrer.earning,
      afterComplete.customerReferrer.earning,
    );

    const providerEarningDelta = delta(
      before.providerReferrer.earning,
      afterComplete.providerReferrer.earning,
    );

    ok(
      near(customerEarningDelta, expectedCustomerReward),
      `Customer referrer earning increased by ${expectedCustomerReward}`,
      {
        actualDelta: customerEarningDelta,
        expectedDelta: expectedCustomerReward,
      },
    );

    ok(
      near(providerEarningDelta, expectedProviderReward),
      `Provider referrer earning increased by ${expectedProviderReward}`,
      {
        actualDelta: providerEarningDelta,
        expectedDelta: expectedProviderReward,
      },
    );

    assertNoBalanceChange(
      "Customer referrer",
      before.customerReferrer,
      afterComplete.customerReferrer,
    );

    assertNoBalanceChange(
      "Provider referrer",
      before.providerReferrer,
      afterComplete.providerReferrer,
    );

    assertStateDelta({
      label: "Customer referrer",
      before: afterCreate.customerReferrer,
      after: afterComplete.customerReferrer,
      key: "pendingShareBy",
      expectedDelta: -1,
    });

    assertStateDelta({
      label: "Provider referrer",
      before: afterCreate.providerReferrer,
      after: afterComplete.providerReferrer,
      key: "pendingShareBy",
      expectedDelta: -1,
    });

    assertStateDelta({
      label: "Customer referrer",
      before: before.customerReferrer,
      after: afterComplete.customerReferrer,
      key: "completedShareBy",
      expectedDelta: 1,
    });

    assertStateDelta({
      label: "Provider referrer",
      before: before.providerReferrer,
      after: afterComplete.providerReferrer,
      key: "completedShareBy",
      expectedDelta: 1,
    });
  }

  /*
   * -----------------------------------------------------
   * SECOND COMPLETION MUST NOT PAY AGAIN
   * -----------------------------------------------------
   */

  const beforeDuplicate = await snapshotBookingParticipants({
    flowType,
    customer,
    provider,
    customerReferrer,
    providerReferrer,
  });

  const duplicateCompletion = await completeBooking({
    flowType,
    customer,
    bookingId,
  });

  const afterDuplicate = await snapshotBookingParticipants({
    flowType,
    customer,
    provider,
    customerReferrer,
    providerReferrer,
  });

  ok(
    !(duplicateCompletion.status >= 200 && duplicateCompletion.status < 300),
    "Duplicate completion rejected",
    {
      status: duplicateCompletion.status,
      body: duplicateCompletion.data,
    },
  );

  ok(
    near(beforeDuplicate.customer.completed, afterDuplicate.customer.completed),
    "Duplicate completion did not increment customer completed",
  );

  ok(
    near(beforeDuplicate.provider.completedVendor, afterDuplicate.provider.completedVendor),
    "Duplicate completion did not increment provider completedVendor",
  );

  if (sameReferrer) {
    ok(
      near(beforeDuplicate.customerReferrer.earning, afterDuplicate.customerReferrer.earning),
      "Duplicate completion did not pay same referrer again",
    );

    ok(
      beforeDuplicate.customerReferrer.completedShareBy ===
        afterDuplicate.customerReferrer.completedShareBy,
      "Duplicate completion did not increment same referrer completedShareBy again",
    );
  } else {
    ok(
      near(beforeDuplicate.customerReferrer.earning, afterDuplicate.customerReferrer.earning),
      "Duplicate completion did not repay customer referrer",
    );

    ok(
      near(beforeDuplicate.providerReferrer.earning, afterDuplicate.providerReferrer.earning),
      "Duplicate completion did not repay provider referrer",
    );

    ok(
      beforeDuplicate.customerReferrer.completedShareBy ===
        afterDuplicate.customerReferrer.completedShareBy,
      "Duplicate completion did not increment customer completedShareBy again",
    );

    ok(
      beforeDuplicate.providerReferrer.completedShareBy ===
        afterDuplicate.providerReferrer.completedShareBy,
      "Duplicate completion did not increment provider completedShareBy again",
    );
  }

  console.log("\nSCENARIO RESULT:");
  console.dir(
    {
      flowType,
      customerKind,

      customerCompletedBefore: before.customer.completed,

      providerCompletedVendorBefore: before.provider.completedVendor,

      customerEligible,
      providerEligible,

      commission,

      expectedCustomerReward,
      expectedProviderReward,
      expectedTotalReward,

      bookingId,

      completionStatus: completionRes.status,

      duplicateCompletionStatus: duplicateCompletion.status,
    },
    { depth: null },
  );

  return {
    customer,
    provider,
    customerReferrer,
    providerReferrer,
    bookingId,
  };
}

/*
 * =========================================================
 * CANCELLATION SCENARIO
 * =========================================================
 */

async function runCancellationScenario({
  title,
  flowType,
  customerKind,
  customerReferrerKind,
  providerReferrerKind,
  sameReferrer = false,
}) {
  section(title);

  let customerReferrer;
  let providerReferrer;

  if (sameReferrer) {
    customerReferrer =
      customerReferrerKind === "user"
        ? await signupAndLoginUser({
            label: `${title} SAME REFERRER`,
          })
        : await signupAndLoginVendor({
            label: `${title} SAME REFERRER`,
          });

    providerReferrer = customerReferrer;
  } else {
    customerReferrer =
      customerReferrerKind === "user"
        ? await signupAndLoginUser({
            label: `${title} CUSTOMER REFERRER`,
          })
        : await signupAndLoginVendor({
            label: `${title} CUSTOMER REFERRER`,
          });

    providerReferrer =
      providerReferrerKind === "user"
        ? await signupAndLoginUser({
            label: `${title} PROVIDER REFERRER`,
          })
        : await signupAndLoginVendor({
            label: `${title} PROVIDER REFERRER`,
          });
  }

  const customer =
    customerKind === "user"
      ? await signupAndLoginUser({
          label: `${title} CUSTOMER`,
          sharedBy: customerReferrer.id,
          cd: customerReferrer.kind,
        })
      : await signupAndLoginVendor({
          label: `${title} VENDOR CUSTOMER`,
          sharedBy: customerReferrer.id,
          cd: customerReferrer.kind,
        });

  const provider = await signupAndLoginVendor({
    label: `${title} SERVICE PROVIDER`,
    sharedBy: providerReferrer.id,
    cd: providerReferrer.kind,
  });

  /*
   * Make both referral sides eligible.
   *
   * Cancellation must still produce ZERO earning.
   */

  if (customer.kind === "user") {
    await setUserMetrics(customer.id, {
      completed: 10,
      pending: 0,
      canceled: 0,
      balance: 2000,
    });
  } else {
    await setVendorMetrics(customer.id, {
      completed: 10,
      completedVendor: 50,
      pending: 0,
      canceled: 0,
      balance: 2000,
    });
  }

  await setVendorMetrics(provider.id, {
    completedVendor: 10,
    pendingVendor: 0,
    canceledVendor: 0,
    balance: 2000,
  });

  if (customerReferrer.kind === "user") {
    await setUserMetrics(customerReferrer.id, {
      earning: 0,
      balance: 2000,
      pendingShareBy: 0,
      completedShareBy: 0,
      canceledShareBy: 0,
    });
  } else {
    await setVendorMetrics(customerReferrer.id, {
      earning: 0,
      balance: 2000,
      pendingShareBy: 0,
      completedShareBy: 0,
      canceledShareBy: 0,
    });
  }

  if (!sameReferrer) {
    if (providerReferrer.kind === "user") {
      await setUserMetrics(providerReferrer.id, {
        earning: 0,
        balance: 2000,
        pendingShareBy: 0,
        completedShareBy: 0,
        canceledShareBy: 0,
      });
    } else {
      await setVendorMetrics(providerReferrer.id, {
        earning: 0,
        balance: 2000,
        pendingShareBy: 0,
        completedShareBy: 0,
        canceledShareBy: 0,
      });
    }
  }

  const bookingDate = pastDate(30 + bookingSeq);

  const before = await snapshotBookingParticipants({
    flowType,
    customer,
    provider,
    customerReferrer,
    providerReferrer,
  });

  const createResult = await createBooking({
    flowType,
    customer,
    provider,
    bookingDate,
  });

  ok(createResult.status === 201, "Cancellation scenario booking created");

  const orderResult = await fetchBookingIdFromOrders({
    flowType,
    customer,
    provider,
    bookingDate,
  });

  const bookingId = orderResult.bookingId;

  createdBookings.push(bookingId);

  ok(Boolean(bookingId), "Cancellation scenario obtained bookingId through getOrders");

  const afterCreate = await snapshotBookingParticipants({
    flowType,
    customer,
    provider,
    customerReferrer,
    providerReferrer,
  });

  assertStateDelta({
    label: "Cancellation customer",
    before: before.customer,
    after: afterCreate.customer,
    key: "pending",
    expectedDelta: 1,
  });

  assertStateDelta({
    label: "Cancellation provider",
    before: before.provider,
    after: afterCreate.provider,
    key: "pendingVendor",
    expectedDelta: 1,
  });

  if (sameReferrer) {
    assertStateDelta({
      label: "Cancellation same referrer",
      before: before.customerReferrer,
      after: afterCreate.customerReferrer,
      key: "pendingShareBy",
      expectedDelta: 2,
    });
  } else {
    assertStateDelta({
      label: "Cancellation customer referrer",
      before: before.customerReferrer,
      after: afterCreate.customerReferrer,
      key: "pendingShareBy",
      expectedDelta: 1,
    });

    assertStateDelta({
      label: "Cancellation provider referrer",
      before: before.providerReferrer,
      after: afterCreate.providerReferrer,
      key: "pendingShareBy",
      expectedDelta: 1,
    });
  }

  const cancelRes = await cancelBooking({
    flowType,
    customer,
    bookingId,
  });

  ok(cancelRes.status >= 200 && cancelRes.status < 300, `${flowType} cancellation succeeded`, {
    status: cancelRes.status,
    body: cancelRes.data,
  });

  const afterCancel = await snapshotBookingParticipants({
    flowType,
    customer,
    provider,
    customerReferrer,
    providerReferrer,
  });

  const canceledBooking = await Bookings.findById(bookingId).lean();

  ok(canceledBooking?.cancelOrder === true, "Booking marked canceled", canceledBooking);

  ok(canceledBooking?.orderCompleted === false, "Canceled booking not marked completed");

  /*
   * Customer:
   *
   * pending -> canceled
   */

  assertStateDelta({
    label: "Cancellation customer",
    before: afterCreate.customer,
    after: afterCancel.customer,
    key: "pending",
    expectedDelta: -1,
  });

  assertStateDelta({
    label: "Cancellation customer",
    before: afterCreate.customer,
    after: afterCancel.customer,
    key: "canceled",
    expectedDelta: 1,
  });

  /*
   * Service provider:
   *
   * pendingVendor -> canceledVendor
   */

  assertStateDelta({
    label: "Cancellation provider",
    before: afterCreate.provider,
    after: afterCancel.provider,
    key: "pendingVendor",
    expectedDelta: -1,
  });

  assertStateDelta({
    label: "Cancellation provider",
    before: afterCreate.provider,
    after: afterCancel.provider,
    key: "canceledVendor",
    expectedDelta: 1,
  });

  /*
   * Cancellation never earns referral money.
   */

  if (sameReferrer) {
    ok(
      near(before.customerReferrer.earning, afterCancel.customerReferrer.earning),
      "Cancellation paid no earning to same referrer",
    );

    assertNoBalanceChange(
      "Cancellation same referrer",
      before.customerReferrer,
      afterCancel.customerReferrer,
    );

    assertStateDelta({
      label: "Cancellation same referrer",
      before: afterCreate.customerReferrer,
      after: afterCancel.customerReferrer,
      key: "pendingShareBy",
      expectedDelta: -2,
    });

    assertStateDelta({
      label: "Cancellation same referrer",
      before: before.customerReferrer,
      after: afterCancel.customerReferrer,
      key: "canceledShareBy",
      expectedDelta: 2,
    });

    assertStateDelta({
      label: "Cancellation same referrer",
      before: before.customerReferrer,
      after: afterCancel.customerReferrer,
      key: "completedShareBy",
      expectedDelta: 0,
    });
  } else {
    ok(
      near(before.customerReferrer.earning, afterCancel.customerReferrer.earning),
      "Cancellation paid no earning to customer referrer",
    );

    ok(
      near(before.providerReferrer.earning, afterCancel.providerReferrer.earning),
      "Cancellation paid no earning to provider referrer",
    );

    assertNoBalanceChange(
      "Cancellation customer referrer",
      before.customerReferrer,
      afterCancel.customerReferrer,
    );

    assertNoBalanceChange(
      "Cancellation provider referrer",
      before.providerReferrer,
      afterCancel.providerReferrer,
    );

    assertStateDelta({
      label: "Cancellation customer referrer",
      before: afterCreate.customerReferrer,
      after: afterCancel.customerReferrer,
      key: "pendingShareBy",
      expectedDelta: -1,
    });

    assertStateDelta({
      label: "Cancellation provider referrer",
      before: afterCreate.providerReferrer,
      after: afterCancel.providerReferrer,
      key: "pendingShareBy",
      expectedDelta: -1,
    });

    assertStateDelta({
      label: "Cancellation customer referrer",
      before: before.customerReferrer,
      after: afterCancel.customerReferrer,
      key: "canceledShareBy",
      expectedDelta: 1,
    });

    assertStateDelta({
      label: "Cancellation provider referrer",
      before: before.providerReferrer,
      after: afterCancel.providerReferrer,
      key: "canceledShareBy",
      expectedDelta: 1,
    });

    assertStateDelta({
      label: "Cancellation customer referrer",
      before: before.customerReferrer,
      after: afterCancel.customerReferrer,
      key: "completedShareBy",
      expectedDelta: 0,
    });

    assertStateDelta({
      label: "Cancellation provider referrer",
      before: before.providerReferrer,
      after: afterCancel.providerReferrer,
      key: "completedShareBy",
      expectedDelta: 0,
    });
  }

  /*
   * A canceled booking must not later become completed.
   */

  const completionAfterCancel = await completeBooking({
    flowType,
    customer,
    bookingId,
  });

  ok(
    !(completionAfterCancel.status >= 200 && completionAfterCancel.status < 300),
    "Completion after cancellation rejected",
    {
      status: completionAfterCancel.status,
      body: completionAfterCancel.data,
    },
  );

  const finalState = await snapshotBookingParticipants({
    flowType,
    customer,
    provider,
    customerReferrer,
    providerReferrer,
  });

  if (sameReferrer) {
    ok(
      near(afterCancel.customerReferrer.earning, finalState.customerReferrer.earning),
      "Completion attempt after cancellation created no referral earning",
    );
  } else {
    ok(
      near(afterCancel.customerReferrer.earning, finalState.customerReferrer.earning),
      "Completion attempt after cancellation did not pay customer referrer",
    );

    ok(
      near(afterCancel.providerReferrer.earning, finalState.providerReferrer.earning),
      "Completion attempt after cancellation did not pay provider referrer",
    );
  }

  return {
    bookingId,
    customer,
    provider,
    customerReferrer,
    providerReferrer,
  };
}
/*
 * =========================================================
 * CONCURRENT COMPLETION TEST
 * =========================================================
 *
 * Purpose:
 *
 * Multiple completion requests for the SAME booking must
 * never:
 *
 * - increment completed more than once
 * - increment completedVendor more than once
 * - decrement pending more than once
 * - decrement pendingVendor more than once
 * - increment completedShareBy more than once per referral
 * - pay referral earning more than once
 *
 * This is one of the most important production invariants.
 */

async function runConcurrentCompletionScenario({
  title,
  flowType,
  customerKind,
  sameReferrer = false,
  concurrency = 25,
}) {
  section(title);

  let customerReferrer;
  let providerReferrer;

  if (sameReferrer) {
    customerReferrer = await signupAndLoginVendor({
      label: `${title} SAME REFERRER`,
    });

    providerReferrer = customerReferrer;
  } else {
    customerReferrer = await signupAndLoginUser({
      label: `${title} CUSTOMER REFERRER`,
    });

    providerReferrer = await signupAndLoginVendor({
      label: `${title} PROVIDER REFERRER`,
    });
  }

  const customer =
    customerKind === "user"
      ? await signupAndLoginUser({
          label: `${title} CUSTOMER`,
          sharedBy: customerReferrer.id,
          cd: customerReferrer.kind,
        })
      : await signupAndLoginVendor({
          label: `${title} VENDOR CUSTOMER`,
          sharedBy: customerReferrer.id,
          cd: customerReferrer.kind,
        });

  const provider = await signupAndLoginVendor({
    label: `${title} PROVIDER`,
    sharedBy: providerReferrer.id,
    cd: providerReferrer.kind,
  });

  /*
   * Make BOTH referral sides eligible.
   *
   * Expected:
   *
   * customer referrer = commission × 5%
   * provider referrer = commission × 5%
   *
   * same referrer = commission × 10%
   */

  if (customer.kind === "user") {
    await setUserMetrics(customer.id, {
      balance: 2000,
      pending: 0,
      completed: 5,
      canceled: 0,
    });
  } else {
    await setVendorMetrics(customer.id, {
      balance: 2000,

      pending: 0,
      completed: 5,
      canceled: 0,

      /*
       * Deliberately different.
       *
       * Vendor acting as customer must use completed.
       */
      completedVendor: 100,
    });
  }

  await setVendorMetrics(provider.id, {
    balance: 2000,

    pendingVendor: 0,
    completedVendor: 5,
    canceledVendor: 0,
  });

  if (customerReferrer.kind === "user") {
    await setUserMetrics(customerReferrer.id, {
      balance: 2000,
      earning: 0,

      pendingShareBy: 0,
      completedShareBy: 0,
      canceledShareBy: 0,
    });
  } else {
    await setVendorMetrics(customerReferrer.id, {
      balance: 2000,
      earning: 0,

      pendingShareBy: 0,
      completedShareBy: 0,
      canceledShareBy: 0,
    });
  }

  if (!sameReferrer) {
    if (providerReferrer.kind === "user") {
      await setUserMetrics(providerReferrer.id, {
        balance: 2000,
        earning: 0,

        pendingShareBy: 0,
        completedShareBy: 0,
        canceledShareBy: 0,
      });
    } else {
      await setVendorMetrics(providerReferrer.id, {
        balance: 2000,
        earning: 0,

        pendingShareBy: 0,
        completedShareBy: 0,
        canceledShareBy: 0,
      });
    }
  }

  const bookingDate = pastDate(60 + bookingSeq);

  const before = await snapshotBookingParticipants({
    flowType,
    customer,
    provider,
    customerReferrer,
    providerReferrer,
  });

  const createResult = await createBooking({
    flowType,
    customer,
    provider,
    bookingDate,
  });

  ok(createResult.status === 201, "Concurrent completion booking created");

  const orderResult = await fetchBookingIdFromOrders({
    flowType,
    customer,
    provider,
    bookingDate,
  });

  const bookingId = orderResult.bookingId;

  createdBookings.push(bookingId);

  ok(Boolean(bookingId), "Concurrent completion test obtained bookingId through getOrders");

  const afterCreate = await snapshotBookingParticipants({
    flowType,
    customer,
    provider,
    customerReferrer,
    providerReferrer,
  });

  /*
   * Verify pending state BEFORE attacking completion endpoint.
   */

  assertStateDelta({
    label: "Concurrent customer",
    before: before.customer,
    after: afterCreate.customer,
    key: "pending",
    expectedDelta: 1,
  });

  assertStateDelta({
    label: "Concurrent provider",
    before: before.provider,
    after: afterCreate.provider,
    key: "pendingVendor",
    expectedDelta: 1,
  });

  if (sameReferrer) {
    assertStateDelta({
      label: "Concurrent same referrer",
      before: before.customerReferrer,
      after: afterCreate.customerReferrer,
      key: "pendingShareBy",
      expectedDelta: 2,
    });
  } else {
    assertStateDelta({
      label: "Concurrent customer referrer",
      before: before.customerReferrer,
      after: afterCreate.customerReferrer,
      key: "pendingShareBy",
      expectedDelta: 1,
    });

    assertStateDelta({
      label: "Concurrent provider referrer",
      before: before.providerReferrer,
      after: afterCreate.providerReferrer,
      key: "pendingShareBy",
      expectedDelta: 1,
    });
  }

  console.log(`\nSending ${concurrency} concurrent completion requests...`);

  const results = await concurrentAction({
    flowType,
    customer,
    bookingId,
    action: "complete",
    concurrency,
  });

  console.table(
    results.map((result) => ({
      request: result.request,
      status: result.status,
    })),
  );

  const summary = summarizeConcurrent(results);

  /*
   * Ideally exactly one request returns 2xx.
   *
   * More important invariant:
   *
   * state transition MUST occur exactly once.
   */

  ok(summary.success.length === 1, "Exactly one concurrent completion request succeeded", {
    successful: summary.success.length,

    conflict409: summary.fail409.length,

    badRequest400: summary.fail400.length,

    other: summary.other,
  });

  ok(
    summary.other.length === 0,
    "Concurrent completion produced no unexpected status",
    summary.other,
  );

  const after = await snapshotBookingParticipants({
    flowType,
    customer,
    provider,
    customerReferrer,
    providerReferrer,
  });

  const booking = await Bookings.findById(bookingId).lean();

  ok(booking?.orderCompleted === true, "Concurrent booking ended completed");

  ok(booking?.cancelOrder === false, "Concurrent booking was not canceled");

  /*
   * Customer state must transition ONCE.
   */

  assertStateDelta({
    label: "Concurrent customer",
    before: afterCreate.customer,
    after: after.customer,
    key: "pending",
    expectedDelta: -1,
  });

  assertStateDelta({
    label: "Concurrent customer",
    before: before.customer,
    after: after.customer,
    key: "completed",
    expectedDelta: 1,
  });

  /*
   * Provider state must transition ONCE.
   */

  assertStateDelta({
    label: "Concurrent provider",
    before: afterCreate.provider,
    after: after.provider,
    key: "pendingVendor",
    expectedDelta: -1,
  });

  assertStateDelta({
    label: "Concurrent provider",
    before: before.provider,
    after: after.provider,
    key: "completedVendor",
    expectedDelta: 1,
  });

  const commission = before.provider.commission;

  const fivePercent = rewardAmount(commission);

  const expectedTotal = fivePercent * 2;

  /*
   * Referral state must transition ONCE.
   */

  if (sameReferrer) {
    const earningDelta = delta(before.customerReferrer.earning, after.customerReferrer.earning);

    ok(
      near(earningDelta, expectedTotal),
      `Concurrent same referrer received exactly ${expectedTotal}`,
      {
        commission,
        earningDelta,
        expectedTotal,
      },
    );

    assertStateDelta({
      label: "Concurrent same referrer",
      before: before.customerReferrer,
      after: after.customerReferrer,
      key: "completedShareBy",
      expectedDelta: 2,
    });

    ok(
      after.customerReferrer.pendingShareBy === before.customerReferrer.pendingShareBy,
      "Concurrent same referrer pendingShareBy returned to original value",
      {
        before: before.customerReferrer.pendingShareBy,

        after: after.customerReferrer.pendingShareBy,
      },
    );

    assertNoBalanceChange(
      "Concurrent same referrer",
      before.customerReferrer,
      after.customerReferrer,
    );
  } else {
    const customerReward = delta(before.customerReferrer.earning, after.customerReferrer.earning);

    const providerReward = delta(before.providerReferrer.earning, after.providerReferrer.earning);

    ok(
      near(customerReward, fivePercent),
      `Concurrent customer referrer received exactly ${fivePercent}`,
      {
        customerReward,
        fivePercent,
      },
    );

    ok(
      near(providerReward, fivePercent),
      `Concurrent provider referrer received exactly ${fivePercent}`,
      {
        providerReward,
        fivePercent,
      },
    );

    assertStateDelta({
      label: "Concurrent customer referrer",
      before: before.customerReferrer,
      after: after.customerReferrer,
      key: "completedShareBy",
      expectedDelta: 1,
    });

    assertStateDelta({
      label: "Concurrent provider referrer",
      before: before.providerReferrer,
      after: after.providerReferrer,
      key: "completedShareBy",
      expectedDelta: 1,
    });

    ok(
      after.customerReferrer.pendingShareBy === before.customerReferrer.pendingShareBy,
      "Concurrent customer referrer pendingShareBy returned to original value",
    );

    ok(
      after.providerReferrer.pendingShareBy === before.providerReferrer.pendingShareBy,
      "Concurrent provider referrer pendingShareBy returned to original value",
    );

    assertNoBalanceChange(
      "Concurrent customer referrer",
      before.customerReferrer,
      after.customerReferrer,
    );

    assertNoBalanceChange(
      "Concurrent provider referrer",
      before.providerReferrer,
      after.providerReferrer,
    );
  }

  console.log("\nCONCURRENT COMPLETION RESULT:");

  console.dir(
    {
      bookingId,

      requests: concurrency,

      successful: summary.success.length,

      conflict409: summary.fail409.length,

      badRequest400: summary.fail400.length,

      unexpected: summary.other.length,

      commission,
      expectedReferralTotal: expectedTotal,
    },
    {
      depth: null,
    },
  );
}

/*
 * =========================================================
 * CONCURRENT CANCELLATION TEST
 * =========================================================
 */

async function runConcurrentCancellationScenario({
  title,
  flowType,
  customerKind,
  sameReferrer = false,
  concurrency = 25,
}) {
  section(title);

  let customerReferrer;
  let providerReferrer;

  if (sameReferrer) {
    customerReferrer = await signupAndLoginUser({
      label: `${title} SAME REFERRER`,
    });

    providerReferrer = customerReferrer;
  } else {
    customerReferrer = await signupAndLoginUser({
      label: `${title} CUSTOMER REFERRER`,
    });

    providerReferrer = await signupAndLoginVendor({
      label: `${title} PROVIDER REFERRER`,
    });
  }

  const customer =
    customerKind === "user"
      ? await signupAndLoginUser({
          label: `${title} CUSTOMER`,
          sharedBy: customerReferrer.id,
          cd: customerReferrer.kind,
        })
      : await signupAndLoginVendor({
          label: `${title} VENDOR CUSTOMER`,
          sharedBy: customerReferrer.id,
          cd: customerReferrer.kind,
        });

  const provider = await signupAndLoginVendor({
    label: `${title} PROVIDER`,
    sharedBy: providerReferrer.id,
    cd: providerReferrer.kind,
  });

  /*
   * Both sides eligible, but cancellation
   * must still pay ZERO referral reward.
   */

  if (customer.kind === "user") {
    await setUserMetrics(customer.id, {
      balance: 2000,
      pending: 0,
      completed: 10,
      canceled: 0,
    });
  } else {
    await setVendorMetrics(customer.id, {
      balance: 2000,

      pending: 0,
      completed: 10,
      canceled: 0,

      completedVendor: 100,
    });
  }

  await setVendorMetrics(provider.id, {
    balance: 2000,

    pendingVendor: 0,
    completedVendor: 10,
    canceledVendor: 0,
  });

  if (customerReferrer.kind === "user") {
    await setUserMetrics(customerReferrer.id, {
      balance: 2000,
      earning: 0,

      pendingShareBy: 0,
      completedShareBy: 0,
      canceledShareBy: 0,
    });
  } else {
    await setVendorMetrics(customerReferrer.id, {
      balance: 2000,
      earning: 0,

      pendingShareBy: 0,
      completedShareBy: 0,
      canceledShareBy: 0,
    });
  }

  if (!sameReferrer) {
    if (providerReferrer.kind === "user") {
      await setUserMetrics(providerReferrer.id, {
        balance: 2000,
        earning: 0,

        pendingShareBy: 0,
        completedShareBy: 0,
        canceledShareBy: 0,
      });
    } else {
      await setVendorMetrics(providerReferrer.id, {
        balance: 2000,
        earning: 0,

        pendingShareBy: 0,
        completedShareBy: 0,
        canceledShareBy: 0,
      });
    }
  }

  const bookingDate = pastDate(90 + bookingSeq);

  const before = await snapshotBookingParticipants({
    flowType,
    customer,
    provider,
    customerReferrer,
    providerReferrer,
  });

  const createResult = await createBooking({
    flowType,
    customer,
    provider,
    bookingDate,
  });

  ok(createResult.status === 201, "Concurrent cancellation booking created");

  const orderResult = await fetchBookingIdFromOrders({
    flowType,
    customer,
    provider,
    bookingDate,
  });

  const bookingId = orderResult.bookingId;

  createdBookings.push(bookingId);

  ok(Boolean(bookingId), "Concurrent cancellation obtained bookingId through getOrders");

  const afterCreate = await snapshotBookingParticipants({
    flowType,
    customer,
    provider,
    customerReferrer,
    providerReferrer,
  });

  assertStateDelta({
    label: "Concurrent cancellation customer",
    before: before.customer,
    after: afterCreate.customer,
    key: "pending",
    expectedDelta: 1,
  });

  assertStateDelta({
    label: "Concurrent cancellation provider",
    before: before.provider,
    after: afterCreate.provider,
    key: "pendingVendor",
    expectedDelta: 1,
  });

  console.log(`\nSending ${concurrency} concurrent cancellation requests...`);

  const results = await concurrentAction({
    flowType,
    customer,
    bookingId,
    action: "cancel",
    concurrency,
  });

  console.table(
    results.map((result) => ({
      request: result.request,
      status: result.status,
    })),
  );

  const summary = summarizeConcurrent(results);

  ok(summary.success.length === 1, "Exactly one concurrent cancellation request succeeded", {
    successful: summary.success.length,

    conflict409: summary.fail409.length,

    badRequest400: summary.fail400.length,

    other: summary.other,
  });

  ok(
    summary.other.length === 0,
    "Concurrent cancellation produced no unexpected response",
    summary.other,
  );

  const after = await snapshotBookingParticipants({
    flowType,
    customer,
    provider,
    customerReferrer,
    providerReferrer,
  });

  const booking = await Bookings.findById(bookingId).lean();

  ok(booking?.cancelOrder === true, "Concurrent cancellation booking ended canceled");

  ok(booking?.orderCompleted === false, "Concurrent cancellation booking was not completed");

  /*
   * Customer state transition once.
   */

  assertStateDelta({
    label: "Concurrent cancellation customer",
    before: afterCreate.customer,
    after: after.customer,
    key: "pending",
    expectedDelta: -1,
  });

  assertStateDelta({
    label: "Concurrent cancellation customer",
    before: before.customer,
    after: after.customer,
    key: "canceled",
    expectedDelta: 1,
  });

  /*
   * Provider state transition once.
   */

  assertStateDelta({
    label: "Concurrent cancellation provider",
    before: afterCreate.provider,
    after: after.provider,
    key: "pendingVendor",
    expectedDelta: -1,
  });

  assertStateDelta({
    label: "Concurrent cancellation provider",
    before: before.provider,
    after: after.provider,
    key: "canceledVendor",
    expectedDelta: 1,
  });

  /*
   * No referral reward.
   */

  if (sameReferrer) {
    ok(
      near(before.customerReferrer.earning, after.customerReferrer.earning),
      "Concurrent cancellation paid no earning to same referrer",
    );

    assertStateDelta({
      label: "Concurrent cancellation same referrer",
      before: before.customerReferrer,
      after: after.customerReferrer,
      key: "canceledShareBy",
      expectedDelta: 2,
    });

    assertStateDelta({
      label: "Concurrent cancellation same referrer",
      before: before.customerReferrer,
      after: after.customerReferrer,
      key: "completedShareBy",
      expectedDelta: 0,
    });

    ok(
      after.customerReferrer.pendingShareBy === before.customerReferrer.pendingShareBy,
      "Concurrent cancellation same referrer pendingShareBy returned to original value",
    );
  } else {
    ok(
      near(before.customerReferrer.earning, after.customerReferrer.earning),
      "Concurrent cancellation paid no customer referral earning",
    );

    ok(
      near(before.providerReferrer.earning, after.providerReferrer.earning),
      "Concurrent cancellation paid no provider referral earning",
    );

    assertStateDelta({
      label: "Concurrent cancellation customer referrer",
      before: before.customerReferrer,
      after: after.customerReferrer,
      key: "canceledShareBy",
      expectedDelta: 1,
    });

    assertStateDelta({
      label: "Concurrent cancellation provider referrer",
      before: before.providerReferrer,
      after: after.providerReferrer,
      key: "canceledShareBy",
      expectedDelta: 1,
    });

    assertStateDelta({
      label: "Concurrent cancellation customer referrer",
      before: before.customerReferrer,
      after: after.customerReferrer,
      key: "completedShareBy",
      expectedDelta: 0,
    });

    assertStateDelta({
      label: "Concurrent cancellation provider referrer",
      before: before.providerReferrer,
      after: after.providerReferrer,
      key: "completedShareBy",
      expectedDelta: 0,
    });

    ok(
      after.customerReferrer.pendingShareBy === before.customerReferrer.pendingShareBy,
      "Concurrent cancellation customer referrer pendingShareBy returned to original value",
    );

    ok(
      after.providerReferrer.pendingShareBy === before.providerReferrer.pendingShareBy,
      "Concurrent cancellation provider referrer pendingShareBy returned to original value",
    );
  }

  /*
   * Ensure duplicate cancellation also does not
   * mutate anything.
   */

  const beforeDuplicate = await snapshotBookingParticipants({
    flowType,
    customer,
    provider,
    customerReferrer,
    providerReferrer,
  });

  const duplicateCancel = await cancelBooking({
    flowType,
    customer,
    bookingId,
  });

  const afterDuplicate = await snapshotBookingParticipants({
    flowType,
    customer,
    provider,
    customerReferrer,
    providerReferrer,
  });

  ok(
    !(duplicateCancel.status >= 200 && duplicateCancel.status < 300),
    "Duplicate cancellation rejected",
    {
      status: duplicateCancel.status,
      body: duplicateCancel.data,
    },
  );

  ok(
    beforeDuplicate.customer.canceled === afterDuplicate.customer.canceled,
    "Duplicate cancellation did not increment customer canceled again",
  );

  ok(
    beforeDuplicate.provider.canceledVendor === afterDuplicate.provider.canceledVendor,
    "Duplicate cancellation did not increment provider canceledVendor again",
  );

  if (sameReferrer) {
    ok(
      beforeDuplicate.customerReferrer.canceledShareBy ===
        afterDuplicate.customerReferrer.canceledShareBy,
      "Duplicate cancellation did not increment same referrer canceledShareBy again",
    );

    ok(
      near(beforeDuplicate.customerReferrer.earning, afterDuplicate.customerReferrer.earning),
      "Duplicate cancellation did not create same-referrer earning",
    );
  } else {
    ok(
      beforeDuplicate.customerReferrer.canceledShareBy ===
        afterDuplicate.customerReferrer.canceledShareBy,
      "Duplicate cancellation did not increment customer referrer canceledShareBy again",
    );

    ok(
      beforeDuplicate.providerReferrer.canceledShareBy ===
        afterDuplicate.providerReferrer.canceledShareBy,
      "Duplicate cancellation did not increment provider referrer canceledShareBy again",
    );

    ok(
      near(beforeDuplicate.customerReferrer.earning, afterDuplicate.customerReferrer.earning),
      "Duplicate cancellation did not create customer-referrer earning",
    );

    ok(
      near(beforeDuplicate.providerReferrer.earning, afterDuplicate.providerReferrer.earning),
      "Duplicate cancellation did not create provider-referrer earning",
    );
  }

  console.log("\nCONCURRENT CANCELLATION RESULT:");

  console.dir(
    {
      bookingId,

      requests: concurrency,

      successful: summary.success.length,

      conflict409: summary.fail409.length,

      badRequest400: summary.fail400.length,

      unexpected: summary.other.length,
    },
    {
      depth: null,
    },
  );
}

/*
 * =========================================================
 * COMPLETE VS CANCEL RACE
 * =========================================================
 *
 * This test intentionally sends completion and cancellation
 * at almost the same time.
 *
 * Exactly ONE terminal state must win.
 *
 * Valid final states:
 *
 *   completed = true, cancelOrder = false
 *
 * OR
 *
 *   completed = false, cancelOrder = true
 *
 * Invalid:
 *
 *   completed = true AND cancelOrder = true
 *
 * Invalid:
 *
 *   both terminal accounting paths applied
 */

async function runCompleteCancelRace({ title, flowType, customerKind }) {
  section(title);

  const customerReferrer = await signupAndLoginUser({
    label: `${title} CUSTOMER REFERRER`,
  });

  const providerReferrer = await signupAndLoginVendor({
    label: `${title} PROVIDER REFERRER`,
  });

  const customer =
    customerKind === "user"
      ? await signupAndLoginUser({
          label: `${title} CUSTOMER`,
          sharedBy: customerReferrer.id,
          cd: customerReferrer.kind,
        })
      : await signupAndLoginVendor({
          label: `${title} VENDOR CUSTOMER`,
          sharedBy: customerReferrer.id,
          cd: customerReferrer.kind,
        });

  const provider = await signupAndLoginVendor({
    label: `${title} PROVIDER`,
    sharedBy: providerReferrer.id,
    cd: providerReferrer.kind,
  });

  /*
   * Both referral paths eligible.
   */

  if (customer.kind === "user") {
    await setUserMetrics(customer.id, {
      balance: 2000,
      pending: 0,
      completed: 5,
      canceled: 0,
    });
  } else {
    await setVendorMetrics(customer.id, {
      balance: 2000,
      pending: 0,
      completed: 5,
      canceled: 0,

      completedVendor: 99,
    });
  }

  await setVendorMetrics(provider.id, {
    balance: 2000,

    pendingVendor: 0,
    completedVendor: 5,
    canceledVendor: 0,
  });

  await setUserMetrics(customerReferrer.id, {
    balance: 2000,
    earning: 0,

    pendingShareBy: 0,
    completedShareBy: 0,
    canceledShareBy: 0,
  });

  await setVendorMetrics(providerReferrer.id, {
    balance: 2000,
    earning: 0,

    pendingShareBy: 0,
    completedShareBy: 0,
    canceledShareBy: 0,
  });

  const bookingDate = pastDate(120 + bookingSeq);

  const before = await snapshotBookingParticipants({
    flowType,
    customer,
    provider,
    customerReferrer,
    providerReferrer,
  });

  await createBooking({
    flowType,
    customer,
    provider,
    bookingDate,
  });

  const orderResult = await fetchBookingIdFromOrders({
    flowType,
    customer,
    provider,
    bookingDate,
  });

  const bookingId = orderResult.bookingId;

  createdBookings.push(bookingId);

  const afterCreate = await snapshotBookingParticipants({
    flowType,
    customer,
    provider,
    customerReferrer,
    providerReferrer,
  });

  ok(
    afterCreate.customer.pending === before.customer.pending + 1,
    "Race booking entered customer pending state",
  );

  ok(
    afterCreate.provider.pendingVendor === before.provider.pendingVendor + 1,
    "Race booking entered provider pendingVendor state",
  );

  console.log("\nSending COMPLETE and CANCEL simultaneously...");

  const [completionRes, cancellationRes] = await Promise.all([
    completeBooking({
      flowType,
      customer,
      bookingId,
    }),

    cancelBooking({
      flowType,
      customer,
      bookingId,
    }),
  ]);

  console.table([
    {
      action: "complete",
      status: completionRes.status,
    },
    {
      action: "cancel",
      status: cancellationRes.status,
    },
  ]);

  const successes = [completionRes, cancellationRes].filter(
    (res) => res.status >= 200 && res.status < 300,
  );

  ok(successes.length === 1, "Exactly one terminal operation won complete/cancel race", {
    completionStatus: completionRes.status,

    cancellationStatus: cancellationRes.status,
  });

  const after = await snapshotBookingParticipants({
    flowType,
    customer,
    provider,
    customerReferrer,
    providerReferrer,
  });

  const booking = await Bookings.findById(bookingId).lean();

  const isCompleted = booking?.orderCompleted === true && booking?.cancelOrder === false;

  const isCanceled = booking?.cancelOrder === true && booking?.orderCompleted === false;

  ok(isCompleted || isCanceled, "Booking ended in exactly one valid terminal state", {
    orderCompleted: booking?.orderCompleted,

    cancelOrder: booking?.cancelOrder,
  });

  ok(
    !(booking?.orderCompleted === true && booking?.cancelOrder === true),
    "Booking never became both completed and canceled",
  );

  /*
   * Pending must always be consumed exactly once,
   * regardless of which terminal action wins.
   */

  ok(
    after.customer.pending === before.customer.pending,
    "Race consumed customer pending exactly once",
    {
      before: before.customer.pending,

      after: after.customer.pending,
    },
  );

  ok(
    after.provider.pendingVendor === before.provider.pendingVendor,
    "Race consumed provider pendingVendor exactly once",
    {
      before: before.provider.pendingVendor,

      after: after.provider.pendingVendor,
    },
  );

  if (isCompleted) {
    assertStateDelta({
      label: "Race customer completed",
      before: before.customer,
      after: after.customer,
      key: "completed",
      expectedDelta: 1,
    });

    assertStateDelta({
      label: "Race customer canceled",
      before: before.customer,
      after: after.customer,
      key: "canceled",
      expectedDelta: 0,
    });

    assertStateDelta({
      label: "Race provider completedVendor",
      before: before.provider,
      after: after.provider,
      key: "completedVendor",
      expectedDelta: 1,
    });

    assertStateDelta({
      label: "Race provider canceledVendor",
      before: before.provider,
      after: after.provider,
      key: "canceledVendor",
      expectedDelta: 0,
    });

    const expectedReward = rewardAmount(before.provider.commission);

    ok(
      near(delta(before.customerReferrer.earning, after.customerReferrer.earning), expectedReward),
      "Completed race paid customer referral exactly once",
    );

    ok(
      near(delta(before.providerReferrer.earning, after.providerReferrer.earning), expectedReward),
      "Completed race paid provider referral exactly once",
    );

    assertStateDelta({
      label: "Race customer referrer completedShareBy",
      before: before.customerReferrer,
      after: after.customerReferrer,
      key: "completedShareBy",
      expectedDelta: 1,
    });

    assertStateDelta({
      label: "Race provider referrer completedShareBy",
      before: before.providerReferrer,
      after: after.providerReferrer,
      key: "completedShareBy",
      expectedDelta: 1,
    });

    assertStateDelta({
      label: "Race customer referrer canceledShareBy",
      before: before.customerReferrer,
      after: after.customerReferrer,
      key: "canceledShareBy",
      expectedDelta: 0,
    });

    assertStateDelta({
      label: "Race provider referrer canceledShareBy",
      before: before.providerReferrer,
      after: after.providerReferrer,
      key: "canceledShareBy",
      expectedDelta: 0,
    });
  }

  if (isCanceled) {
    assertStateDelta({
      label: "Race customer completed",
      before: before.customer,
      after: after.customer,
      key: "completed",
      expectedDelta: 0,
    });

    assertStateDelta({
      label: "Race customer canceled",
      before: before.customer,
      after: after.customer,
      key: "canceled",
      expectedDelta: 1,
    });

    assertStateDelta({
      label: "Race provider completedVendor",
      before: before.provider,
      after: after.provider,
      key: "completedVendor",
      expectedDelta: 0,
    });

    assertStateDelta({
      label: "Race provider canceledVendor",
      before: before.provider,
      after: after.provider,
      key: "canceledVendor",
      expectedDelta: 1,
    });

    ok(
      near(before.customerReferrer.earning, after.customerReferrer.earning),
      "Canceled race paid no customer referral earning",
    );

    ok(
      near(before.providerReferrer.earning, after.providerReferrer.earning),
      "Canceled race paid no provider referral earning",
    );

    assertStateDelta({
      label: "Race customer referrer canceledShareBy",
      before: before.customerReferrer,
      after: after.customerReferrer,
      key: "canceledShareBy",
      expectedDelta: 1,
    });

    assertStateDelta({
      label: "Race provider referrer canceledShareBy",
      before: before.providerReferrer,
      after: after.providerReferrer,
      key: "canceledShareBy",
      expectedDelta: 1,
    });

    assertStateDelta({
      label: "Race customer referrer completedShareBy",
      before: before.customerReferrer,
      after: after.customerReferrer,
      key: "completedShareBy",
      expectedDelta: 0,
    });

    assertStateDelta({
      label: "Race provider referrer completedShareBy",
      before: before.providerReferrer,
      after: after.providerReferrer,
      key: "completedShareBy",
      expectedDelta: 0,
    });
  }

  ok(
    after.customerReferrer.pendingShareBy === before.customerReferrer.pendingShareBy,
    "Race customer referrer pendingShareBy returned to original value",
  );

  ok(
    after.providerReferrer.pendingShareBy === before.providerReferrer.pendingShareBy,
    "Race provider referrer pendingShareBy returned to original value",
  );

  console.log("\nCOMPLETE VS CANCEL RACE RESULT:");

  console.dir(
    {
      bookingId,

      completionStatus: completionRes.status,

      cancellationStatus: cancellationRes.status,

      finalState: isCompleted ? "COMPLETED" : isCanceled ? "CANCELED" : "INVALID",
    },
    {
      depth: null,
    },
  );
}
/*
 * =========================================================
 * FULL SCENARIO MATRIX
 * =========================================================
 *
 * IMPORTANT DOMAIN RULES VERIFIED BY THIS SUITE:
 *
 * 1. U flow:
 *    User acts as customer.
 *    Customer counters:
 *      pending / completed / canceled
 *
 * 2. V flow:
 *    Vendor acts as customer.
 *    Customer counters are STILL:
 *      pending / completed / canceled
 *
 *    completedVendor is NOT used merely because the
 *    customer happens to be a Vendor document.
 *
 * 3. Service provider counters:
 *      pendingVendor
 *      completedVendor
 *      canceledVendor
 *
 * 4. Referral eligibility:
 *
 *    customer side:
 *      entity.completed >= 5
 *
 *    provider side:
 *      entity.completedVendor >= 5
 *
 * 5. Reward:
 *
 *    eligible customer referral:
 *      commission * 5%
 *
 *    eligible provider referral:
 *      commission * 5%
 *
 *    both eligible:
 *      commission * 10% total
 *
 * 6. Reward goes to earning, NOT balance.
 *
 * 7. entity.cd identifies what model shareBy belongs to.
 */
async function runLifecycleScenario({
  title,
  flowType,
  customerKind,

  customerCompleted = 0,
  customerCompletedVendor = 0,
  providerCompletedVendor = 0,

  customerReferrerKind = "user",
  providerReferrerKind = "vendor",

  terminalAction = "complete",
  sameReferrer = false,
}) {
  if (terminalAction === "complete") {
    return runCompletionScenario({
      title,
      flowType,
      customerKind,

      customerCompleted,
      customerCompletedVendor,
      providerCompletedVendor,

      customerReferrerKind,
      providerReferrerKind,

      sameReferrer,
    });
  }

  if (terminalAction === "cancel") {
    return runCancellationScenario({
      title,
      flowType,
      customerKind,

      customerCompleted,
      customerCompletedVendor,
      providerCompletedVendor,

      customerReferrerKind,
      providerReferrerKind,

      sameReferrer,
    });
  }

  throw new Error(`Unsupported terminalAction "${terminalAction}" in scenario "${title}"`);
}

/*
 * =========================================================
 * FULL SCENARIO MATRIX
 * =========================================================
 */
async function runStandardScenarioMatrix() {
  section("STANDARD BOOKING LIFECYCLE MATRIX");

  /*
   * -------------------------------------------------------
   * USER AS CUSTOMER
   * -------------------------------------------------------
   */

  await runLifecycleScenario({
    title: "U1 - USER CUSTOMER - NEITHER REFERRAL ELIGIBLE - COMPLETE",
    flowType: "U",
    customerKind: "user",

    customerCompleted: 4,
    providerCompletedVendor: 4,

    terminalAction: "complete",
    sameReferrer: false,
  });

  await runLifecycleScenario({
    title: "U2 - USER CUSTOMER - CUSTOMER REFERRAL ONLY - COMPLETE",
    flowType: "U",
    customerKind: "user",

    customerCompleted: 5,
    providerCompletedVendor: 4,

    terminalAction: "complete",
    sameReferrer: false,
  });

  await runLifecycleScenario({
    title: "U3 - USER CUSTOMER - PROVIDER REFERRAL ONLY - COMPLETE",
    flowType: "U",
    customerKind: "user",

    customerCompleted: 4,
    providerCompletedVendor: 5,

    terminalAction: "complete",
    sameReferrer: false,
  });

  await runLifecycleScenario({
    title: "U4 - USER CUSTOMER - BOTH ELIGIBLE - DIFFERENT REFERRERS - COMPLETE",
    flowType: "U",
    customerKind: "user",

    customerCompleted: 5,
    providerCompletedVendor: 5,

    terminalAction: "complete",
    sameReferrer: false,
  });

  await runLifecycleScenario({
    title: "U5 - USER CUSTOMER - BOTH ELIGIBLE - SAME REFERRER - COMPLETE",
    flowType: "U",
    customerKind: "user",

    customerCompleted: 5,
    providerCompletedVendor: 5,

    terminalAction: "complete",
    sameReferrer: true,
  });

  await runLifecycleScenario({
    title: "U6 - USER CUSTOMER - BOTH ELIGIBLE - CANCEL",
    flowType: "U",
    customerKind: "user",

    customerCompleted: 5,
    providerCompletedVendor: 5,

    terminalAction: "cancel",
    sameReferrer: false,
  });

  /*
   * -------------------------------------------------------
   * VENDOR ACTING AS CUSTOMER
   * -------------------------------------------------------
   *
   * This is specifically testing your rule:
   *
   * orderCompletedV means the ACTOR is a vendor account.
   *
   * It does NOT mean completedVendor should be used for
   * that actor's customer-side referral eligibility.
   *
   * Vendor acting as customer:
   *
   *     completed
   *
   * Service provider:
   *
   *     completedVendor
   */

  await runLifecycleScenario({
    title: "V1 - VENDOR CUSTOMER - NEITHER REFERRAL ELIGIBLE - COMPLETE",
    flowType: "V",
    customerKind: "vendor",

    customerCompleted: 4,

    /*
     * Deliberately make completedVendor huge.
     *
     * If implementation incorrectly checks
     * customer.completedVendor, this scenario will expose it.
     */
    customerCompletedVendor: 100,

    providerCompletedVendor: 4,

    terminalAction: "complete",
    sameReferrer: false,
  });

  await runLifecycleScenario({
    title: "V2 - VENDOR CUSTOMER - CUSTOMER REFERRAL ONLY - COMPLETE",
    flowType: "V",
    customerKind: "vendor",

    customerCompleted: 5,

    /*
     * Deliberately zero.
     *
     * Customer reward MUST still happen because
     * customer eligibility uses completed.
     */
    customerCompletedVendor: 0,

    providerCompletedVendor: 4,

    terminalAction: "complete",
    sameReferrer: false,
  });

  await runLifecycleScenario({
    title: "V3 - VENDOR CUSTOMER - PROVIDER REFERRAL ONLY - COMPLETE",
    flowType: "V",
    customerKind: "vendor",

    customerCompleted: 4,
    customerCompletedVendor: 100,

    providerCompletedVendor: 5,

    terminalAction: "complete",
    sameReferrer: false,
  });

  await runLifecycleScenario({
    title: "V4 - VENDOR CUSTOMER - BOTH ELIGIBLE - DIFFERENT REFERRERS - COMPLETE",
    flowType: "V",
    customerKind: "vendor",

    customerCompleted: 5,
    customerCompletedVendor: 0,

    providerCompletedVendor: 5,

    terminalAction: "complete",
    sameReferrer: false,
  });

  await runLifecycleScenario({
    title: "V5 - VENDOR CUSTOMER - BOTH ELIGIBLE - SAME REFERRER - COMPLETE",
    flowType: "V",
    customerKind: "vendor",

    customerCompleted: 5,
    customerCompletedVendor: 0,

    providerCompletedVendor: 5,

    terminalAction: "complete",
    sameReferrer: true,
  });

  await runLifecycleScenario({
    title: "V6 - VENDOR CUSTOMER - BOTH ELIGIBLE - CANCEL",
    flowType: "V",
    customerKind: "vendor",

    customerCompleted: 5,
    customerCompletedVendor: 100,

    providerCompletedVendor: 5,

    terminalAction: "cancel",
    sameReferrer: false,
  });
}

/*
 * =========================================================
 * REFERRER MODEL MATRIX
 * =========================================================
 *
 * entity.cd identifies what collection shareBy belongs to.
 *
 * We therefore explicitly verify:
 *
 * User -> User
 * Vendor -> User
 * User -> Vendor
 * Vendor -> Vendor
 */

async function runReferrerModelMatrix() {
  section("REFERRER MODEL MATRIX");

  await runLifecycleScenario({
    title: "R1 - USER CUSTOMER SHARED BY USER + PROVIDER SHARED BY USER",
    flowType: "U",
    customerKind: "user",

    customerReferrerKind: "user",
    providerReferrerKind: "user",

    customerCompleted: 5,
    providerCompletedVendor: 5,

    terminalAction: "complete",
    sameReferrer: false,
  });

  await runLifecycleScenario({
    title: "R2 - USER CUSTOMER SHARED BY VENDOR + PROVIDER SHARED BY USER",
    flowType: "U",
    customerKind: "user",

    customerReferrerKind: "vendor",
    providerReferrerKind: "user",

    customerCompleted: 5,
    providerCompletedVendor: 5,

    terminalAction: "complete",
    sameReferrer: false,
  });

  await runLifecycleScenario({
    title: "R3 - USER CUSTOMER SHARED BY USER + PROVIDER SHARED BY VENDOR",
    flowType: "U",
    customerKind: "user",

    customerReferrerKind: "user",
    providerReferrerKind: "vendor",

    customerCompleted: 5,
    providerCompletedVendor: 5,

    terminalAction: "complete",
    sameReferrer: false,
  });

  await runLifecycleScenario({
    title: "R4 - USER CUSTOMER SHARED BY VENDOR + PROVIDER SHARED BY VENDOR",
    flowType: "U",
    customerKind: "user",

    customerReferrerKind: "vendor",
    providerReferrerKind: "vendor",

    customerCompleted: 5,
    providerCompletedVendor: 5,

    terminalAction: "complete",
    sameReferrer: false,
  });
}

/*
 * =========================================================
 * BOUNDARY TESTS
 * =========================================================
 *
 * Critical eligibility boundary:
 *
 * BEFORE completion:
 *
 * completed = 4
 *   booking #5 completes
 *   no reward
 *
 * completed = 5
 *   booking #6 completes
 *   reward applies
 *
 * Same rule for completedVendor.
 */

async function runThresholdBoundaryMatrix() {
  section("REFERRAL THRESHOLD BOUNDARY MATRIX");

  await runLifecycleScenario({
    title: "B1 - CUSTOMER COMPLETED=4 - PROVIDER COMPLETEDVENDOR=4",
    flowType: "U",
    customerKind: "user",

    customerCompleted: 4,
    providerCompletedVendor: 4,

    terminalAction: "complete",
    sameReferrer: false,
  });

  await runLifecycleScenario({
    title: "B2 - CUSTOMER COMPLETED=5 - PROVIDER COMPLETEDVENDOR=4",
    flowType: "U",
    customerKind: "user",

    customerCompleted: 5,
    providerCompletedVendor: 4,

    terminalAction: "complete",
    sameReferrer: false,
  });

  await runLifecycleScenario({
    title: "B3 - CUSTOMER COMPLETED=4 - PROVIDER COMPLETEDVENDOR=5",
    flowType: "U",
    customerKind: "user",

    customerCompleted: 4,
    providerCompletedVendor: 5,

    terminalAction: "complete",
    sameReferrer: false,
  });

  await runLifecycleScenario({
    title: "B4 - CUSTOMER COMPLETED=5 - PROVIDER COMPLETEDVENDOR=5",
    flowType: "U",
    customerKind: "user",

    customerCompleted: 5,
    providerCompletedVendor: 5,

    terminalAction: "complete",
    sameReferrer: false,
  });
}

/*
 * =========================================================
 * CONCURRENCY MATRIX
 * =========================================================
 */

async function runConcurrencyMatrix() {
  section("CONCURRENCY MATRIX");

  await runConcurrentCompletionScenario({
    title: "C1 - 25x USER COMPLETION - DIFFERENT REFERRERS",
    flowType: "U",
    customerKind: "user",
    sameReferrer: false,
    concurrency: 25,
  });

  await runConcurrentCompletionScenario({
    title: "C2 - 25x USER COMPLETION - SAME REFERRER",
    flowType: "U",
    customerKind: "user",
    sameReferrer: true,
    concurrency: 25,
  });

  await runConcurrentCompletionScenario({
    title: "C3 - 25x VENDOR-AS-CUSTOMER COMPLETION",
    flowType: "V",
    customerKind: "vendor",
    sameReferrer: false,
    concurrency: 25,
  });

  await runConcurrentCancellationScenario({
    title: "C4 - 25x USER CANCELLATION",
    flowType: "U",
    customerKind: "user",
    sameReferrer: false,
    concurrency: 25,
  });

  await runConcurrentCancellationScenario({
    title: "C5 - 25x VENDOR-AS-CUSTOMER CANCELLATION",
    flowType: "V",
    customerKind: "vendor",
    sameReferrer: true,
    concurrency: 25,
  });
}

/*
 * =========================================================
 * TERMINAL STATE RACE MATRIX
 * =========================================================
 */

async function runTerminalRaceMatrix() {
  section("COMPLETE VS CANCEL RACE MATRIX");

  await runCompleteCancelRace({
    title: "T1 - USER CUSTOMER COMPLETE VS CANCEL RACE",
    flowType: "U",
    customerKind: "user",
  });

  await runCompleteCancelRace({
    title: "T2 - VENDOR CUSTOMER COMPLETE VS CANCEL RACE",
    flowType: "V",
    customerKind: "vendor",
  });
}

/*
 * =========================================================
 * DATABASE SAFETY
 * =========================================================
 */

function assertSafeEnvironment() {
  const nodeEnv = String(process.env.NODE_ENV || "")
    .trim()
    .toLowerCase();

  if (nodeEnv === "production") {
    throw new Error("REFUSING TO RUN: lifecycle test must not run with NODE_ENV=production.");
  }

  const mongoUri = String(
    process.env.MONGODB_URL_1 || process.env.MONGODB_URI || process.env.DB_URI || "",
  ).toLowerCase();

  /*
   * Do not silently run destructive test-data creation
   * against a production Atlas database.
   *
   * ALLOW_LIFECYCLE_TEST=1 must be explicitly supplied.
   */

  if (process.env.ALLOW_LIFECYCLE_TEST !== "1") {
    throw new Error(
      [
        "REFUSING TO RUN lifecycle test.",
        "",
        "Set:",
        "",
        "ALLOW_LIFECYCLE_TEST=1",
        "",
        "only after confirming this is your DEVELOPMENT/TEST database.",
      ].join("\n"),
    );
  }

  if (!mongoUri) {
    console.warn("WARNING: MongoDB URI was not found in common environment variables.");
  }
}

/*
 * =========================================================
 * CLEANUP
 * =========================================================
 */

async function cleanup() {
  section("CLEANUP");

  try {
    /*
     * Delete explicitly tracked bookings first.
     */

    const uniqueBookingIds = [...new Set(createdBookings.filter(Boolean).map((id) => String(id)))];

    let bookingResult = {
      deletedCount: 0,
    };

    if (uniqueBookingIds.length > 0) {
      bookingResult = await Bookings.deleteMany({
        _id: {
          $in: uniqueBookingIds,
        },
      });
    }

    /*
     * The helper functions in Parts 1/2 should track
     * created users/vendors.
     *
     * We additionally restrict deletion to those IDs.
     */

    const uniqueUserIds = [
      ...new Set(createdUsers.filter(Boolean).map((id) => String(id.id || id))),
    ];

    const uniqueVendorIds = [
      ...new Set(createdVendors.filter(Boolean).map((id) => String(id.id || id))),
    ];

    let userResult = {
      deletedCount: 0,
    };

    let vendorResult = {
      deletedCount: 0,
    };

    if (uniqueUserIds.length > 0) {
      userResult = await User.deleteMany({
        _id: {
          $in: uniqueUserIds,
        },
      });
    }

    if (uniqueVendorIds.length > 0) {
      vendorResult = await Vendor.deleteMany({
        _id: {
          $in: uniqueVendorIds,
        },
      });
    }

    /*
     * If signup creates Share records,
     * clean those belonging to our generated accounts.
     *
     * Only execute if Share model exists in Part 1.
     */

    let shareDeleted = 0;

    if (typeof Share !== "undefined") {
      const shareResult = await Share.deleteMany({
        $or: [
          {
            userId: {
              $in: uniqueUserIds,
            },
          },
          {
            vendorId: {
              $in: uniqueVendorIds,
            },
          },
        ],
      });

      shareDeleted = shareResult.deletedCount || 0;
    }

    console.log({
      bookingsDeleted: bookingResult.deletedCount || 0,

      usersDeleted: userResult.deletedCount || 0,

      vendorsDeleted: vendorResult.deletedCount || 0,

      sharesDeleted: shareDeleted,
    });
  } catch (error) {
    console.error("Cleanup failed:", error);

    /*
     * Cleanup failure should be visible but must not
     * hide the original test failure.
     */
  }
}

/*
 * =========================================================
 * FINAL REPORT
 * =========================================================
 */

function printFinalReport(crashed = false) {
  section("FINAL TEST SUMMARY");

  console.log(`Assertions: ${assertions}`);

  console.log(`Passed: ${passed}`);

  console.log(`Failed: ${failed}`);

  if (failures.length > 0) {
    console.log("\nFAILED ASSERTIONS:");

    failures.forEach((failure, index) => {
      console.log(`${index + 1}. ${failure.message}`);

      if (failure.details !== undefined) {
        console.dir(failure.details, {
          depth: null,
        });
      }
    });
  }

  if (!crashed && failed === 0) {
    console.log(`
========================================
PASS: ALL BOOKING LIFECYCLE INVARIANTS PASSED
========================================

Verified:

✓ User can signup and login through real API

✓ Vendor can signup and login through real API

✓ JWT authentication works through real routes

✓ User can create booking through postToBookingsU

✓ Vendor acting as customer can create booking through postToBookingsV

✓ Booking ID is obtained through getOrdersU/getOrdersV

✓ orderCompletedU represents User acting as customer

✓ orderCompletedV represents Vendor acting as customer

✓ cancelOrderU represents User acting as customer

✓ cancelOrderV represents Vendor acting as customer

✓ Customer uses pending/completed/canceled

✓ Vendor acting as customer ALSO uses pending/completed/canceled

✓ Service provider uses pendingVendor/completedVendor/canceledVendor

✓ Customer referral eligibility uses entity.completed

✓ Provider referral eligibility uses entity.completedVendor

✓ Customer below threshold = 0% customer referral reward

✓ Provider below threshold = 0% provider referral reward

✓ Customer eligible = commission × 5%

✓ Provider eligible = commission × 5%

✓ Both eligible = commission × 10% total

✓ Same referrer receives both independent 5% rewards

✓ User can refer User

✓ User can refer Vendor

✓ Vendor can refer User

✓ Vendor can refer Vendor

✓ entity.cd resolves the shareBy account type

✓ Referral reward credits earning

✓ Referral reward does NOT automatically credit balance

✓ pendingShareBy increments when booking is created

✓ completedShareBy increments on successful completion

✓ canceledShareBy increments on cancellation

✓ pendingShareBy is consumed on terminal transition

✓ Cancellation creates zero referral earning

✓ Duplicate completion cannot pay twice

✓ Duplicate cancellation cannot mutate counters twice

✓ Concurrent completion mutates accounting once

✓ Concurrent completion pays referral once

✓ Concurrent cancellation mutates accounting once

✓ Complete-vs-cancel race has exactly one winner

✓ Booking cannot become both completed and canceled
========================================
`);

    return;
  }

  console.log(`
========================================
FAIL: ${failed} BOOKING LIFECYCLE INVARIANT(S) FAILED
========================================

Do NOT treat the booking lifecycle as production-ready
until every failed invariant is understood and fixed.
========================================
`);
}

/*
 * =========================================================
 * MAIN
 * =========================================================
 */

async function main() {
  section("FULL BOOKING LIFECYCLE INVARIANT TEST");

  console.log({
    api: typeof API_BASE_URL !== "undefined" ? API_BASE_URL : "configured in Part 1",

    nodeEnv: process.env.NODE_ENV || null,

    referralRate: "5% per eligible side",

    maximumReferral: "10% when both sides eligible",
  });

  assertSafeEnvironment();

  /*
   * Use the same MongoDB connection configuration
   * defined in Part 1.
   *
   * If Part 1 already exposes connectDB(), use it.
   */

  if (typeof connectDB === "function") {
    await connectDB();
  } else {
    /*
     * Fallback when Part 1 only defines MONGODB_URL_1.
     */

    const uri =
      typeof MONGODB_URL_1 !== "undefined"
        ? MONGODB_URL_1
        : process.env.MONGODB_URL_1 || process.env.MONGODB_URI || process.env.DB_URI;

    if (!uri) {
      throw new Error("MongoDB URI is missing.");
    }

    await mongoose.connect(uri);

    console.log("MongoDB connected.");
  }

  /*
   * =========================================================
   * UNIFIED LIFECYCLE SCENARIO ADAPTER
   * =========================================================
   *
   * The scenario matrices call runLifecycleScenario().
   *
   * Completion and cancellation are implemented separately by:
   *
   *   runCompletionScenario()
   *   runCancellationScenario()
   *
   * This adapter routes each matrix scenario to the correct
   * implementation.
   */

  /*
   * -------------------------------------------------------
   * PHASE 1
   *
   * Normal booking lifecycle.
   * -------------------------------------------------------
   */

  await runStandardScenarioMatrix();

  /*
   * -------------------------------------------------------
   * PHASE 2
   *
   * Explicit shareBy model combinations.
   * -------------------------------------------------------
   */

  await runReferrerModelMatrix();

  /*
   * -------------------------------------------------------
   * PHASE 3
   *
   * Critical threshold boundary.
   * -------------------------------------------------------
   */

  await runThresholdBoundaryMatrix();

  /*
   * -------------------------------------------------------
   * PHASE 4
   *
   * Concurrent terminal requests.
   * -------------------------------------------------------
   */

  await runConcurrencyMatrix();

  /*
   * -------------------------------------------------------
   * PHASE 5
   *
   * Complete vs cancel race.
   * -------------------------------------------------------
   */

  await runTerminalRaceMatrix();
}

/*
 * =========================================================
 * EXECUTION
 * =========================================================
 */

(async () => {
  let crashed = false;

  try {
    await main();
  } catch (error) {
    crashed = true;

    section("TEST CRASHED");

    console.error(error?.stack || error);
  } finally {
    /*
     * Always attempt cleanup.
     */

    try {
      if (mongoose.connection.readyState === 1) {
        await cleanup();
      }
    } catch (cleanupError) {
      console.error("Final cleanup error:", cleanupError);
    }

    printFinalReport(crashed);

    try {
      if (mongoose.connection.readyState !== 0) {
        await mongoose.disconnect();

        console.log("MongoDB disconnected.");
      }
    } catch (disconnectError) {
      console.error("MongoDB disconnect error:", disconnectError);
    }

    /*
     * CI / shell exit code:
     *
     * 0 = everything passed
     * 1 = crash or invariant failure
     */

    if (crashed || failed > 0) {
      process.exitCode = 1;
    } else {
      process.exitCode = 0;
    }
  }
})();
