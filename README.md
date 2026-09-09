# Public Data Worker

A small worker service for polling public data sources, tracking cursors and fingerprints, and staging change events.

This repository intentionally contains no end-user data, production application code, or privileged production credentials. External writes use staged events rather than direct production-database access.

## Design

- Public-source polling and finite historical catch-up jobs run here.
- Worker state is stored in a small Postgres database.
- Validated deltas are staged in `change_events` for a downstream private consumer.
- Notification delivery and user-related processing stay outside this repository.

## Historical appeal catch-up

`.github/workflows/historical-appeals.yml` runs a bounded public-source scan three times daily. It resumes from a durable cursor in `worker_jobs`, stores source state in `source_state`, and emits only newly discovered appeal-reference deltas into `change_events`.

The workflow needs one repository secret: `WORKER_DATABASE_URL`.

## Local setup

1. Install Node.js 22 or newer.
2. Run `npm install`.
3. Set `WORKER_DATABASE_URL` to a Postgres connection string.
4. Apply `sql/001_worker_schema.sql`.
5. Run `npm run health`.
6. Run `npm run catchup:appeals` for a bounded catch-up pass.
