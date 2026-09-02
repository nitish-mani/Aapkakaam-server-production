// ============================================================
// controller/systemController.js
// ============================================================

const si = require("systeminformation");
const mongoose = require("mongoose");
const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

// ============================================================
// CONFIGURATION
// ============================================================

const METRICS_HISTORY_LIMIT = 120;

const ALLOWED_PM2_PROCESSES = [
  "aapkakaam-api",
  "aapkakaam-worker",
];

const systemMetricsHistory = [];

// ============================================================
// HELPERS
// ============================================================

const formatBytes = (bytes = 0) => {
  const value = Number(bytes) || 0;

  if (value <= 0) {
    return "0 B";
  }

  const sizes = [
    "B",
    "KB",
    "MB",
    "GB",
    "TB",
  ];

  const index = Math.min(
    Math.floor(
      Math.log(value) /
        Math.log(1024),
    ),
    sizes.length - 1,
  );

  const size =
    value /
    Math.pow(1024, index);

  return `${size.toFixed(
    index === 0 ? 0 : 2,
  )} ${sizes[index]}`;
};

const formatUptime = (
  seconds = 0,
) => {
  const value =
    Math.floor(
      Number(seconds) || 0,
    );

  const days =
    Math.floor(
      value / 86400,
    );

  const hours =
    Math.floor(
      (value % 86400) / 3600,
    );

  const minutes =
    Math.floor(
      (value % 3600) / 60,
    );

  const parts = [];

  if (days > 0) {
    parts.push(`${days}d`);
  }

  if (hours > 0) {
    parts.push(`${hours}h`);
  }

  parts.push(`${minutes}m`);

  return parts.join(" ");
};

const readLogPreview = async (
  filePath,
  maxLines = 150,
  maxBytes = 256 * 1024,
) => {
  try {
    const stats =
      await fs.stat(filePath);

    if (stats.size <= 0) {
      return "";
    }

    const start =
      Math.max(
        0,
        stats.size - maxBytes,
      );

    const length =
      stats.size - start;

    const handle =
      await fs.open(
        filePath,
        "r",
      );

    try {
      const buffer =
        Buffer.alloc(length);

      await handle.read(
        buffer,
        0,
        length,
        start,
      );

      const content =
        buffer.toString("utf8");

      const lines =
        content
          .split(/\r?\n/)
          .filter(
            (line) =>
              line.trim().length > 0,
          );

      return lines
        .slice(-maxLines)
        .join("\n");
    } finally {
      await handle.close();
    }
  } catch (error) {
    return "";
  }
};

const parseMeminfo = async () => {
  try {
    const content = await fs.readFile("/proc/meminfo", "utf8");
    const meminfo = {};

    content.split("\n").forEach((line) => {
      const parts = line.split(":");
      if (parts.length === 2) {
        const key = parts[0].trim();
        const value = parts[1].trim().replace(/ kB$/, "").trim();
        meminfo[key] = parseInt(value, 10) * 1024;
      }
    });

    return meminfo;
  } catch (error) {
    return null;
  }
};

