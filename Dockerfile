FROM node:22-alpine

WORKDIR /app

# 无需 npm install：全部使用 Node 内置模块
COPY app/ ./app/

ENV WMS_PORT=18091 \
    WMS_HOST=0.0.0.0 \
    WMS_DATA_DIR=/data

VOLUME ["/data"]
EXPOSE 18091

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:18091/login >/dev/null || exit 1

CMD ["node", "app/server.js"]
