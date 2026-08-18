/**
 * Centralized date utilities for AapkaKaam
 *
 * Business Timezone: Asia/Kolkata (IST)
 *
 * The application works with calendar dates only.
 * Time is intentionally ignored.
 */

/**
 * Normalize a date to the start of the local business day (IST).
 *
 * @param {Date|string|number} value
 * @returns {Date|null}
 */
function normalizeDateIST(value) {
  if (!value) return null;

  const date = new Date(value);

  if (isNaN(date.getTime())) {
    return null;
  }

  date.setHours(0, 0, 0, 0);

  return date;
}

/**
 * Validate and normalize a date range.
 *
 * @param {Date|string} from
 * @param {Date|string} to
 * @returns {{valid:boolean, from?:Date, to?:Date, message?:string}}
 */
function validateDateRange(from, to) {
  const fromDate = normalizeDateIST(from);
  const toDate = normalizeDateIST(to);

  if (!fromDate) {
    return {
      valid: false,
      message: "Invalid 'from' date",
    };
  }

  if (!toDate) {
    return {
      valid: false,
      message: "Invalid 'to' date",
    };
  }

  if (toDate < fromDate) {
    return {
      valid: false,
      message: "'to' date cannot be before 'from' date",
    };
  }

  return {
    valid: true,
    from: fromDate,
    to: toDate,
  };
}

/**
 * Today's business date (IST)
 */
function getTodayIST() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return today;
}

/**
 * Inclusive date-range check.
 */
function isDateInRange(date, from, to) {
  const target = normalizeDateIST(date);
  const start = normalizeDateIST(from);
  const end = normalizeDateIST(to);

  if (!target || !start || !end) {
    return false;
  }

  return target >= start && target <= end;
}

/**
 * Check whether two leave ranges overlap.
 */
function rangesOverlap(range1, range2) {
  const from1 = normalizeDateIST(range1.from);
  const to1 = normalizeDateIST(range1.to);

  const from2 = normalizeDateIST(range2.from);
  const to2 = normalizeDateIST(range2.to);

  if (!from1 || !to1 || !from2 || !to2) {
    return false;
  }

  return from1 <= to2 && from2 <= to1;
}

/**
 * Leave status.
 */
function classifyLeave(leave) {
  const today = getTodayIST();

  const from = normalizeDateIST(leave.from);
  const to = normalizeDateIST(leave.to);

  if (!from || !to) {
    return "past";
  }

  if (to < today) {
    return "past";
  }

  if (from > today) {
    return "future";
  }

  return "current";
}

/**
 * Format date for Indian users.
 */
function formatDateDisplay(date) {
  const d = normalizeDateIST(date);

  if (!d) {
    return "";
  }

  return d.toLocaleDateString("en-IN", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

module.exports = {
  normalizeDateIST,
  validateDateRange,
  getTodayIST,
  isDateInRange,
  rangesOverlap,
  classifyLeave,
  formatDateDisplay,
};
