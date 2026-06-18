# Platform Task Runtime

## Product Architecture

`platform_tasks` is the shared control-plane runtime for long-running platform work. AI generation, video rendering, storage migration, email batches, SMS batches, payment reconciliation, SDK smoke tests, and future deployment actions should all publish to this runtime instead of keeping isolated status tables.

The runtime has four layers:

1. API contract: platform modules create tasks, transition status, append redacted logs, and emit typed events.
2. Queue backend: BullMQ over Redis is the dispatch library. Postgres remains the source of truth and the fallback when Redis is unavailable.
3. Worker management: workers report heartbeats with queue names, status, and metadata. Operators read heartbeats from the dashboard instead of inferring health from logs.
4. Dashboard: `/platform-admin/jobs` shows task status, queue backend, worker id, events, and logs in one dense surface.

## Data Model

`platform_tasks` stores the current state. It is the only table operators should query for list pages and counts.

`platform_task_events` stores durable lifecycle events such as `task.created`, `task.enqueued`, `task.running`, `task.succeeded`, `task.failed`, and provider-specific milestones such as `runninghub.submitted` or `storage.multipart_uploaded`.

`platform_task_logs` stores bounded, redacted log lines. Providers and workers must not write raw credentials, API keys, Authorization headers, or full prompt bodies here.

`platform_worker_heartbeats` stores the latest worker liveness by worker id. A worker should update heartbeat before taking a task and then every 30 seconds while active.

## Existing Libraries vs Self-Built

Use existing libraries:

- BullMQ for Redis-backed dispatch, retries, job ids, and future worker concurrency.
- Official provider SDKs for AI, video, object storage, payment, email, and SMS calls.
- Prisma raw SQL for the current gateway migration/query pattern.

Self-build:

- Task state machine and platform-facing status vocabulary.
- Provider milestone mapping and error categories.
- Cost and usage summaries stored on tasks.
- Redaction rules for logs and event payloads.
- Operator dashboard and API contract.

Do not self-build a generic Redis queue, video rendering engine, object-storage multipart protocol, or AI provider protocol.

## AI and Video Integration

For synchronous text chat, keep the current request path and usage queue. Only create a platform task when the operation becomes asynchronous, expensive, or provider-polled.

For image, audio, and video generation:

1. Create a task with `module = ai` or `module = video`, `action = provider.operation`, `source_type = provider`, and `source_id = provider task id when known`.
2. Append `task.enqueued` after BullMQ accepts the job or DB fallback is selected.
3. On worker start, transition to `running`, set `worker_id`, and append `provider.submitted`.
4. During polling, append events only on status change. Do not append one event per poll tick.
5. On result download/upload, append `artifact.downloaded` and `artifact.persisted`.
6. On success, transition to `succeeded` with `result_json` and `output_summary_json`.
7. On provider failure, transition to `failed` with stable `error_code` and short `error_message`.

## Performance Strategy

Database:

- `platform_tasks` is indexed by `(app_id, status, created_at)`, `(module, status, created_at)`, `(queue_name, status, created_at)`, retry lookup, actor lookup, and recent created time.
- Hot-update tables use lower fillfactor and aggressive autovacuum settings.
- List pages read only `platform_tasks`; events and logs load only for the selected task.
- Logs are bounded to 8,000 characters per row and detail pages read only the latest 120 rows.

Queue:

- BullMQ is preferred when Redis is reachable.
- If Redis is down, task creation still succeeds and records `task.enqueued` with `backend = db`; operators can see fallback immediately.
- Use deterministic `jobId = task.id` for idempotent queue insertion.

Dashboard:

- Keep Jobs as a top-level operational surface.
- Do not duplicate task tables inside every module page.
- Module pages may deep-link to `/platform-admin/jobs?module=...` when needed.

## Recommended Next Attach Points

1. RunningHub and other polled video providers.
2. Long audio transcription or TTS batches.
3. Storage copy/migration and large upload finalization.
4. Email campaign fanout.
5. Payment reconciliation and entitlement repair batches.
