"use strict";

const mongoose = require("mongoose");
const VendorSearchEvent = require("../models/VendorSearchEvent");

const DEFAULT_DAYS = 30;
const MAX_DAYS = 365;
const MAX_LIMIT = 100;

function getDateRange(query) {
  const days = Math.min(Math.max(Number.parseInt(query.days, 10) || DEFAULT_DAYS, 1), MAX_DAYS);

  const end = query.endDate ? new Date(query.endDate) : new Date();

  if (Number.isNaN(end.getTime())) {
    const error = new Error("Invalid endDate");
    error.statusCode = 400;
    throw error;
  }

  end.setHours(23, 59, 59, 999);

  const start = query.startDate ? new Date(query.startDate) : new Date(end);

  if (query.startDate) {
    start.setHours(0, 0, 0, 0);
  } else {
    start.setDate(start.getDate() - days + 1);
    start.setHours(0, 0, 0, 0);
  }

  if (Number.isNaN(start.getTime()) || start > end) {
    const error = new Error("Invalid date range");
    error.statusCode = 400;
    throw error;
  }

  return { start, end };
}

function buildMatch(query, start, end) {
  const match = {
    createdAt: { $gte: start, $lte: end },
  };

  if (query.searchBy) {
    if (!["User", "Vendor"].includes(query.searchBy)) {
      const error = new Error("Invalid searchBy");
      error.statusCode = 400;
      throw error;
    }

    match.searchBy = query.searchBy;
  }

  if (query.type) match.type = query.type.trim();
  if (query.pincode) match.pincode = query.pincode.trim();

  if (query.platform) match.platform = query.platform.trim();

  if (query.cacheHit === "true") match.cacheHit = true;
  if (query.cacheHit === "false") match.cacheHit = false;

  return match;
}

