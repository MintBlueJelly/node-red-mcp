# Working in this repository

An MCP server for Node-RED: flows over the Admin API, status and debug output over the editor's
WebSocket, served as stateless Streamable HTTP. `README.md` explains **why** it is built the way it
is; this file covers how to work on it.

**This repository is the code only.** The image is built here and pinned by digest in a separate
deployment repository, so a change here reaches an environment only when that pin moves.

## Invariants

These cause real harm if violated. Everything else is a preference.

- **Nothing about the environments that run this server goes into this repository** — not in
  files, not in commit messages, not in test fixtures. No cluster, host or repository names, no
  namespaces, internal domains or IPs, no decision-record numbers from other repositories, no
  node modules or flow content from a real instance. The repository is hosted on GitHub. Screen the
  diff and the message before committing, not after.
- **There is one write path, in `src/writer.js`.** Every write goes through `createWriter`: fresh
  `GET /flows`, a pure plan, the etag, the outside-unchanged check, the validator, then
  `POST /flows` with `rev` and `Node-RED-Deployment-Type: flows`. Never add `PUT /flow/:id`, a full
  deploy, or a second way to deploy. Each one loses a guarantee the README lists.
- **What is not implemented stays unimplemented.** Deployments rely on there being no tool that
  installs, removes or enables node modules, starts or stops the runtime, deletes context, writes
  credentials, or deploys in full. `test/unit/surface.test.js` checks the names; the review checks
  the substance.
- **Tool names are an interface.** Deployments allowlist them by name, and an allowlist silently
  withholds a renamed tool. `test/tools.snapshot.txt` fails on any change. A rename or a new tool
  is a version bump and a note to the deployment repository.
- **Every input schema rejects unknown keys.** `server.js` wraps each tool's input in
  `z.strictObject`, and nested objects use `z.strictObject` too. A default `z.object` strips an
  unknown key, so a misspelt optional argument on a write turns into a silent `no_op`.
- **A restart-scope claim needs a measurement.** `restartScope` in `src/flows.js` mirrors Node-RED's
  `diffConfigs`, and `test/integration/writes.test.js` is the evidence that it matches. After
  bumping the `node-red` devDependency, run the integration tests before believing anything in the
  README about what restarts.

## Layout

```text
src/index.js      startup, wiring, shutdown
src/config.js     environment parsing; refuses what does not parse
src/server.js     stateless Streamable HTTP, /healthz, tool registration
src/tools.js      the 17 tools
src/writer.js     the write path and the plans for each kind of change
src/flows.js      pure functions over the flat flow array, including restartScope
src/validate.js   structural validation; refuses only what a change introduces
src/comms.js      the /comms client: statuses, debug, runtime events, reconnect
src/ring.js       the bounded debug buffer and its cursor
src/nodered.js    Admin API client
src/output.js     result formatting, caps, errors
test/unit/        no Node-RED needed
test/integration/ spawns the pinned Node-RED and the server as child processes
test/support/     fixture, fake Admin API, harness, MCP client
```

## Commands

```sh
npm ci
npm test
npm run test:integration    # ~30 s; the SIGSTOP test is skipped on Windows and runs in CI
```

## Releasing

Bump `version` in `package.json` and push. CI publishes only a version without a GitHub release,
and the release notes carry the digest the deployment repository pins.