const getMemoryInfo = async () => {
  const meminfo = await parseMeminfo();

  if (meminfo && meminfo.MemTotal && meminfo.MemAvailable) {
    const total = meminfo.MemTotal;
    const available = meminfo.MemAvailable;
    const free = meminfo.MemFree || 0;
    const cached = meminfo.Cached || 0;
    const buffers = meminfo.Buffers || 0;
    const actualUsed = total - available;
    const rawUsed = total - free;
    const usagePercentage = total > 0 ? (actualUsed / total) * 100 : 0;

    return {
      total,
      used: actualUsed,
      actualUsed,
      available,
      free,
      rawUsed,
      cached: cached + buffers,
      percentage: Number(usagePercentage.toFixed(2)),
      usagePercentage: Number(usagePercentage.toFixed(2)),
      totalFormatted: formatBytes(total),
      usedFormatted: formatBytes(actualUsed),
      actualUsedFormatted: formatBytes(actualUsed),
      availableFormatted: formatBytes(available),
      freeFormatted: formatBytes(free),
      rawUsedFormatted: formatBytes(rawUsed),
      cachedFormatted: formatBytes(cached + buffers),
    };
  }

  const memory = await si.mem();
  const total = memory.total || 0;
  const available = memory.available || 0;
  const free = memory.free || 0;
  const cached = memory.cached || 0;
  const buffers = memory.buffers || 0;
  const actualUsed = total - available;
  const rawUsed = total - free;
  const usagePercentage = total > 0 ? (actualUsed / total) * 100 : 0;

  return {
    total,
    used: actualUsed,
    actualUsed,
    available,
    free,
    rawUsed,
    cached: cached + buffers,
    percentage: Number(usagePercentage.toFixed(2)),
    usagePercentage: Number(usagePercentage.toFixed(2)),
    totalFormatted: formatBytes(total),
    usedFormatted: formatBytes(actualUsed),
    actualUsedFormatted: formatBytes(actualUsed),
    availableFormatted: formatBytes(available),
    freeFormatted: formatBytes(free),
    rawUsedFormatted: formatBytes(rawUsed),
    cachedFormatted: formatBytes(cached + buffers),
  };
};

// ============================================================
// NETWORK INFORMATION - IMPROVED
// ============================================================

