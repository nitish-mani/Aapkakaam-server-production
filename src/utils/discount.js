/**
 * Wallet-discount factor derived from a customer's historical discount rate.
 *
 * Given the running totals of past discounts and transactions, returns a
 * multiplier in [0, 1] that shrinks toward 0 as the average discount grows.
 */
exports.calculateDiscountFactor = (totalDiscount = 0, transactionCount = 0) => {
  if (transactionCount <= 0) return 1;

  const averageDiscount = (totalDiscount / transactionCount) * 0.01;
  return 1 - averageDiscount;
};
