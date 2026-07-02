/**
 * ecosystem.config.cjs — PM2 process manager config  (v2)
 *
 * Use this if deploying on a VPS/VM instead of Cloudflare Workers.
 * Start with: pm2 start ecosystem.config.cjs
 *
 * Features:
 *  - Cluster mode (uses all CPU cores)
 *  - Auto-restart on crash with exponential backoff
 *  - Log rotation via pm2-logrotate (install once: pm2 install pm2-logrotate)
 *  - Graceful shutdown on SIGINT/SIGTERM
 *  - Health-check aware (via max_restarts + min_uptime)
 *  - Memory limit guard (restart at 512 MB)
 *
 * First-time setup on a new VPS:
 *   pm2 install pm2-logrotate
 *   pm2 set pm2-logrotate:max_size 50M
 *   pm2 set pm2-logrotate:retain 14
 *   pm2 set pm2-logrotate:compress true
 *   pm2 set pm2-logrotate:dateFormat YYYY-MM-DD_HH-mm-ss
 *   pm2 start ecosystem.config.cjs
 *   pm2 save
 *   pm2 startup   # follow the printed command to enable auto-start on boot
 */

module.exports = {
  apps: [
    {
      name: "wabizz",
      script: ".output/server/index.mjs",
      interpreter: "bun",

      // Cluster mode for multi-core utilisation.
      // NOTE: In-memory rate-limiter / cache are per-process in this mode.
      // For shared limits across all workers, configure Upstash Redis and
      // set UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN in your env.
      instances: "max",
      exec_mode: "cluster",

      // Restart policy
      autorestart: true,
      watch: false,
      max_restarts: 10,
      min_uptime: "10s", // If the app crashes before 10s, count as failed restart
      restart_delay: 2000, // 2s initial delay between restarts
      exp_backoff_restart_delay: 100, // Exponential backoff for repeated crashes (max ~16s)

      // kill_timeout must exceed the graceful-shutdown drain window in server-init.ts
      // (timeoutMs: 10_000). We add 5s buffer for onShutdown cleanup → 15s total.
      kill_timeout: 15000,

      // ── Environment ──────────────────────────────────────────────────────────
      env: {
        NODE_ENV: "production",
        PORT: 3000,
      },

      // ── Logging ──────────────────────────────────────────────────────────────
      // Log files are rotated by pm2-logrotate (install separately — see header).
      // Rotation config: 50MB max per file, 14-day retention, compressed archives.
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      out_file: "./logs/pm2-out.log",
      error_file: "./logs/pm2-err.log",
      merge_logs: true,

      // ── Memory limit ─────────────────────────────────────────────────────────
      // Restart if process exceeds 512 MB (Workers don't have this issue).
      // Adjust upward if you observe legitimate high-memory usage in production.
      max_memory_restart: "512M",

      // ── Health monitoring ─────────────────────────────────────────────────────
      // PM2 will consider a worker unhealthy if it restarts more than max_restarts
      // times within the restart_delay window. Combine with an external uptime
      // monitor (e.g. Better Uptime, UptimeRobot) that pings /api/public/health.
    },
  ],

  // ── Deploy config (optional — for pm2 deploy) ─────────────────────────────
  // Uncomment and fill in if you use `pm2 deploy` for zero-downtime releases.
  //
  // deploy: {
  //   production: {
  //     user: "wabizz",
  //     host: "your-vps-ip",
  //     ref: "origin/main",
  //     repo: "git@github.com:your-org/wabizz.git",
  //     path: "/var/www/wabizz",
  //     "post-deploy": "bun install --frozen-lockfile && bun run build && pm2 reload ecosystem.config.cjs --env production",
  //   },
  // },
};