const getNetworkInfo = async () => {
  try {
    // Try to get network stats from systeminformation first
    const networkStats = await si.networkStats();
    
    // Find the primary active network interface
    let activeNetwork = networkStats.find(
      (network) =>
        network.iface ||
        network.iface !== "lo" &&
        network.iface !== "docker0" &&
        network.iface !== "br-" &&
        !network.iface.startsWith("veth") &&
        (network.rx_bytes > 0 || network.tx_bytes > 0)
    );

    // If no active network found, try to get the default interface via command
    if (!activeNetwork) {
      try {
        const { stdout } = await execFileAsync("ip", ["route", "show", "default"]);
        const match = stdout.match(/dev\s+(\S+)/);
        if (match) {
          const iface = match[1];
          const interfaceStats = networkStats.find((net) => net.iface === iface);
          if (interfaceStats) {
            activeNetwork = interfaceStats;
          }
        }
      } catch (cmdError) {
        console.error("Error getting default interface:", cmdError.message);
      }
    }

    // If still no active network, try using the first non-loopback interface
    if (!activeNetwork) {
      activeNetwork = networkStats.find(
        (network) =>
          network.iface &&
          network.iface !== "lo" &&
          !network.iface.startsWith("veth")
      ) || networkStats[0] || {};
    }

    // ============================================================
    // CRITICAL FIX: If systeminformation returns 0 traffic,
    // read the actual Linux network statistics directly.
    // ============================================================
    if (
      activeNetwork.iface &&
      Number(activeNetwork.rx_bytes || 0) === 0 &&
      Number(activeNetwork.tx_bytes || 0) === 0
    ) {
      try {
        const iface = activeNetwork.iface;

        const { stdout: rxOut } = await execFileAsync(
          "cat",
          [`/sys/class/net/${iface}/statistics/rx_bytes`]
        );

        const { stdout: txOut } = await execFileAsync(
          "cat",
          [`/sys/class/net/${iface}/statistics/tx_bytes`]
        );

        activeNetwork.rx_bytes =
          parseInt(rxOut.trim(), 10) || 0;

        activeNetwork.tx_bytes =
          parseInt(txOut.trim(), 10) || 0;

        console.log(
          `Network stats loaded from /sys/class/net/${iface}`
        );
        console.log(`RX: ${activeNetwork.rx_bytes} bytes`);
        console.log(`TX: ${activeNetwork.tx_bytes} bytes`);
      } catch (error) {
        console.error(
          "Network statistics fallback failed:",
          error.message
        );
      }
    }

    // Get network interfaces with IP addresses
    const networkInterfaces = os.networkInterfaces();
    let ipAddress = null;
    let macAddress = null;

    if (activeNetwork.iface && networkInterfaces[activeNetwork.iface]) {
      const interfaces = networkInterfaces[activeNetwork.iface];
      const ipv4 = interfaces.find(
        (iface) => iface.family === "IPv4" && !iface.internal
      );
      if (ipv4) {
        ipAddress = ipv4.address;
        macAddress = ipv4.mac;
      }
    }

    // If we couldn't get IP from the interface, try to get it from any interface
    if (!ipAddress) {
      for (const [iface, addresses] of Object.entries(networkInterfaces)) {
        const ipv4 = addresses.find(
          (addr) => addr.family === "IPv4" && !addr.internal
        );
        if (ipv4) {
          ipAddress = ipv4.address;
          macAddress = ipv4.mac;
          break;
        }
      }
    }

    return {
      available: true,
      interface: activeNetwork.iface || "N/A",
      ipAddress: ipAddress || "N/A",
      macAddress: macAddress || "N/A",
      receivedBytes: activeNetwork.rx_bytes || 0,
      transmittedBytes: activeNetwork.tx_bytes || 0,
      receivedFormatted: formatBytes(activeNetwork.rx_bytes || 0),
      transmittedFormatted: formatBytes(activeNetwork.tx_bytes || 0),
      speed: activeNetwork.speed || 0,
      operstate: activeNetwork.operstate || "unknown",
    };
  } catch (error) {
    console.error("Network stats error:", error.message);
    
    // Fallback: try to get network stats via /sys/class/net
    try {
      const { stdout: ifaceOut } = await execFileAsync("ip", ["route", "show", "default"]);
      const ifaceMatch = ifaceOut.match(/dev\s+(\S+)/);
      const iface = ifaceMatch ? ifaceMatch[1] : "ens160";

      let rxBytes = 0;
      let txBytes = 0;

      try {
        const { stdout: rxOut } = await execFileAsync("cat", [`/sys/class/net/${iface}/statistics/rx_bytes`]);
        rxBytes = parseInt(rxOut.trim(), 10) || 0;
      } catch (e) {}

      try {
        const { stdout: txOut } = await execFileAsync("cat", [`/sys/class/net/${iface}/statistics/tx_bytes`]);
        txBytes = parseInt(txOut.trim(), 10) || 0;
      } catch (e) {}

      // Get IP address
      const networkInterfaces = os.networkInterfaces();
      let ipAddress = null;
      if (networkInterfaces[iface]) {
        const ipv4 = networkInterfaces[iface].find(
          (addr) => addr.family === "IPv4" && !addr.internal
        );
        if (ipv4) ipAddress = ipv4.address;
      }

      return {
        available: true,
        interface: iface,
        ipAddress: ipAddress || "N/A",
        macAddress: "N/A",
        receivedBytes: rxBytes,
        transmittedBytes: txBytes,
        receivedFormatted: formatBytes(rxBytes),
        transmittedFormatted: formatBytes(txBytes),
        speed: 0,
        operstate: "unknown",
      };
    } catch (fallbackError) {
      console.error("Network fallback error:", fallbackError.message);
      return {
        available: false,
        interface: "N/A",
        ipAddress: "N/A",
        macAddress: "N/A",
        receivedBytes: 0,
        transmittedBytes: 0,
        receivedFormatted: "0 B",
        transmittedFormatted: "0 B",
        speed: 0,
        operstate: "unknown",
      };
    }
  }
};

// ============================================================
// METRICS HISTORY
// ============================================================

const addMetricToHistory = (
  metric,
) => {
  systemMetricsHistory.push(metric);

  if (
    systemMetricsHistory.length >
    METRICS_HISTORY_LIMIT
  ) {
    systemMetricsHistory.splice(
      0,
      systemMetricsHistory.length -
        METRICS_HISTORY_LIMIT,
    );
  }

  return [
    ...systemMetricsHistory,
  ];
};

