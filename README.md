# node-red-mcp

A container image for [mcp-node-red](https://github.com/fx/mcp-node-red), an MCP server for Node-RED
that speaks the Admin API v2. Upstream ships it as an npm package and nothing else — no image, no
Dockerfile.

There is no source code here. The whole image is `npm install -g mcp-node-red@<version>` over an
Alpine-based Node image, and this repository exists only so that something orchestrating containers
has a pinned image reference to point at.

```
ghcr.io/mintbluejelly/node-red-mcp:1.1.0
```

The server is stdio-only and takes its configuration from the environment — `NODE_RED_URL`, and
`NODE_RED_TOKEN` where the Node-RED instance sets `adminAuth`. It advertises 17 tools covering
flows, node modules, context stores, runtime state and diagnostics; see upstream for the list.

## Releasing

**The npm pin in `node-red-mcp.dockerfile` is the release.** The workflow reads the version back out
of that file and tags the image with it, so the two can never disagree — bump the pin, push, and the
image appears as `:1.1.0`, `:latest` and `:<sha>`, with a matching `v1.1.0` GitHub release.

The version is upstream's, not this repository's, so it is not derived from commit history. A
rebuild at an unchanged pin finds its release already present and skips it.

## `ENTRYPOINT`, not `CMD`

The image declares an `ENTRYPOINT` so that a runner supplying arguments **appends** to it. Against a
`CMD`-only image those arguments replace the command, and the container dies with
`exec: … not found`.

The workflow's smoke test speaks a real MCP `initialize` over stdin rather than passing `--help`,
which this server does not implement — it would leave a stdio server waiting on a stdin that never
closes. `NODE_RED_URL` points nowhere during the test on purpose: nothing is dialled until a tool
call, so reaching `serverInfo` proves the entrypoint and the server start without needing a live
Node-RED.
