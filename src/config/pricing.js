const VENDOR_PRICING = {
  100: { original: 100, final: 100 },
  500: { original: 500, final: 475 },
  1000: { original: 1000, final: 900 },
  1500: { original: 1500, final: 1270 },
  2000: { original: 2000, final: 1600 },
  5000: { original: 5000, final: 3500 },
  10000: { original: 10000, final: 6000 },
  20000: { original: 20000, final: 10000 },
};

const USER_PRICING = {};

for (const [amount, pricing] of Object.entries(VENDOR_PRICING)) {
  USER_PRICING[Number(amount) / 10] = {
    original: pricing.original / 10,
    final: pricing.final / 10,
  };
}

function getPricing(amount, category = "user") {
  const table = category === "vendor"
    ? VENDOR_PRICING
    : USER_PRICING;

  const rechargeAmount = Number(amount);

  if (!Number.isFinite(rechargeAmount) || rechargeAmount <= 0) {
    throw new Error("Recharge amount must be a valid positive number");
  }

  const pricing = table[rechargeAmount];

  if (!pricing) {
    throw new Error(
      `Invalid recharge amount: ${rechargeAmount}. Allowed amounts: ${Object.keys(table).join(", ")}`
    );
  }

  const discount = Number(
    (pricing.original - pricing.final).toFixed(2)
  );

  const discountPercent = Number(
    ((discount / pricing.original) * 100).toFixed(2)
  );

  return {
    originalAmount: pricing.original,
    payableAmount: pricing.final,
    discount,
    discountPercent,
    category,
  };
}

module.exports = {
  VENDOR_PRICING,
  USER_PRICING,
  getPricing,
};