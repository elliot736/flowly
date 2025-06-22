# flowly

Durable workflow engine for TypeScript, backed by Postgres. Zero infrastructure just `npm install` and pass a `pg.Pool`.

Define workflows as plain async functions. Each step is persisted to Postgres. If the process crashes, the workflow resumes from the last completed step.

## Features

- **Workflows as functions** no DSL, no YAML, no framework to learn
- **Step persistence** completed steps are saved and replayed on resume
- **Retries** configurable per step (exponential, linear, fixed backoff)
- **Compensation (sagas)** automatic rollback of completed steps on failure
- **Durable sleep** `ctx.sleep()` survives process restarts