// ============================================================
// MONGODB HEALTH
// ============================================================

const getMongoHealth = async () => {
  const states = {
    0: "disconnected",
    1: "connected",
    2: "connecting",
    3: "disconnecting",
  };

  const readyState =
    mongoose.connection.readyState;

  const result = {
    connected:
      readyState === 1,

    healthy: false,

    state:
      states[readyState] ||
      "unknown",

    host:
      mongoose.connection.host ||
      null,

    database:
      mongoose.connection.name ||
      null,

    latency: null,

    latencyMs: null,

    readyState,
  };

  if (
    readyState !== 1 ||
    !mongoose.connection.db
  ) {
    return result;
  }

  try {
    const start =
      process.hrtime.bigint();

    await mongoose.connection.db
      .admin()
      .ping();

    const end =
      process.hrtime.bigint();

    const latencyMs =
      Number(end - start) /
      1000000;

    result.latency =
      Number(
        latencyMs.toFixed(2),
      );

    result.latencyMs =
      result.latency;

    result.healthy = true;
  } catch (error) {
    result.error =
      error.message;

    result.healthy = false;
  }

  return result;
};

// ============================================================
// PM2 INFORMATION
// ============================================================

const getPm2Info = async () => {
  try {
    const {
      stdout,
    } = await execFileAsync(
      "pm2",
      [
        "jlist",
      ],
      {
        timeout: 15000,

        maxBuffer:
          20 * 1024 * 1024,
      },
    );

    const processes =
      JSON.parse(stdout);

    const formatProcess = (
      processData,
    ) => {
      const environment =
        processData.pm2_env || {};

      const monit =
        processData.monit || {};

      return {
        id:
          processData.pm_id,

        name:
          processData.name,

        pid:
          processData.pid,

        status:
          environment.status ||
          "unknown",

        mode:
          environment.exec_mode ||
          "unknown",

        cpu:
          Number(
            monit.cpu || 0,
          ),

        memory:
          Number(
            monit.memory || 0,
          ),

        memoryFormatted:
          formatBytes(
            monit.memory || 0,
          ),

        restarts:
          Number(
            environment.restart_time || 0,
          ),

        uptime:
          environment.pm_uptime
            ? Math.floor(
                (
                  Date.now() -
                  environment.pm_uptime
                ) / 1000,
              )
            : 0,

        uptimeFormatted:
          environment.pm_uptime
            ? formatUptime(
                Math.floor(
                  (
                    Date.now() -
                    environment.pm_uptime
                  ) / 1000,
                ),
              )
            : "0m",

        createdAt:
          environment.created_at
            ? new Date(
                environment.created_at,
              ).toISOString()
            : null,
      };
    };

    const formattedProcesses =
      processes.map(
        formatProcess,
      );

    const apiProcesses =
      formattedProcesses.filter(
        (processData) =>
          processData.name ===
          "aapkakaam-api",
      );

    const workerProcesses =
      formattedProcesses.filter(
        (processData) =>
          processData.name ===
          "aapkakaam-worker",
      );

    const calculateGroup = (
      items,
    ) => ({
      instances:
        items.length,

      online:
        items.filter(
          (item) =>
            item.status ===
            "online",
        ).length,

      totalMemory:
        items.reduce(
          (total, item) =>
            total +
            item.memory,
          0,
        ),

      totalMemoryFormatted:
        formatBytes(
          items.reduce(
            (
              total,
              item,
            ) =>
              total +
              item.memory,
            0,
          ),
        ),

      totalCpu:
        Number(
          items
            .reduce(
              (
                total,
                item,
              ) =>
                total +
                item.cpu,
              0,
            )
            .toFixed(2),
        ),

      processes: items,
    });

    return {
      available: true,

      total:
        formattedProcesses.length,

      online:
        formattedProcesses.filter(
          (processData) =>
            processData.status ===
            "online",
        ).length,

      stopped:
        formattedProcesses.filter(
          (processData) =>
            processData.status ===
            "stopped",
        ).length,

      errored:
        formattedProcesses.filter(
          (processData) =>
            processData.status ===
            "errored",
        ).length,

      processes:
        formattedProcesses,

      api:
        calculateGroup(
          apiProcesses,
        ),

      worker:
        calculateGroup(
          workerProcesses,
        ),
    };
  } catch (error) {
    console.error(
      "PM2 information error:",
      error.message,
    );

    return {
      available: false,

      message:
        "Unable to retrieve PM2 information",

      processes: [],
    };
  }
};

