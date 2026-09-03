# ghcr.io/mintbluejelly/node-red-mcp
#
# Upstream ships mcp-node-red as an npm package only — no image and no Dockerfile.
# This wrapper exists solely so that a container runtime has something to run.
#
# The npm pin below is the single source of the image tag: the workflow reads it back out of this
# file, so bumping it here is the whole release.
FROM docker.io/node:24-alpine3.24

RUN npm install -g mcp-node-red@1.1.0

# ENTRYPOINT, not CMD: a runner supplying arguments appends to an entrypoint. Against a CMD-only
# image those arguments replace the command, and the container dies with "exec: ... not found".
USER 1000:1000
ENTRYPOINT ["mcp-node-red"]
