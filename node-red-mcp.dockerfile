# ghcr.io/mintbluejelly/node-red-mcp
#
# `package.json`'s version is the image tag; the workflow reads it from there.

FROM docker.io/node:24-alpine3.24 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: nothing in the production tree needs an install script, so none gets to run.
RUN npm ci --omit=dev --ignore-scripts

FROM docker.io/node:24-alpine3.24
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
USER 1000:1000
EXPOSE 8080
# ENTRYPOINT, not CMD: a runner supplying arguments appends to an entrypoint. Against a CMD-only
# image those arguments replace the command, and the container dies with "exec: ... not found".
ENTRYPOINT ["node", "/app/src/index.js"]