// ============================================================
// LOG INFORMATION
// ============================================================

const scanLogDirectory = async (directory, sourceName) => {
  const result = {
    source: sourceName,
    directory,
    available: false,
    message: "",
    totalFiles: 0,
    totalSize: 0,
    totalSizeFormatted: "0 B",
    errorLogs: [],
    outputLogs: [],
    otherLogs: [],
    files: [],
  };

  try {
    await fs.access(directory);
    result.available = true;
    result.message = "Log directory accessible";
  } catch (error) {
    result.message = `Log directory not accessible: ${error.message}`;
    return result;
  }

  try {
    const entries = await fs.readdir(directory, {
      withFileTypes: true,
    });

    const logFiles = [];

    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }

      const isLog = entry.name.endsWith(".log");
      const isTxt = entry.name.endsWith(".txt");
      const isGz = entry.name.endsWith(".gz");

      if (!isLog && !isTxt && !isGz) {
        continue;
      }

      const filePath = path.join(directory, entry.name);

      try {
        const stats = await fs.stat(filePath);

        const isCompressed = isGz;
        const preview = isCompressed
          ? "Compressed log file."
          : await readLogPreview(filePath, 150);

        let type = "other";
        const lowerName = entry.name.toLowerCase();

        if (lowerName.includes("error") || lowerName.includes("err")) {
          type = "error";
        } else if (lowerName.includes("out") || lowerName.includes("access") || lowerName.includes("info")) {
          type = "output";
        }

        let processName = null;
        const match = entry.name.match(/^(.+)-(?:error|out)-\d+\.(?:log|txt)$/);
        if (match) {
          processName = match[1];
        }

        const fileData = {
          name: entry.name,
          source: sourceName,
          type,
          processName,
          path: filePath,
          size: stats.size,
          sizeFormatted: formatBytes(stats.size),
          modifiedAt: stats.mtime.toISOString(),
          preview,
          previewLines: preview.split(/\r?\n/).filter((line) => line.trim().length > 0).length,
          compressed: isCompressed,
        };

        logFiles.push(fileData);
      } catch (error) {
        console.error(`Unable to read log: ${entry.name}`, error.message);
      }
    }

    logFiles.sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt));

    const totalSize = logFiles.reduce((total, file) => total + file.size, 0);

    result.totalFiles = logFiles.length;
    result.totalSize = totalSize;
    result.totalSizeFormatted = formatBytes(totalSize);
    result.files = logFiles;

    result.errorLogs = logFiles.filter((file) => file.type === "error");
    result.outputLogs = logFiles.filter((file) => file.type === "output");
    result.otherLogs = logFiles.filter((file) => file.type === "other");

    result.available = true;
    result.message = `Found ${logFiles.length} log files`;
  } catch (error) {
    result.available = false;
    result.message = `Error scanning directory: ${error.message}`;
    console.error(`Error scanning ${directory}:`, error.message);
  }

  return result;
};

