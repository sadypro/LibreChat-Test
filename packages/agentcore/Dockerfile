# LibreChat Code API middleware for Amazon Bedrock AgentCore Code Interpreter.
# Build from the repository root so the workspace lockfile is used:
#   docker build -f packages/agentcore/Dockerfile -t librechat-agentcore .

FROM node:24.16.0-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/agentcore/package.json ./packages/agentcore/package.json
RUN npm ci --workspace packages/agentcore --ignore-scripts --no-audit --no-fund
COPY packages/agentcore ./packages/agentcore
RUN npm run build --workspace packages/agentcore

FROM node:24.16.0-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/agentcore/package.json ./packages/agentcore/package.json
RUN npm ci --workspace packages/agentcore --omit=dev --ignore-scripts --no-audit --no-fund \
  && npm cache clean --force
COPY --from=build /app/packages/agentcore/dist ./packages/agentcore/dist
USER node
EXPOSE 8790
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8790/health || exit 1
CMD ["node", "packages/agentcore/dist/server.js"]
