# node-red-mcp

An MCP server for authoring and troubleshooting Node-RED flows. It reads and writes flows through
the Admin API, and reads node status, debug output, node warnings and errors, and runtime events
through the editor's WebSocket. It serves Streamable HTTP, statelessly, on `:8080/mcp`.

```
ghcr.io/mintbluejelly/node-red-mcp:<version>
```

Up to 1.1.0 this image wrapped a third-party npm package. 2.0.0 is a rewrite with its own code,
because that package could not read a single flow and had no access to status or debug output.

## Tools

| Tool | Does |
| --- | --- |
| `create_flow` | creates a tab; refused if the label exists |
| `delete_flow` | deletes a disabled, unlocked tab; needs the etag |
| `get_context` | reads global, flow or node context |
| `get_debug_messages` | debug output, warnings, errors and runtime events since a cursor |
| `get_diagnostics` | Node-RED's diagnostics report |
| `get_flow` | one tab, subflow or config node with its etag; `global` lists config nodes and subflows |
| `get_flow_state` | whether flows run, the last runtime state event and deploy |
| `get_node_status` | the status each node shows in the editor |
| `get_nodes` | installed node types by module |
| `get_settings` | runtime settings as the editor sees them |
| `list_flows` | tabs and subflows with counts and how many nodes show a problem |
| `search_nodes` | finds nodes by text, type or flow, returning where they are |
| `set_debug_state` | switches a debug node on or off until its next restart |
| `trigger_inject` | presses an inject node's button, with a cooldown |
| `update_flow` | changes one tab; needs the etag |
| `update_global` | changes one subflow or global config node; needs the etag |
| `validate_flow` | runs a write's checks and reports what would restart, without deploying |

**Not implemented, on purpose:** installing, removing or enabling node modules, starting or
stopping the runtime, deleting context, writing credentials, and full deploys. A deployment can
rely on their absence; it does not have to filter them out.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `NODE_RED_URL` | required | e.g. `http://nodered:1880`; `/comms` is derived from it |
| `NODE_RED_TOKEN` | none | Admin API bearer token, also sent to `/comms`, where `adminAuth` is on |
| `PORT`, `HOST` | `8080`, `0.0.0.0` | where MCP is served |
| `NODE_RED_TIMEOUT_MS` | `30000` | per Admin API request |
| `COMMS_HEARTBEAT_TIMEOUT_MS` | `45000` | silence on `/comms` before it reconnects; Node-RED beats every 15 s |
| `DEBUG_BUFFER_ITEMS`, `DEBUG_BUFFER_BYTES` | `1000`, 4 MiB | bounds of the debug buffer |
| `RESULT_MAX_CHARS` | `40000` | larger results are replaced by a truncated preview and a hint |
| `INJECT_COOLDOWN_MS` | `10000` | how long `trigger_inject` refuses the same node again |

A value that does not parse stops the server at startup instead of falling back to a default.

## Design

### One write path

Every write reads the whole flow set, swaps the target objects in place, and deploys with
`POST /flows`, Node-RED's `rev`, and `Node-RED-Deployment-Type: flows` — the editor's "modified
flows" deploy. `PUT /flow/:id` looks like the obvious call and is the wrong one. It moves the edited
tab to the end of the tab order, drops `locked` and any other key the body omits, and has no `rev`
check, so it overwrites whatever someone deployed in between.

Before deploying, the server checks:

- that nothing outside the target changed;
- the caller's etag, so a flow someone edited since it was read is refused rather than overwritten;
- the validator: ids unique across all flows, wires, groups, links, subflow ports, and installed
  node types only. A type that is not installed would leave Node-RED "waiting for missing types".
  Only problems the change introduces are refused; existing ones are reported as warnings.

A 409 from Node-RED is retried once, and only if the etag still matches. Writes run one at a time.

### What restarts

A modified-flows deploy restarts the changed nodes and everything wired to them, transitively. It
also restarts:

- the users of a changed config node and the instances of a changed subflow, with their wired
  neighbours;
- every node of a tab whose `env` or `disabled` changed.

Layout, a tab's label and its description restart nothing. A `global-config` change restarts
everything, so `update_global` refuses it. Every write result lists the tabs that restart, and
`validate_flow` shows the same in advance. `test/integration/writes.test.js` measures each of these
against the real runtime with On Start counters. `src/flows.js` mirrors `diffConfigs` and `stop` in
`@node-red/runtime`.

### Clients repeat writes

Some MCP clients call a tool twice. So `update_flow` with content that is already deployed answers
`no_op` before it looks at the etag. `create_flow` refuses an existing label, `delete_flow` answers
`already_deleted`, and `trigger_inject` refuses the same node within the cooldown unless `repeat`
is set.

### Credentials

Node-RED never returns credentials, and it keeps a node's stored credentials when a deploy omits
them. The server never sends any, and refuses a node that carries a `credentials` key. Integration
tests check that credentials survive updates and a restart.

### `/comms`

A long-lived WebSocket subscribes to `status/#`, `debug` and `notification/#`.

- **Statuses.** Node-RED replays the current statuses on subscribe without a time, so they are
  marked `retained`. A status older than the last deploy is marked `beforeLastDeploy`.
- **Subflow instances.** Nodes inside a subflow instance report as `<instance>-<node>` and are
  attributed to the instance's tab.
- **Debug output** goes into a ring bounded by count and bytes, because Node-RED publishes it
  without a rate limit. Reads take a `<boot>:<seq>` cursor, so a client sees only what arrived
  after its last read. The cursor also tells it when the server restarted (`reset`) or entries were
  evicted (`missed`).
- **Reconnects.** A heartbeat watchdog reconnects after silence, with a backoff of 1 to 30 s.

The buffer lives in the process: **run one replica**, and expect it to be empty after a restart.

Whoever can call this server can read debug output and context, which may hold process data. That
is the same exposure as the editor.

### Stateless HTTP

Each POST gets a fresh MCP server over the shared process state: there are no sessions to
accumulate under a gateway's health probes, or to lose on restart. `tools/list` never calls
Node-RED, so the server stays listable while Node-RED is down. Every tool's input schema rejects
unknown keys, so a misspelt argument fails instead of being silently dropped.

## Developing

```sh
npm ci
npm test                    # unit tests, no Node-RED needed
npm run test:integration    # spawns the Node-RED pinned in devDependencies
```

The `node-red` devDependency is the runtime the integration tests prove the design against. Keep
it at the version you deploy, and bump it together with the deployed runtime.

## Releasing

**`version` in `package.json` is the release.** Every push to `main` runs the tests. An image is
published only for a version without a GitHub release, so a tag never moves: bump the version to
ship. The release notes carry the image digest.