const getVendorSearchAnalytics = async (req, res) => {
  try {
    const { start, end } = getDateRange(req.query);
    const match = buildMatch(req.query, start, end);

    const [
      summaryResult,
      dailyTrend,
      popularServices,
      popularPincodes,
      cacheStats,
      searchLogs,
      totalLogs,
      platforms,
    ] = await Promise.all([
      VendorSearchEvent.aggregate([
        { $match: match },
        {
          $group: {
            _id: null,
            totalSearches: { $sum: 1 },
            uniqueActors: {
              $addToSet: {
                type: "$searchBy",
                id: "$searchById",
              },
            },
            searchesWithResults: {
              $sum: {
                $cond: [{ $gt: ["$resultCount", 0] }, 1, 0],
              },
            },
            zeroResultSearches: {
              $sum: {
                $cond: [{ $eq: ["$resultCount", 0] }, 1, 0],
              },
            },
            totalResults: { $sum: "$resultCount" },
            totalCandidates: { $sum: "$candidateCount" },
            avgDurationMs: { $avg: "$durationMs" },
            selectedVendorSearches: {
              $sum: {
                $cond: [{ $ne: ["$selectedVendorId", null] }, 1, 0],
              },
            },
            searchesWithBooking: {
              $sum: {
                $cond: [{ $ne: ["$bookingId", null] }, 1, 0],
              },
            },
            userSearches: {
              $sum: {
                $cond: [{ $eq: ["$searchBy", "User"] }, 1, 0],
              },
            },
            vendorSearches: {
              $sum: {
                $cond: [{ $eq: ["$searchBy", "Vendor"] }, 1, 0],
              },
            },
          },
        },
        {
          $project: {
            _id: 0,
            totalSearches: 1,
            uniqueActors: { $size: "$uniqueActors" },
            searchesWithResults: 1,
            zeroResultSearches: 1,
            totalResults: 1,
            totalCandidates: 1,
            avgDurationMs: {
              $round: [{ $ifNull: ["$avgDurationMs", 0] }, 2],
            },
            selectedVendorSearches: 1,
            searchesWithBooking: 1,
            userSearches: 1,
            vendorSearches: 1,
          },
        },
      ]),

      VendorSearchEvent.aggregate([
        { $match: match },
        {
          $group: {
            _id: {
              $dateToString: {
                format: "%Y-%m-%d",
                date: "$createdAt",
                timezone: "Asia/Kolkata",
              },
            },
            searches: { $sum: 1 },
            zeroResults: {
              $sum: {
                $cond: [{ $eq: ["$resultCount", 0] }, 1, 0],
              },
            },
            bookings: {
              $sum: {
                $cond: [{ $ne: ["$bookingId", null] }, 1, 0],
              },
            },
          },
        },
        { $sort: { _id: 1 } },
        {
          $project: {
            _id: 0,
            date: "$_id",
            searches: 1,
            zeroResults: 1,
            bookings: 1,
          },
        },
      ]),

      VendorSearchEvent.aggregate([
        { $match: match },
        {
          $group: {
            _id: "$type",
            searches: { $sum: 1 },
            avgResults: { $avg: "$resultCount" },
            zeroResults: {
              $sum: {
                $cond: [{ $eq: ["$resultCount", 0] }, 1, 0],
              },
            },
            bookings: {
              $sum: {
                $cond: [{ $ne: ["$bookingId", null] }, 1, 0],
              },
            },
          },
        },
        { $sort: { searches: -1 } },
        { $limit: 10 },
        {
          $project: {
            _id: 0,
            service: "$_id",
            searches: 1,
            avgResults: { $round: ["$avgResults", 2] },
            zeroResults: 1,
            bookings: 1,
          },
        },
      ]),

      VendorSearchEvent.aggregate([
        { $match: match },
        {
          $group: {
            _id: "$pincode",
            searches: { $sum: 1 },
            zeroResults: {
              $sum: {
                $cond: [{ $eq: ["$resultCount", 0] }, 1, 0],
              },
            },
            avgResults: { $avg: "$resultCount" },
          },
        },
        { $sort: { searches: -1 } },
        { $limit: 10 },
        {
          $project: {
            _id: 0,
            pincode: "$_id",
            searches: 1,
            zeroResults: 1,
            avgResults: { $round: ["$avgResults", 2] },
          },
        },
      ]),

      VendorSearchEvent.aggregate([
        { $match: match },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            cacheHits: {
              $sum: {
                $cond: [{ $eq: ["$cacheHit", true] }, 1, 0],
              },
            },
            cacheMisses: {
              $sum: {
                $cond: [{ $eq: ["$cacheHit", false] }, 1, 0],
              },
            },
            unknown: {
              $sum: {
                $cond: [{ $eq: ["$cacheHit", null] }, 1, 0],
              },
            },
          },
        },
        {
          $project: {
            _id: 0,
            total: 1,
            cacheHits: 1,
            cacheMisses: 1,
            unknown: 1,
            hitRate: {
              $cond: [
                { $gt: [{ $add: ["$cacheHits", "$cacheMisses"] }, 0] },
                {
                  $multiply: [
                    {
                      $divide: ["$cacheHits", { $add: ["$cacheHits", "$cacheMisses"] }],
                    },
                    100,
                  ],
                },
                0,
              ],
            },
          },
        },
      ]),

      VendorSearchEvent.find(match)
        .sort({ createdAt: -1 })
        .skip(0)
        .limit(Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 20, 1), MAX_LIMIT))
        .select(
          "eventId searchBy searchById sessionId type pincode bookingDate minRating minWageRate page resultCount candidateCount cacheHit durationMs platform selectedVendorId bookingId createdAt",
        )
        .lean(),

      VendorSearchEvent.countDocuments(match),

      VendorSearchEvent.distinct("platform", match),
    ]);

    const page = Math.max(Number.parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 20, 1), MAX_LIMIT);

    // Apply requested pagination to logs.
    const paginatedLogs =
      page === 1
        ? searchLogs
        : await VendorSearchEvent.find(match)
            .sort({ createdAt: -1 })
            .skip((page - 1) * limit)
            .limit(limit)
            .select(
              "eventId searchBy searchById sessionId type pincode bookingDate minRating minWageRate page resultCount candidateCount cacheHit durationMs platform selectedVendorId bookingId createdAt",
            )
            .lean();

    const summary = summaryResult[0] || {
      totalSearches: 0,
      uniqueActors: 0,
      searchesWithResults: 0,
      zeroResultSearches: 0,
      totalResults: 0,
      totalCandidates: 0,
      avgDurationMs: 0,
      selectedVendorSearches: 0,
      searchesWithBooking: 0,
      userSearches: 0,
      vendorSearches: 0,
    };

    const cache = cacheStats[0] || {
      total: 0,
      cacheHits: 0,
      cacheMisses: 0,
      unknown: 0,
      hitRate: 0,
    };

    return res.status(200).json({
      success: true,
      filters: {
        startDate: start,
        endDate: end,
        searchBy: req.query.searchBy || null,
        type: req.query.type || null,
        pincode: req.query.pincode || null,
        platform: req.query.platform || null,
      },
      summary: {
        ...summary,
        resultRate: summary.totalSearches
          ? Number(((summary.searchesWithResults / summary.totalSearches) * 100).toFixed(2))
          : 0,
        zeroResultRate: summary.totalSearches
          ? Number(((summary.zeroResultSearches / summary.totalSearches) * 100).toFixed(2))
          : 0,
        vendorSelectionRate: summary.totalSearches
          ? Number(((summary.selectedVendorSearches / summary.totalSearches) * 100).toFixed(2))
          : 0,
        bookingRate: summary.totalSearches
          ? Number(((summary.searchesWithBooking / summary.totalSearches) * 100).toFixed(2))
          : 0,
      },
      cache,
      dailyTrend,
      popularServices,
      popularPincodes,
      platforms: platforms.filter(Boolean),
      logs: {
        data: paginatedLogs,
        page,
        limit,
        total: totalLogs,
        totalPages: Math.ceil(totalLogs / limit),
      },
    });
  } catch (error) {
    console.error("Vendor search analytics error:", error);

    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.statusCode === 400 ? error.message : "Failed to fetch vendor search analytics",
    });
  }
};

module.exports = { getVendorSearchAnalytics };
