/**
 * ============================================================
 * WEBSITE / APP MAINTENANCE STATUS ENGINE
 * ============================================================
 */

const parseTime = (value) => {
  const [hours = 0, minutes = 0] = String(value || "00:00")
    .split(":")
    .map(Number);

  return {
    hours: Number.isFinite(hours) ? hours : 0,
    minutes: Number.isFinite(minutes) ? minutes : 0,
  };
};

const getRecurringMaintenanceRange = (settings, now) => {
  const startDay = Number(settings.startDay);
  const endDay = Number(settings.endDay);

  if (!Number.isInteger(startDay) || !Number.isInteger(endDay)) {
    return null;
  }

  const { hours: startHours, minutes: startMinutes } = parseTime(settings.startTime);

  const { hours: endHours, minutes: endMinutes } = parseTime(settings.endTime);

  const current = new Date(now);

  const start = new Date(current);

  const daysSinceStart = (current.getDay() - startDay + 7) % 7;

  start.setDate(current.getDate() - daysSinceStart);
  start.setHours(startHours, startMinutes, 0, 0);

  // If this week's occurrence has not happened yet,
  // use the previous week's start.
  if (start > current) {
    start.setDate(start.getDate() - 7);
  }

  const end = new Date(start);

  const dayDifference = (endDay - startDay + 7) % 7;

  end.setDate(start.getDate() + dayDifference);

  end.setHours(endHours, endMinutes, 0, 0);

  // Same day but end time before/equal start time.
  if (end <= start) {
    end.setDate(end.getDate() + 7);
  }

  return {
    start,
    end,
  };
};

/**
 * Determine whether maintenance applies to platform.
 */
const isPlatformEnabled = (settings, platform = "website") => {
  const normalized = String(platform).trim().toLowerCase();

  if (normalized === "website") {
    return settings.showOnWebsite !== false;
  }

  if (normalized === "android") {
    return settings.showOnAndroid !== false;
  }

  if (normalized === "ios") {
    return settings.showOnIOS !== false;
  }

  return false;
};

/**
 * ============================================================
 * MAIN STATUS FUNCTION
 * ============================================================
 */

const getMaintenanceStatus = (settings, now = new Date(), platform = "website") => {
  const response = {
    status: "inactive",

    active: false,

    upcoming: false,

    showBanner: false,

    showMaintenancePage: false,

    startDateTime: null,

    endDateTime: null,

    notificationStartTime: null,
  };

  if (!settings) {
    return response;
  }

  if (!isPlatformEnabled(settings, platform)) {
    return response;
  }

  /**
   * Master OFF always disables maintenance.
   */
  if (settings.mode === "off") {
    return response;
  }

  /**
   * Master ON immediately activates maintenance.
   */
  if (settings.mode === "on") {
    response.status = "active";
    response.active = true;
    response.showMaintenancePage = settings.fullPageEnabled !== false;

    return response;
  }

  /**
   * AUTO mode
   */
  if (settings.mode !== "auto") {
    return response;
  }

  let startDateTime = null;
  let endDateTime = null;

  /**
   * SPECIFIC SCHEDULED MAINTENANCE
   */
  if (settings.maintenanceType === "scheduled" && settings.startDateTime && settings.endDateTime) {
    startDateTime = new Date(settings.startDateTime);

    endDateTime = new Date(settings.endDateTime);
  }

  /**
   * RECURRING MAINTENANCE
   */
  else if (settings.maintenanceType === "recurring" && settings.scheduleEnabled) {
    const range = getRecurringMaintenanceRange(settings, now);

    if (range) {
      startDateTime = range.start;
      endDateTime = range.end;
    }
  }

  if (
    !startDateTime ||
    !endDateTime ||
    Number.isNaN(startDateTime.getTime()) ||
    Number.isNaN(endDateTime.getTime())
  ) {
    return response;
  }

  response.startDateTime = startDateTime;
  response.endDateTime = endDateTime;

  /**
   * Maintenance is currently active.
   */
  if (now >= startDateTime && now < endDateTime) {
    response.status = "active";

    response.active = true;

    response.showMaintenancePage = settings.fullPageEnabled !== false;

    return response;
  }

  /**
   * Maintenance already ended.
   */
  if (now >= endDateTime) {
    return response;
  }

  /**
   * Future maintenance notification.
   */
  const notifyBeforeMinutes = Math.max(0, Number(settings.notifyBeforeMinutes) || 0);

  const notificationStartTime = new Date(startDateTime.getTime() - notifyBeforeMinutes * 60 * 1000);

  response.notificationStartTime = notificationStartTime;

  if (
    settings.notificationEnabled !== false &&
    now >= notificationStartTime &&
    now < startDateTime
  ) {
    response.status = "upcoming";

    response.upcoming = true;

    response.showBanner = true;
  }

  return response;
};

/**
 * Legacy helper compatibility.
 */
const isMaintenanceActive = (settings, now = new Date(), platform = "website") => {
  return getMaintenanceStatus(settings, now, platform).active;
};

module.exports = {
  getMaintenanceStatus,
  isMaintenanceActive,
};
