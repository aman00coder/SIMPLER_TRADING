module.exports = {
  apps: [
    {
      name: "simplertrading",
      script: "app.js",
      instances: 1,
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: "development",
        PORT: 9090,
      },
      env_production: {
        NODE_ENV: "production",
        PORT: 9090,
      },
    },
  ],
};

