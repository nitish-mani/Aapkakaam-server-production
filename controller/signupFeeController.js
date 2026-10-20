const SignupFeeConfig = require("../models/signupFeeConfig");

async function getOrCreateSignupFeeConfig() {
  return SignupFeeConfig.findOneAndUpdate(
    { key: "signup-fees" },
    {
      $setOnInsert: {
        key: "signup-fees",
        userAmountPaise: 0,
        vendorAmountPaise: 5000,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
}

exports.getPublicSignupFees = async (req, res) => {
  try {
    const config = await getOrCreateSignupFeeConfig();

    return res.json({
      success: true,
      fees: {
        user: {
          amountPaise: config.userAmountPaise,
          amountRupees: config.userAmountPaise / 100,
          isFree: config.userAmountPaise === 0,
        },
        vendor: {
          amountPaise: config.vendorAmountPaise,
          amountRupees: config.vendorAmountPaise / 100,
          isFree: config.vendorAmountPaise === 0,
        },
      },
    });
  } catch (error) {
    console.error("Get signup fees error:", error);
    return res.status(500).json({
      success: false,
      message: "Unable to fetch signup fees",
    });
  }
};

exports.getAdminSignupFees = async (req, res) => {
  return exports.getPublicSignupFees(req, res);
};

exports.updateAdminSignupFees = async (req, res) => {
  try {
    const { userAmountRupees, vendorAmountRupees } = req.body;

    const validAmount = (amount) =>
      typeof amount === "number" &&
      Number.isFinite(amount) &&
      amount >= 0 &&
      amount <= 100000 &&
      Number.isInteger(amount * 100);

    if (!validAmount(userAmountRupees) || !validAmount(vendorAmountRupees)) {
      return res.status(400).json({
        success: false,
        message: "Amounts must be valid non-negative rupee amounts",
      });
    }

    const config = await SignupFeeConfig.findOneAndUpdate(
      { key: "signup-fees" },
      {
        $set: {
          userAmountPaise: Math.round(userAmountRupees * 100),
          vendorAmountPaise: Math.round(vendorAmountRupees * 100),
          updatedBy: req.adminId || null,
        },
        $setOnInsert: { key: "signup-fees" },
      },
      { new: true, upsert: true, runValidators: true },
    );

    return res.json({
      success: true,
      message: "Signup fees updated successfully",
      fees: {
        userAmountRupees: config.userAmountPaise / 100,
        vendorAmountRupees: config.vendorAmountPaise / 100,
      },
    });
  } catch (error) {
    console.error("Update signup fees error:", error);
    return res.status(500).json({
      success: false,
      message: "Unable to update signup fees",
    });
  }
};
