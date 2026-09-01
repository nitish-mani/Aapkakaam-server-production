module.exports = {
  apps: [
    {
      name: "aapkakaam-api",
      script: "./index.js",
      instances: 8,
      exec_mode: "cluster",
      autorestart: true,
      watch: false,
      max_memory_restart: "500M",
      env: {
        NODE_ENV: "production",
      },
    },

    {
      name: "aapkakaam-worker",
      script: "./src/worker.js",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "500M",
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
