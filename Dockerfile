FROM node:22-alpine

RUN apk add --no-cache git ripgrep

WORKDIR /app
COPY package.json ./
COPY dist/mcp-server.mjs ./dist/mcp-server.mjs

ENV NODE_ENV=production
ENV AGY_FAST_AUTO_UPDATE=0

USER node

ENTRYPOINT ["node", "/app/dist/mcp-server.mjs"]
