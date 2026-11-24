# Production monitoring (asksales.ai)

Three gaps showed up while chasing the slow Reports page (November 2026):

1. Nothing recorded slow queries. The Reports page spent 19 s compiling JIT
   code for weeks, and it was found only by running EXPLAIN by hand.
2. API and worker logs disappeared on every deploy. Docker's `json-file` logs
   belong to the container, and each deploy replaces the containers.
3. Nothing outside the server watches it. When staging was down from 16 to 23
   November, and when the disk reached 96 %, nobody was told.

The files for the first two are in `docker/ops/`. The third is set up in the
DigitalOcean control panel.

## 1. Slow-query log and query statistics (Postgres)

File: `docker/ops/postgres-90-asksales-observability.conf`

- Logs every statement slower than 2 s, without parameter values (they hold
  customer emails, phone numbers and message text).
- Logs lock waits over 1 s, sorts that spill more than 10 MB, and autovacuum
  runs over 10 s.
- Loads `pg_stat_statements`, which keeps per-query totals (calls, total and
  mean time, rows, buffers).

Logs go to `/var/log/postgresql/postgresql-17-main.log`, which logrotate
already rotates weekly and keeps for 10 weeks.

Apply (needs a Postgres restart of a few seconds; API requests in flight get a
database error and the client retries them; pick a quiet time):

```bash
install -m 644 -o postgres -g postgres docker/ops/postgres-90-asksales-observability.conf \
  /etc/postgresql/17/main/conf.d/90-asksales-observability.conf
systemctl restart postgresql@17-main
sudo -u postgres psql -d "$DB_NAME" -c 'CREATE EXTENSION IF NOT EXISTS pg_stat_statements'
docker ps --format '{{.Names}} {{.Status}}'   # sm-api and workers back to healthy
```

Use:

```sql
-- Slowest queries by total time since the last reset
SELECT round(total_exec_time) AS total_ms, calls, round(mean_exec_time) AS mean_ms,
       left(regexp_replace(query, '\s+', ' ', 'g'), 160) AS query
FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 20;
SELECT pg_stat_statements_reset();  -- start a fresh measurement window
```

```bash
grep 'duration:' /var/log/postgresql/postgresql-17-main.log | tail -20
```

Undo: delete the conf.d file and restart Postgres.

## 2. Container logs that survive deploys

Files: `docker-compose.production.yml` (logging driver) and
`docker/ops/journald-90-asksales.conf` (size and age limits).

The containers log to the systemd journal instead of a per-container file.
The journal keeps them across deploys, capped at 3 GB and 30 days, and always
leaves 10 GB of disk free. `docker logs sm-api` still works.

Apply the journald limits before the next deploy (the compose change takes
effect when the deploy recreates the containers):

```bash
install -m 644 docker/ops/journald-90-asksales.conf /etc/systemd/journald.conf.d/90-asksales.conf
systemctl restart systemd-journald
```

Read:

```bash
journalctl CONTAINER_NAME=sm-api --since "2 hours ago" -o cat
journalctl CONTAINER_NAME=sm-worker-1 --since "2026-11-24 09:00" --until "2026-11-24 10:00" -o cat
journalctl CONTAINER_NAME=sm-api -o cat | grep '"level":50'   # errors
```

Undo: change `x-runtime-logging` back to `json-file` with `max-size`/`max-file`
and redeploy.

## 3. Alerts from outside the server (DigitalOcean)

The droplet already runs the DigitalOcean monitoring agent (`do-agent`), so
these need no server change. In the DigitalOcean control panel:

**Uptime check** (Monitoring → Uptime → Create check)

| Field | Value |
| --- | --- |
| Type | HTTPS |
| URL | `https://asksales.ai/api/health` |
| Regions | at least two (for example: US East, Europe) |
| Alerts | Down for 2 minutes; SSL certificate expires in 14 days; latency over 5 s for 5 minutes |
| Notify | the owners' email (and Slack if you use it) |

`/api/health` answers `{"success":true,"data":{"status":"healthy"}}` only when
the API is up and can query Postgres. It does not check Redis or the workers;
the container health checks restart those, and the logs above show why.

**Droplet alert policies** (Monitoring → Resource alerts → Create alert)

| Metric | Condition |
| --- | --- |
| Disk utilization | above 85 % for 5 minutes |
| Memory utilization | above 90 % for 10 minutes |
| CPU utilization | above 90 % for 15 minutes |

## Disk space

On 24 November 2026 the root disk was 96 % full (7.5 GB free of 154 GB):

| What | Size | Unused |
| --- | --- | --- |
| Docker images | 103 GB | 60 GB |
| Docker build cache | 58 GB | 13 GB reclaimable now |
| Postgres data | 11 GB | |
| `/var/backups/asksales` | 10 GB | |

Each production release tags the previous images as
`asksales-rollback-<service>:<sha>` (about 9.5 GB per release), and nothing
removes them. Staging (`sm-dev-*`, `salesmarketing-dev-*:rollback-qa-*`) keeps
old images too.

Suggested clean-up (keeps the running images and the two newest rollback sets):

```bash
docker builder prune -f --filter until=72h
docker images --format '{{.Repository}}:{{.Tag}} {{.CreatedAt}}' \
  | grep '^asksales-rollback-' | sort -k2 -r | awk '{print $1}' \
  | awk -F: '{sha=$2} !(sha in seen) {seen[sha]=++n} seen[sha]>2 {print $0}' \
  | xargs -r docker image rm
docker image prune -f
```

Review the image list before removing `asksales-retained-*` or the staging
tags; they were kept on purpose at some point.