const getLogsInfo = async () => {
  try {
    const applicationLogsDirectory = path.resolve(process.cwd(), "logs");
    const pm2LogsDirectory = path.join(os.homedir(), ".pm2", "logs");

    const [applicationLogs, pm2Logs] = await Promise.all([
      scanLogDirectory(applicationLogsDirectory, "application"),
      scanLogDirectory(pm2LogsDirectory, "pm2"),
    ]);

    const allFiles = [...applicationLogs.files, ...pm2Logs.files];
    allFiles.sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt));

    const totalFiles = allFiles.length;
    const totalSize = allFiles.reduce((total, file) => total + file.size, 0);

    const response = {
      available: applicationLogs.available || pm2Logs.available,
      application: applicationLogs,
      pm2: pm2Logs,
      totalFiles,
      totalSize,
      totalSizeFormatted: formatBytes(totalSize),
      files: allFiles,
    };

    return response;
  } catch (error) {
    console.error("Log information error:", error.message);
    return {
      available: false,
      message: error.message,
      application: {
        source: "application",
        directory: path.resolve(process.cwd(), "logs"),
        available: false,
        message: "Log directory not accessible",
        totalFiles: 0,
        totalSize: 0,
        totalSizeFormatted: "0 B",
        errorLogs: [],
        outputLogs: [],
        otherLogs: [],
        files: [],
      },
      pm2: {
        source: "pm2",
        directory: path.join(os.homedir(), ".pm2", "logs"),
        available: false,
        message: "Log directory not accessible",
        totalFiles: 0,
        totalSize: 0,
        totalSizeFormatted: "0 B",
        errorLogs: [],
        outputLogs: [],
        otherLogs: [],
        files: [],
      },
      totalFiles: 0,
      totalSize: 0,
      totalSizeFormatted: "0 B",
      files: [],
    };
  }
};

// ============================================================
// SYSTEM ALERTS
// ============================================================

const getSystemAlerts = ({
  cpuUsage = 0,
  memoryUsage = 0,
  diskUsage = 0,
  mongoConnected = false,
  pm2Info = {},
}) => {
  const alerts = [];

  const addAlert = (
    type,
    severity,
    title,
    message,
  ) => {
    alerts.push({
      id: `${type}-${Date.now()}`,

      type,

      severity,

      title,

      message,
    });
  };

  if (cpuUsage >= 90) {
    addAlert(
      "cpu",
      "error",
      "Critical CPU Usage",
      `CPU usage is critically high at ${cpuUsage}%.`,
    );
  } else if (
    cpuUsage >= 75
  ) {
    addAlert(
      "cpu",
      "warning",
      "High CPU Usage",
      `CPU usage is high at ${cpuUsage}%.`,
    );
  }

  if (memoryUsage >= 90) {
    addAlert(
      "memory",
      "error",
      "Critical Memory Usage",
      `Memory usage is critically high at ${memoryUsage}%.`,
    );
  } else if (
    memoryUsage >= 75
  ) {
    addAlert(
      "memory",
      "warning",
      "High Memory Usage",
      `Memory usage is high at ${memoryUsage}%.`,
    );
  }

  if (diskUsage >= 90) {
    addAlert(
      "disk",
      "error",
      "Critical Disk Usage",
      `Disk usage is critically high at ${diskUsage}%.`,
    );
  } else if (
    diskUsage >= 80
  ) {
    addAlert(
      "disk",
      "warning",
      "High Disk Usage",
      `Disk usage is high at ${diskUsage}%.`,
    );
  }

  if (!mongoConnected) {
    addAlert(
      "mongodb",
      "error",
      "MongoDB Disconnected",
      "The application is currently disconnected from MongoDB.",
    );
  }

  if (
    pm2Info.available &&
    Number(pm2Info.online || 0) <
      Number(pm2Info.total || 0)
  ) {
    addAlert(
      "pm2",
      "error",
      "PM2 Process Problem",
      `${pm2Info.online || 0} of ${
        pm2Info.total || 0
      } processes are online.`,
    );
  }

  return alerts;
};

