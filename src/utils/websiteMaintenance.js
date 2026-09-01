function timeToMinutes(time) {
  const [hours, minutes] = String(time).split(":").map(Number);

  return hours * 60 + minutes;
}

function isMaintenanceActive(settings, now = new Date()) {
  if (!settings) {
    return false;
  }

  // Manual ON
  if (settings.mode === "on") {
    return true;
  }

  // Manual OFF
  if (settings.mode === "off") {
    return false;
  }

  // AUTO
  if (!settings.scheduleEnabled) {
    return false;
  }

  const day = now.getDay();

  const currentMinutes = now.getHours() * 60 + now.getMinutes();

  const startDay = Number(settings.startDay);
  const endDay = Number(settings.endDay);

  const startMinutes = timeToMinutes(settings.startTime);

  const endMinutes = timeToMinutes(settings.endTime);

  // Same-day schedule
  if (startDay === endDay) {
    return day === startDay && currentMinutes >= startMinutes && currentMinutes < endMinutes;
  }

  // Schedule crosses midnight
  if (day === startDay) {
    return currentMinutes >= startMinutes;
  }

  if (day === endDay) {
    return currentMinutes < endMinutes;
  }

  return false;
}

module.exports = {
  isMaintenanceActive,
};
