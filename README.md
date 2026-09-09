# Public Data Worker

A small worker service for polling public data sources, tracking cursors and fingerprints, and staging change events.

This repository intentionally contains no end-user data, production application code, or privileged production credentials. External writes should use narrowly scoped interfaces only.

## Design

- Public-source polling and finite historical catch-up jobs run here.
- Worker state is stored in a small Postgres database.
- Only validated deltas are forwarded to downstream systems.
- Notification delivery and user-related processing stay outside this repository.

## Local setup

1. Install Node.js 22 or newer.
2. Run `npm install`.
3. Set `WORKER_DATABASE_URL` to a Postgres connection string.
4. Apply `sql/001_worker_schema.sql`.
5. Run `npm run health`.

The scheduled workflows will be enabled only after the worker database and restricted downstream interface are configured.