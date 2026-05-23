module.exports = {
  apps: [
    {
      name: 'cockroach-api',
      script: './dist/server.js',
      instances: 'max', // Use all available CPU cores (cluster mode)
      exec_mode: 'cluster',
      autorestart: true,
      watch: false,
      max_memory_restart: '1G', // Restart if it exceeds 1GB RAM to prevent memory leaks
      env: {
        NODE_ENV: 'development',
      },
      env_production: {
        NODE_ENV: 'production',
      },
    },
  ],
};
