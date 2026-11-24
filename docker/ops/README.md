# Production monitoring (asksales.ai)

Three gaps showed up while chasing the slow Reports page (November 2026):

1. Nothing recorded slow queries. The Reports page spent 19 s compiling JIT
   code for weeks, and it was found only by running EXPLAIN by hand.
2. API and worker logs disappeared on every deploy. Docker's `json-file` logs
   belong to the container, and each deploy replaces the containers.
3. Nothing outside the server watches it. When staging was down from 16 to 23
   November, and when the disk reached 96 %, nobody was told.

Nothing here is applied automatically. Run the steps in order; each says how
to undo it.

## Step 0. Free disk space

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

Clean-up that keeps the running images and the two newest rollback sets:

```bash
docker builder prune -f --filter until=72h
# List first; remove only after reading the list.
docker images --format '{{.Repository}}:{{.Tag}} {{.CreatedAt}}' \
  | grep '^asksales-rollback-' | sort -k2 -r | awk '{print $1}' \
  | awk -F: '{sha=$2} !(sha in seen) {seen[sha]=++n} seen[sha]>2 {print $0}' > /tmp/old-rollbacks.txt
cat /tmp/old-rollbacks.txt
xargs -r docker image rm < /tmp/old-rollbacks.txt
docker image prune -f
df -h /
```

Review the image list before removing `asksales-retained-*` or the staging
tags; they were kept on purpose at some point. The deploy script should also
prune old rollback sets after each release, or the disk fills again.

## Step 1. Journal limits

File: `docker/ops/journald-90-asksales.conf`. Caps the journal at 3 GB and 30
days, stops it growing when free disk is under 5 GB, and raises the per-service
rate limit (Docker writes all containers' logs as one service).

```bash
install -D -m 644 docker/ops/journald-90-asksales.conf /etc/systemd/journald.conf.d/90-asksales.conf
systemctl restart systemd-journald
journalctl --disk-usage
```

Undo: delete the file and restart `systemd-journald`.

## Step 2. Container logs that survive deploys

After step 1, change the logging anchor at the top of
`docker-compose.production.yml` and deploy as usual (the deploy recreates the
containers, which is when the new driver takes effect):

```yaml
# Logs go to the systemd journal so they outlive each deploy's new containers.
# Limits: docker/ops/journald-90-asksales.conf.
x-runtime-logging: &runtime-logging
  driver: journald
  options:
    tag: "{{.Name}}"
```

`docker logs sm-api` keeps working. Older history:

```bash
journalctl CONTAINER_NAME=sm-api --since "2 hours ago" -o cat
journalctl CONTAINER_NAME=sm-worker-1 --since "2026-11-24 09:00" --until "2026-11-24 10:00" -o cat
journalctl CONTAINER_NAME=sm-api -o cat | grep '"level":50'   # errors
```

The journald driver was checked on this server with a throwaway container on
24 November 2026.

Undo: put back `driver: json-file` with `max-size: "10m"` and `max-file: "3"`
and deploy.

## Step 3. Slow-query log and query statistics (Postgres)

File: `docker/ops/postgres-90-asksales-observability.conf`

- Logs every statement slower than 2 s. Bound parameter values (`$1`, `$2`…)
  are not logged; values written straight into SQL text are.
- Logs lock waits over 1 s, sorts that spill more than 10 MB, and autovacuum
  runs over 10 s.
- Loads `pg_stat_statements`, which keeps per-query totals (calls, total and
  mean time, rows, buffers).

All values were accepted by the production server in a rolled-back
transaction on 24 November 2026. Logs go to
`/var/log/postgresql/postgresql-17-main.log`, which logrotate already rotates
weekly and keeps for 10 weeks.

Loading `pg_stat_statements` needs a Postgres restart (a few seconds). The
workers send WhatsApp messages and emails: a restart in the middle of a send
can leave a message sent by the provider but not recorded here. Stop the
workers first, or pick a time when the outreach queue is empty. API requests
in flight fail and the client retries them.

```bash
docker stop sm-worker-1 sm-worker-2
install -m 644 -o postgres -g postgres docker/ops/postgres-90-asksales-observability.conf \
  /etc/postgresql/17/main/conf.d/90-asksales-observability.conf
systemctl restart postgresql@17-main
sudo -u postgres psql -d "$DB_NAME" -c 'CREATE EXTENSION IF NOT EXISTS pg_stat_statements'
docker start sm-worker-1 sm-worker-2
docker ps --format '{{.Names}} {{.Status}}'   # all healthy again
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

Undo: delete the conf.d file and restart Postgres (workers stopped again).

## Step 4. Alerts from outside the server (DigitalOcean)

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

`/api/health` (`healthCheck` in `server/controllers/healthController.ts`)
answers `{"success":true,"data":{"status":"healthy"}}` only when the API is up
and can query Postgres. It does not check Redis or the workers; their container
health checks restart them, and the logs from step 2 show why.

**Droplet alert policies** (Monitoring → Resource alerts → Create alert)

| Metric | Condition |
| --- | --- |
| Disk utilization | above 85 % for 5 minutes |
| Memory utilization | above 90 % for 10 minutes |
| CPU utilization | above 90 % for 15 minutes |
