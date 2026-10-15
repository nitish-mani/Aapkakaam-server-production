const { randomUUID } = require("node:crypto");
const VendorSearchOutbox = require("../../models/VendorSearchOutbox");

class VendorSearchAnalyticsService {
  static async recordSearch(data) {
    const event = {
      eventId: randomUUID(),
      eventType: "VENDOR_SEARCHED",

      searchBy: data.searchBy,
      searchById: data.searchById,
      sessionId: data.sessionId || null,

      type: data.type,
      pincode: data.pincode,
      bookingDate: data.bookingDate,

      minRating: data.minRating ?? 0,
      minWageRate: data.minWageRate ?? 0,
      page: data.page ?? 1,

      resultCount: data.resultCount,
      candidateCount: data.candidateCount ?? 0,
      vendorIds: data.vendorIds || [],

      durationMs: data.durationMs,
      platform: data.platform || "unknown",

      status: "PENDING",
      availableAt: new Date(),
    };

    return VendorSearchOutbox.create(event);
  }
}

module.exports = VendorSearchAnalyticsService;
