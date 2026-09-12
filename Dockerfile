FROM node:22-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends unzip ca-certificates && rm -rf /var/lib/apt/lists/*

# The complete RYE Core bundle is supplied as RYE_CORE_BUNDLE.zip.
COPY RYE_CORE_BUNDLE.zip /tmp/RYE_CORE_BUNDLE.zip
RUN unzip -q /tmp/RYE_CORE_BUNDLE.zip -d /app/ && rm /tmp/RYE_CORE_BUNDLE.zip

COPY app_mcp_modern/package.json app_mcp_modern/tsconfig.json app_mcp_modern/index.html ./app_mcp_modern/
COPY app_mcp_modern/server.ts ./app_mcp_modern/server.ts
WORKDIR /app/app_mcp_modern
RUN npm install && npm run build

EXPOSE 8787
ENV RYE_ROOT=/app/RYE_Core_v0_1
CMD ["npm", "run", "serve"]
