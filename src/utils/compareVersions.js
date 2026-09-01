function normalize(version) {
  return String(version || "")
    .trim()
    .replace(/^v/i, "")
    .split("+")[0]
    .split("-")[0]
    .split(".")
    .map((part) => {
      const number = Number(part);
      return Number.isFinite(number) ? number : 0;
    });
}

/**
 * Returns:
 *  1  when a > b
 *  0  when a === b
 * -1  when a < b
 */
function compareVersions(a, b) {
  const left = normalize(a);
  const right = normalize(b);
  const length = Math.max(left.length, right.length);

  for (let i = 0; i < length; i += 1) {
    const x = left[i] || 0;
    const y = right[i] || 0;

    if (x > y) return 1;
    if (x < y) return -1;
  }

  return 0;
}

module.exports = {
  compareVersions,
};
