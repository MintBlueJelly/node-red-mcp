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
| `get_flow` | one tab, subflow or config node with its etag; `global` lists config nodes and subflows; refuses a tab too large to return whole |
| `get_flow_state` | whether flows run, the last runtime state event and deploy |
| `get_node_status` | the status each node shows in the editor |
| `get_nodes` | installed node types by module |
| `get_settings` | runtime settings as the editor sees them |
| `list_flows` | tabs and subflows with counts and how many nodes show a problem |
| `search_nodes` | finds nodes by text, type or flow, returning where they are |
| `set_debug_state` | switches a debug node on or off until its next restart |
| `trigger_inject` | presses an inject node's button, with a cooldown; refuses any other node |
| `update_flow` | changes one tab; needs the etag |
| `update_global` | changes one subflow or global config node; needs the etag |
| `validate_flow` | runs a write's checks and reports what would restart, without deploying |

**Not implemented, on purpose:** installing, removing or enabling node modules, starting or
stopping the runtime, deleting context, writing credentials, and full deploys. A deployment can
rely on their absence; it does not have to filter them out.

**Refused in a flow write:** a function node's `libs`, because Node-RED runs `npm install` for
them on deploy, and `exec` nodes, which run shell commands. Ones that already exist stay editable.

**Not bounded:** a flow write is still code that runs in the Node-RED process, through function
nodes. Whoever may write flows through this server may run JavaScript there.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `NODE_RED_URL` | required | e.g. `http://nodered:1880`; `/comms` is derived from it |
| `NODE_RED_TOKEN` | none | Admin API bearer token, also sent to `/comms`, where `adminAuth` is on |
| `PORT`, `HOST` | `8080`, `0.0.0.0` | where MCP is served; `MCP_PORT` and `MCP_HOST`, as some MCP hosts set them, apply when these are unset |
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
- the caller's etag, so a flow someone edited since it was read is refused rather than overwritten.
  The refusal carries no etag: a client would resend its stale node list with it;
- the validator: ids unique across all flows, wires, groups, links, subflow ports, installed node
  types only, no group nested in itself, no subflow containing itself, no `libs`, no `exec` and no
  `cred` env value written in plain text. A type that is not installed leaves Node-RED "waiting
  for missing types"; a group or subflow cycle hangs it. Only problems the change introduces are
  refused; existing ones are reported as warnings.

A 409 from Node-RED is retried once, and only if the etag still matches. Writes run one at a time.

### What restarts

Every write result lists each flow where Node-RED stops or starts nodes, and how many; global config
nodes appear as `global`. `validate_flow` shows the same before a write.

- **How it is computed.** `src/diff.js` follows Node-RED's own `diffConfigs` step by step, then
  applies it the way `stop` and `start` do.
- **How that is proven.** `test/unit/diff.test.js` loads Node-RED's `diffConfigs` from the pinned
  devDependency and requires the same answer for every generated change to two fixtures.
- **What is measured.** `test/integration/scope.test.js` checks with On Start counters that the
  reported flows are the ones that restart. It covers a config node used by another config node,
  nested subflows, a config node used inside a subflow template, and link nodes across tabs.

What that means in practice:

- A change restarts the changed nodes and everything wired to them, transitively.
- Through a config node, a subflow or a single-target link, it also reaches other flows; through a
  group, the group's other members.
- A tab whose `env` or `disabled` changes restarts whole.
- Layout, a tab's label and its description restart nothing.
- A `global-config` change restarts everything, so `update_global` refuses it.

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

- **Statuses.** Node-RED replays the current statuses on subscribe without a time, so the first
  status for a node within a second of connecting is marked `retained`; one that really changed
  in that second looks the same. A status older than the last deploy is marked `beforeLastDeploy`.
- **Leftovers.** Node-RED can go on replaying the last status of a deleted node, or of a node in a
  disabled flow that set it while stopping. A status under the own id of a node in a subflow
  definition is one too, because that node never runs as itself. All are marked `stale`, and
  neither `only_problems` nor the `problems` count of `list_flows` includes them.
- **Subflow instances.** A node inside a subflow instance reports as `<instance>-<node>`, and
  inside nested instances as `<outer>-<inner>-<node>`. It is attributed to the outer instance's
  tab, and counts as a problem there.
- **Debug output** goes into a ring bounded by count and bytes, because Node-RED publishes it
  without a rate limit. Reads take a `<boot>:<seq>` cursor, so a client sees only what arrived
  after its last read. The cursor also tells it when the server restarted (`reset`) or entries were
  evicted (`missed`).
- **Reconnects.** A heartbeat watchdog reconnects after silence, with a backoff of 1 to 30 s.

The buffer lives in the process: **run one replica**, and expect it to be empty after a restart.

Whoever can call this server can read debug output and context, which may hold process data. That
is the same exposure as the editor's, with one difference: the buffer keeps history from before a
caller arrived, and every caller shares it.

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

The `node-red` devDependency is the runtime the tests prove the design against, the differential
test included. Keep it at the version you deploy, and bump it together with the deployed runtime;
Dependabot leaves it alone for that reason.

## Releasing

**`version` in `package.json` is the release.** Every push and pull request runs the tests, with
read-only permissions. Only `main` publishes, and only a version that has no GitHub release and no
image yet, so a tag never moves: bump the version to ship. The release notes carry the image digest.

## Licence

MIT. `src/diff.js` follows the algorithm of `diffConfigs` and `diffNodes` in Node-RED's
`@node-red/runtime`, which is licensed under the Apache License 2.0.
