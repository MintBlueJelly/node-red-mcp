# ghcr.io/mintbluejelly/node-red-mcp
#
# `package.json`'s version is the image tag; the workflow reads it from there. The base image is
# pinned by digest; Dependabot proposes moving it.

FROM docker.io/node:24-alpine3.24@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: nothing in the production tree needs an install script, so none gets to run.
RUN npm ci --omit=dev --ignore-scripts

FROM docker.io/node:24-alpine3.24@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1
WORKDIR /app
ENV NODE_ENV=production
# The entrypoint is node; the package managers would only be something more to exploit.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
USER 1000:1000
EXPOSE 8080
# ENTRYPOINT, not CMD: a runner supplying arguments appends to an entrypoint. Against a CMD-only
# image those arguments replace the command, and the container dies with "exec: ... not found".
ENTRYPOINT ["node", "/app/src/index.js"]
