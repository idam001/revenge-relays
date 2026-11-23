# revenge-relays — free, rotating egress for the REVENGE API relay fabric

Every GitHub Actions job is a fresh VM on a fresh IP addresses, free on a public repository. That is the
rotating pool the relay fabric needed: not a proxy list (those are mostly dead) but disposable,
known-good addresses you own.

## Two patterns

**artifact** — no server needed. The app dispatches a job, the runner performs the request, uploads the
answer as an artifact, the app downloads it and streams it to the caller.

**queue** — deploy `relay.mjs` anywhere that stays up (Render/Fly/Koyeb free instance, a VPS, Oracle
Always Free, or your own box). The app dispatches runners, the runners long-poll the host, the host
returns the bytes to the caller with no extra hop.

## Files

| file | what it is |
|---|---|
| `relay.mjs` | relay host: `/ping`, `/ip`, `/fetch`, `/dispatch` (GET long-poll + POST job), `/result` |
| `runner.sh` | queue-mode runner: long-polls the host and answers jobs |
| `workflow.yml` | `relay.yml` — dispatch target for both modes |

## Wire it to the app

```
GH_RELAY=1
GH_RELAY_TOKEN=<a token with repo + workflow on this repo>
GH_RELAY_REPO=idam001/revenge-relays
GH_RELAY_WORKFLOW=relay.yml
GH_RELAY_HOST=            # empty = artifact mode
GH_RELAY_KEY=             # shared secret in queue mode
```

Nothing is claimed that was not measured: the artifact mode is proved by a dispatched job whose bytes
come back; the queue mode is proved by a live runner answering a real request.
