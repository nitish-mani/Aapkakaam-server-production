/**
 * Shared Mock Services
 * Centralized mocks for all external dependencies
 */

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  child: jest.fn(() => mockLogger),
};

const mockWalletService = {
  credit: jest.fn(),
  debit: jest.fn(),
  getBalance: jest.fn(),
  getTransactions: jest.fn(),
};

const mockNotificationService = {
  sendPaymentConfirmation: jest.fn(),
  sendPaymentFailed: jest.fn(),
  sendEmail: jest.fn(),
  sendSMS: jest.fn(),
};

const mockTransactionModel = {
  findOne: jest.fn(),
  findOneAndUpdate: jest.fn(),
  findById: jest.fn(),
  create: jest.fn(),
  updateOne: jest.fn(),
  updateMany: jest.fn(),
  deleteOne: jest.fn(),
  deleteMany: jest.fn(),
  countDocuments: jest.fn(),
  aggregate: jest.fn(),
  startSession: jest.fn(),
};

const mockUserModel = {
  findById: jest.fn(),
  findOne: jest.fn(),
  updateOne: jest.fn(),
  create: jest.fn(),
  find: jest.fn(),
};

const mockVendorModel = {
  findById: jest.fn(),
  findOne: jest.fn(),
  updateOne: jest.fn(),
  create: jest.fn(),
  find: jest.fn(),
};

const mockRazorpay = {
  payments: {
    fetch: jest.fn(),
    create: jest.fn(),
    capture: jest.fn(),
    refund: jest.fn(),
  },
  orders: {
    create: jest.fn(),
    fetch: jest.fn(),
  },
};

const mockMongoose = {
  startSession: jest.fn(),
  connection: {
    readyState: 1,
  },
  Types: {
    ObjectId: jest.fn(),
  },
};

function setupMockResponses() {
  // Transaction model mock responses
  mockTransactionModel.findOne.mockImplementation(() => ({
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockReturnThis(),
    session: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue(null),
  }));

  mockTransactionModel.findOneAndUpdate.mockResolvedValue(null);
  mockTransactionModel.startSession.mockResolvedValue({
    withTransaction: async (fn) => fn(),
    endSession: jest.fn(),
  });

  // User model mock responses
  mockUserModel.findById.mockImplementation(() => ({
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue(null),
  }));

  // Vendor model mock responses
  mockVendorModel.findById.mockImplementation(() => ({
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue(null),
  }));

  // Razorpay mock responses
  mockRazorpay.payments.fetch.mockResolvedValue({
    id: "pay_1234567890",
    order_id: "order_1234567890",
    status: "captured",
    captured: true,
    amount: 50000,
    currency: "INR",
    method: "upi",
  });
}

function resetAllMocks() {
  jest.clearAllMocks();
  setupMockResponses();
}

function mockValidRazorpayResponse(overrides = {}) {
  const defaults = {
    id: "pay_1234567890",
    order_id: "order_1234567890",
    status: "captured",
    captured: true,
    amount: 50000,
    currency: "INR",
    method: "upi",
    created_at: Math.floor(Date.now() / 1000),
  };

  mockRazorpay.payments.fetch.mockResolvedValue({ ...defaults, ...overrides });
}

function mockFailedRazorpayResponse(error) {
  mockRazorpay.payments.fetch.mockRejectedValue(error || new Error("Razorpay API error"));
}

function mockWalletCreditSuccess(overrides = {}) {
  const defaults = {
    entity: {
      _id: "user_123",
      balance: 1500,
    },
    ledger: {
      _id: "ledger_123",
      operationId: "payment_order_123",
    },
  };

  mockWalletService.credit.mockResolvedValue({ ...defaults, ...overrides });
}

function mockWalletCreditFailure(error) {
  mockWalletService.credit.mockRejectedValue(error || new Error("Wallet credit failed"));
}

function mockTransactionUpdateSuccess(overrides = {}) {
  const defaults = {
    _id: "txn_123",
    status: "completed",
    razorpayOrderId: "order_1234567890",
    razorpayPaymentId: "pay_1234567890",
  };

  mockTransactionModel.findOneAndUpdate.mockResolvedValue({ ...defaults, ...overrides });
}

function mockTransactionUpdateFailure(error) {
  mockTransactionModel.findOneAndUpdate.mockRejectedValue(
    error || new Error("Database update failed"),
  );
}

function mockUserFound(user = null) {
  const mockUser = user || {
    _id: "507f1f77bcf86cd799439011",
    balance: 1000,
    totalDiscount: 0,
    transactionCount: 0,
    totalOriginalAmount: 0,
  };

  mockUserModel.findById.mockImplementation(() => ({
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(mockUser),
    exec: jest.fn().mockResolvedValue(mockUser),
  }));
}

function mockVendorFound(vendor = null) {
  const mockVendor = vendor || {
    _id: "507f1f77bcf86cd799439022",
    balance: 2000,
    totalDiscount: 0,
    transactionCount: 0,
    totalOriginalAmount: 0,
  };

  mockVendorModel.findById.mockImplementation(() => ({
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(mockVendor),
    exec: jest.fn().mockResolvedValue(mockVendor),
  }));
}

function mockMongoSession() {
  const session = {
    withTransaction: jest.fn().mockImplementation(async (fn) => {
      return await fn(session);
    }),
    endSession: jest.fn(),
    startTransaction: jest.fn(),
    commitTransaction: jest.fn(),
    abortTransaction: jest.fn(),
  };

  mockMongoose.startSession.mockResolvedValue(session);
  return session;
}

module.exports = {
  mockLogger,
  mockWalletService,
  mockNotificationService,
  mockTransactionModel,
  mockUserModel,
  mockVendorModel,
  mockRazorpay,
  mockMongoose,
  setupMockResponses,
  resetAllMocks,
  mockValidRazorpayResponse,
  mockFailedRazorpayResponse,
  mockWalletCreditSuccess,
  mockWalletCreditFailure,
  mockTransactionUpdateSuccess,
  mockTransactionUpdateFailure,
  mockUserFound,
  mockVendorFound,
  mockMongoSession,
};
