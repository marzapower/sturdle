# Sturdle Pro

Sturdle is open core. Everything in this repository is MIT and stays MIT: the engine, the
Postgres adapter, the console components, the examples and the documentation. **Sturdle Pro**
is a set of features built on top of them, sold as a licence. None of it exists yet, and none
of its code will ever live here.

The licence page is at <https://sturdle.dev/pro>.

## What is free and what will be Pro

| Free (MIT)                                                                | Sturdle Pro (planned)                                                                                     | Status in the code                                   |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Queues, workers, heartbeat, recovery of stale jobs                        | —                                                                                                         | Exists                                               |
| Retries with exponential backoff, dead letter                             | —                                                                                                         | Exists                                               |
| Memoized `step.run`, `step.sleep` / `step.sleepUntil`                     | —                                                                                                         | Exists                                               |
| Cron with a distributed lock                                              | —                                                                                                         | Exists                                               |
| Global concurrency per task, concurrency per payload key, priority queues | —                                                                                                         | Exists (`packages/engine/src/engine/concurrency.ts`) |
| Installable console (per-attempt timeline, table, chart)                  | —                                                                                                         | Components yes, application not yet                  |
| Telemetry hook `onEvent`                                                  | —                                                                                                         | Exists                                               |
| —                                                                         | **Windowed rate limits and throttling distributed across workers**, per task and per key                  | Planned, not written                                 |
| —                                                                         | **Debounce, batch, fan-out and workflows**                                                                | Planned, not written                                 |
| —                                                                         | **Retry-aware alerts** (Slack, email, webhook; thresholds on attempts and dead letters) — to be validated | Planned, not written                                 |
| —                                                                         | Payload encryption                                                                                        | Planned, not written                                 |
| —                                                                         | Email support during business hours                                                                       | —                                                    |
| —                                                                         | Enterprise: on-prem console with SSO/RBAC, EU data-processing agreement, SLA                              | Planned, not written                                 |

"Planned" means exactly that: a direction, not a promise with a date. If a row moves from the
right column to the left one, it becomes MIT and is never taken back.

## The licence model

A Sturdle Pro licence is **flat, per organisation**: one price, unlimited environments, unlimited
workers, unlimited jobs. Nothing is ever priced per step, per run or per event, because your
jobs run on your Postgres and we have no meter to read. The prices offered today — an offer,
not what customers pay, since there are none yet — are **€99 per month or €990 per year per
organisation** for Sturdle Pro, and **Enterprise from €349 per month** for the on-prem console
with SSO/RBAC, an EU data-processing agreement and an SLA. Sales, invoicing and prices are in
euro and EU-only for now. There is no billing in the product: the Pro page collects licence
requests, and that is all it does.
