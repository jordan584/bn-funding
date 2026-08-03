module.exports = {
  apps: [{
    name: 'bn-funding',
    script: 'dist/index.js',
    exec_mode: 'fork',
    instances: 1,
    autorestart: true,
    restart_delay: 5000,
    max_restarts: 10,
    time: true,
    env: { NODE_ENV: 'production', TZ: 'Asia/Shanghai' }
  }]
};