// ============================================================
// SYSTEM STATUS
// ============================================================

exports.getSystemStatus =
  async (req, res) => {
    try {
      const [
        cpu,
        currentLoad,
        memoryLegacy,
        disks,
        osInfo,
        time,
        processInfo,
        pm2Info,
        logsInfo,
        mongoHealth,
      ] = await Promise.all([
        si.cpu(),
        si.currentLoad(),
        si.mem(),
        si.fsSize(),
        si.osInfo(),
        si.time(),
        si.processes(),
        getPm2Info(),
        getLogsInfo(),
        getMongoHealth(),
      ]);

      const memory = await getMemoryInfo();
      const networkInfo = await getNetworkInfo();

      const mainDisk =
        disks.find(
          (disk) =>
            disk.mount === "/",
        ) ||
        disks[0] ||
        {};

      const cpuUsage =
        Number(
          (
            currentLoad.currentLoad ||
            0
          ).toFixed(2),
        );

      const memoryUsage = memory.percentage || 0;

      const diskUsage =
        mainDisk.size > 0
          ? Number(
              (
                (mainDisk.used /
                  mainDisk.size) *
                100
              ).toFixed(2),
            )
          : 0;

      const metric = {
        timestamp:
          new Date().toISOString(),

        cpu:
          cpuUsage,

        memory:
          memoryUsage,

        disk:
          diskUsage,

        mongodbLatency:
          mongoHealth.latencyMs,

        mongodbConnected:
          mongoHealth.connected,
      };

      const metricsHistory =
        addMetricToHistory(
          metric,
        );

      const alerts =
        getSystemAlerts({
          cpuUsage,

          memoryUsage,

          diskUsage,

          mongoConnected:
            mongoHealth.connected,

          pm2Info,
        });

      let healthStatus =
        "healthy";

      if (
        alerts.some(
          (alert) =>
            alert.severity ===
            "error",
        )
      ) {
        healthStatus =
          "critical";
      } else if (
        alerts.length > 0
      ) {
        healthStatus =
          "warning";
      }

      return res.status(200).json({
        success: true,

        timestamp:
          new Date().toISOString(),

        health: {
          status:
            healthStatus,

          alerts:
            alerts.length,
        },

        server: {
          hostname:
            os.hostname(),

          platform:
            os.platform(),

          architecture:
            os.arch(),

          kernel:
            os.release(),

          uptime:
            os.uptime(),

          uptimeFormatted:
            formatUptime(
              os.uptime(),
            ),

          os:
            `${osInfo.distro || ""} ${
              osInfo.release || ""
            }`.trim(),
        },

        cpu: {
          manufacturer:
            cpu.manufacturer,

          brand:
            cpu.brand,

          cores:
            cpu.cores,

          physicalCores:
            cpu.physicalCores,

          speed:
            cpu.speed,

          usage:
            cpuUsage,

          percentage:
            cpuUsage,

          currentLoad:
            currentLoad.currentLoad,
        },

        memory: {
          total: memory.total,
          used: memory.used,
          actualUsed: memory.actualUsed,
          available: memory.available,
          free: memory.free,
          rawUsed: memory.rawUsed,
          cached: memory.cached,
          percentage: memory.percentage,
          usagePercentage: memory.usagePercentage,
          totalFormatted: memory.totalFormatted,
          usedFormatted: memory.usedFormatted,
          actualUsedFormatted: memory.actualUsedFormatted,
          availableFormatted: memory.availableFormatted,
          freeFormatted: memory.freeFormatted,
          rawUsedFormatted: memory.rawUsedFormatted,
          cachedFormatted: memory.cachedFormatted,
        },

        disk: {
          filesystem:
            mainDisk.fs || null,

          mount:
            mainDisk.mount || "/",

          total:
            mainDisk.size || 0,

          used:
            mainDisk.used || 0,

          free:
            mainDisk.available || 0,

          percentage:
            diskUsage,

          totalFormatted:
            formatBytes(
              mainDisk.size || 0,
            ),

          usedFormatted:
            formatBytes(
              mainDisk.used || 0,
            ),

          freeFormatted:
            formatBytes(
              mainDisk.available || 0,
            ),
        },

        network: {
          interface: networkInfo.interface,
          ipAddress: networkInfo.ipAddress,
          macAddress: networkInfo.macAddress,
          received: networkInfo.receivedBytes,
          transmitted: networkInfo.transmittedBytes,
          receivedFormatted: networkInfo.receivedFormatted,
          transmittedFormatted: networkInfo.transmittedFormatted,
          speed: networkInfo.speed,
          operstate: networkInfo.operstate,
          available: networkInfo.available,
        },

        mongodb:
          mongoHealth,

        pm2:
          pm2Info,

        logs:
          logsInfo,

        application: {
          pid:
            process.pid,

          nodeVersion:
            process.version,

          uptime:
            process.uptime(),

          uptimeFormatted:
            formatUptime(
              process.uptime(),
            ),

          memoryUsage:
            process.memoryUsage(),

          activeProcesses:
            processInfo.all || 0,

          runningProcesses:
            processInfo.running || 0,
        },

        metricsHistory,

        alerts: {
          total:
            alerts.length,

          hasCritical:
            alerts.some(
              (alert) =>
                alert.severity ===
                "error",
            ),

          items:
            alerts,
        },

        time: {
          current:
            new Date().toISOString(),

          uptime:
            time.uptime,
        },
      });
    } catch (error) {
      console.error(
        "System status error:",
        error,
      );

      return res.status(500).json({
        success: false,

        message:
          "Failed to retrieve system status",

        error:
          error.message,
      });
    }
  };

