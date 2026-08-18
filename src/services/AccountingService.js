const User = require("../../models/user");
const Vendor = require("../../models/vendor");

const { calculateDiscountFactor } = require("../utils/discount");

async function debitUserBooking(userId, session = null) {
  const user = await User.findById(userId)
    .select(" balance totalDiscount transactionCount")
    .session(session);

  if (!user) throw new Error("User not found");

  if (user.balance < 10) throw new Error("Insufficient balance");

  const factor = calculateDiscountFactor(user.totalDiscount, user.transactionCount);

  const balance = -10 * factor;

  return User.findByIdAndUpdate(
    userId,

    {
      $inc: {
        balance: balance,

        bookingCount: 1,

        pending: 1,
      },
    },

    {
      new: true,

      session,
    },
  );
}

async function debitVendorCommission(vendorId, session = null) {
  const vendor = await Vendor.findById(vendorId)
    .select("balance commission totalDiscount transactionCount")
    .session(session);

  if (!vendor) throw new Error("Vendor not found");

  if (vendor.balance < vendor.commission) throw new Error("Vendor balance too low");

  const factor = calculateDiscountFactor(vendor.totalDiscount, vendor.transactionCount);

  const amount = vendor.commission * factor;

  return Vendor.findByIdAndUpdate(
    vendorId,

    {
      $inc: {
        balance: -amount,

        pendingVendor: 1,

        bookingCountVendor: 1,
      },
    },

    {
      new: true,

      session,
    },
  );
}

async function cancelUserBooking(userId, session = null) {
  return User.findByIdAndUpdate(
    userId,

    {
      $inc: {

        pending: -1,

        canceled: 1,
      },
    },

    {
      new: true,

      session,
    },
  );
}

async function cancelVendorBooking(vendorId, session = null) {
  return Vendor.findByIdAndUpdate(
    vendorId,

    {
      $inc: {
        pendingVendor: -1,

        canceledVendor: 1,
      },
    },

    {
      new: true,

      session,
    },
  );
}

async function completeUserBooking(userId, session = null) {
  return User.findByIdAndUpdate(
    userId,

    {
      $inc: {
        pending: -1,

        completed: 1,
      },
    },

    {
      new: true,

      session,
    },
  );
}

async function completeVendorBooking(vendorId, session = null) {
  return Vendor.findByIdAndUpdate(
    vendorId,

    {
      $inc: {
        pendingVendor: -1,

        completedVendor: 1,
      },
    },

    {
      new: true,

      session,
    },
  );
}

module.exports = {
  debitUserBooking,

  debitVendorCommission,

  cancelUserBooking,

  cancelVendorBooking,

  completeUserBooking,

  completeVendorBooking,
};
