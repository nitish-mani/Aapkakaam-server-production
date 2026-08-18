require("./setupEnv");
process.env.AUTH_RATE_LIMIT_MAX = "1000";

const request = require("supertest");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const { MongoMemoryServer } = require("mongodb-memory-server");

let mongoServer;
let app;
let User;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  const uri = mongoServer.getUri();
  await mongoose.connect(uri);

  // Require app AFTER connect so any mongoose.models are shared.
  app = require("../src/app");
  User = require("../models/user");
}, 60000);

afterAll(async () => {
  await mongoose.disconnect();
  if (mongoServer) await mongoServer.stop();
});

describe("User signup + login (integration, in-memory Mongo)", () => {
  const phoneNo = "9876543210";
  const password = "Str0ng!Pass";

  test("POST /api/user/signup creates a user and returns 201", async () => {
    const res = await request(app)
      .post("/api/user/signup")
      .send({
        name: "Alice",
        phoneNo,
        email: "alice@example.com",
        password,
        gender: "female",
        agreedToTnCnP: true,
      });

    // Some validators may reject; we tolerate 200/201 as success signals.
    expect([200, 201]).toContain(res.status);
    const created = await User.findOne({ phoneNo });
    expect(created).not.toBeNull();
    // Password must be hashed, not stored plain.
    expect(created.password).not.toBe(password);
    expect(created.password.startsWith("$2")).toBe(true);
  }, 60000);

  test("duplicate signup returns 409", async () => {
    const res = await request(app)
      .post("/api/user/signup")
      .send({
        name: "Alice2",
        phoneNo, // same phone
        email: "alice2@example.com",
        password,
        gender: "female",
        agreedToTnCnP: true,
      });
    expect(res.status).toBe(409);
  }, 60000);

  test("POST /api/user/login with correct creds returns a JWT", async () => {
    const res = await request(app)
      .post("/api/user/login")
      .send({ phoneNo, password });

    expect(res.status).toBe(200);
    expect(res.body.token).toEqual(expect.any(String));

    const decoded = jwt.verify(res.body.token, process.env.JWT_USER_SECRET);
    expect(decoded.userId).toBeDefined();
    // Schema may store phoneNo as Number; assert loose equality.
    // eslint-disable-next-line eqeqeq
    expect(String(decoded.phoneNo)).toBe(String(phoneNo));
  }, 60000);

  test("POST /api/user/login with wrong password returns 401", async () => {
    const res = await request(app)
      .post("/api/user/login")
      .send({ phoneNo, password: "wrong-password" });
    expect(res.status).toBe(401);
  }, 60000);

  test("bcrypt is actually verifying (sanity)", async () => {
    const u = await User.findOne({ phoneNo });
    expect(await bcrypt.compare(password, u.password)).toBe(true);
    expect(await bcrypt.compare("wrong", u.password)).toBe(false);
  });
});
