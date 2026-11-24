// ============================================================================
// DEPRECATED — DO NOT USE
// ============================================================================
// This PM2 configuration is kept for reference only.
// Production now uses Docker Compose (docker-compose.production.yml).
//
// To deploy: ./deploy.sh
// To manage: docker compose -f docker-compose.production.yml [up|down|logs|ps]
//
// The services below have been replaced by Docker containers:
//   salesmarketing-api     → sm-api        (server/Dockerfile)
//   salesmarketing-worker  → sm-worker-{1,2} (server/Dockerfile.worker)
//   salesmarketing-client  → sm-client     (client/Dockerfile)
//
// Infrastructure (PostgreSQL, Redis) runs natively on the host.
// Docker containers connect via host.docker.internal.
// ============================================================================

// Phase 4.14 / DEPLOY-006: shared resilience settings for every app.
//  - restart_delay: 5s cool-off between crash-restart attempts
//  - max_restarts: 10 (then PM2 marks the process as errored instead of looping)
//  - min_uptime: process must survive 10s to be considered "running" — short
//    enough that legit starts pass, long enough that crash loops get caught
//  - listen_timeout: 8s grace for binding ports / initial DB connection
const RESILIENCE = Object.freeze({
  restart_delay: 5000,
  max_restarts: 10,
  min_uptime: '10s',
  listen_timeout: 8000,
});

module.exports = {
  apps: [
    // ─── API Server (Express) ────────────────────────────────────────
    {
      name: 'salesmarketing-api',
      cwd: '/var/www/salesmarketing/server',
      script: 'dist/index.js',
      env: {
        NODE_ENV: 'production',
        PORT: 8080,
      },
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      ...RESILIENCE,
      error_file: '/var/log/pm2/salesmarketing-api-error.log',
      out_file: '/var/log/pm2/salesmarketing-api-out.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },

    // ─── Worker 1 (BullMQ) ──────────────────────────────────────────
    {
      name: 'salesmarketing-worker-1',
      cwd: '/var/www/salesmarketing/server',
      script: 'dist/worker-entry.js',
      env: {
        NODE_ENV: 'production',
      },
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      ...RESILIENCE,
      error_file: '/var/log/pm2/salesmarketing-worker-1-error.log',
      out_file: '/var/log/pm2/salesmarketing-worker-1-out.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },

    // ─── Worker 2 (BullMQ) ──────────────────────────────────────────
    {
      name: 'salesmarketing-worker-2',
      cwd: '/var/www/salesmarketing/server',
      script: 'dist/worker-entry.js',
      env: {
        NODE_ENV: 'production',
      },
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      ...RESILIENCE,
      error_file: '/var/log/pm2/salesmarketing-worker-2-error.log',
      out_file: '/var/log/pm2/salesmarketing-worker-2-out.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },

    // ─── Client (Next.js Standalone) ─────────────────────────────────
    {
      name: 'salesmarketing-client',
      cwd: '/var/www/salesmarketing/client/.next/standalone/client',
      script: 'server.js',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
        HOSTNAME: '0.0.0.0',
        NEXT_PUBLIC_API_URL: 'https://asksales.ai',
      },
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      ...RESILIENCE,
      error_file: '/var/log/pm2/salesmarketing-client-error.log',
      out_file: '/var/log/pm2/salesmarketing-client-out.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },

    // ─── Admin (Next.js Standalone) ──────────────────────────────────
    {
      name: 'salesmarketing-admin',
      cwd: '/var/www/salesmarketing/admin/.next/standalone/admin',
      script: 'server.js',
      env: {
        NODE_ENV: 'production',
        PORT: 3001,
        HOSTNAME: '0.0.0.0',
        NEXT_PUBLIC_API_URL: 'https://asksales.ai',
      },
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      ...RESILIENCE,
      error_file: '/var/log/pm2/salesmarketing-admin-error.log',
      out_file: '/var/log/pm2/salesmarketing-admin-out.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },

  ],
};
