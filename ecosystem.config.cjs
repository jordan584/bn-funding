module.exports = {
  apps: [{
    name: 'bn-funding',
    script: 'dist/cli.js',
    args: '--send',
    exec_mode: 'fork',
    instances: 1,
    autorestart: false,
    time: true,
    env: { NODE_ENV: 'production', TZ: 'Asia/Shanghai' }
  }]
};
