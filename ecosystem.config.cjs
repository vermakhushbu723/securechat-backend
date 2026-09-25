// PM2: `pm2 start ecosystem.config.cjs` - API on every core + a separate worker.
module.exports = {
  apps: [
    {
      name: 'securechat-api',
      script: 'src/server.js',
      instances: 'max',
      exec_mode: 'cluster',
      env: { NODE_ENV: 'production', RUN_WORKERS: 'false' },
      max_memory_restart: '1G',
      kill_timeout: 15000,
    },
    {
      name: 'securechat-worker',
      script: 'src/workers/index.js',
      instances: 2,
      env: { NODE_ENV: 'production' },
    },
  ],
};