// ============================================================
// RESTART PM2 PROCESS
// ============================================================

exports.restartPm2Process =
  async (req, res) => {
    try {
      const {
        processName,
      } = req.params;

      if (
        !ALLOWED_PM2_PROCESSES.includes(
          processName,
        )
      ) {
        return res
          .status(400)
          .json({
            success: false,

            message:
              "Invalid PM2 process.",
          });
      }

      const {
        stdout,
        stderr,
      } = await execFileAsync(
        "pm2",
        [
          "restart",
          processName,
        ],
        {
          timeout: 30000,

          maxBuffer:
            10 * 1024 * 1024,
        },
      );

      return res.status(200).json({
        success: true,

        message:
          `${processName} restarted successfully.`,

        output:
          stdout ||
          stderr ||
          null,
      });
    } catch (error) {
      console.error(
        "PM2 restart error:",
        error,
      );

      return res.status(500).json({
        success: false,

        message:
          "Failed to restart PM2 process.",

        error:
          error.message,
      });
    }
  };

// ============================================================
// RESTART INDIVIDUAL PM2 INSTANCE
// ============================================================

exports.restartPm2Instance =
  async (req, res) => {
    try {
      const processId =
        Number(
          req.params.processId,
        );

      if (
        !Number.isInteger(
          processId,
        ) ||
        processId < 0
      ) {
        return res
          .status(400)
          .json({
            success: false,

            message:
              "Invalid process ID.",
          });
      }

      const {
        stdout,
        stderr,
      } = await execFileAsync(
        "pm2",
        [
          "restart",
          String(processId),
        ],
        {
          timeout: 30000,

          maxBuffer:
            10 * 1024 * 1024,
        },
      );

      return res.status(200).json({
        success: true,

        message:
          `PM2 instance ${processId} restarted successfully.`,

        output:
          stdout ||
          stderr ||
          null,
      });
    } catch (error) {
      console.error(
        "PM2 instance restart error:",
        error,
      );

      return res.status(500).json({
        success: false,

        message:
          "Failed to restart PM2 instance.",

        error:
          error.message,
      });
    }
  };
