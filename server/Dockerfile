# VCall 信令服务镜像（零第三方依赖，镜像体积小）
FROM node:20-alpine

# 以 root 启动，由 entrypoint 修正数据目录属主后切换到 node 用户
RUN apk add --no-cache su-exec

WORKDIR /app

ENV NODE_ENV=production \
    VCALL_PORT=9002 \
    VCALL_DATA_DIR=/data

COPY package.json ./
COPY src ./src
COPY public ./public
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh \
    && chmod +x /usr/local/bin/docker-entrypoint.sh \
    && mkdir -p /data \
    && chown -R node:node /app /data

EXPOSE 9002

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.VCALL_PORT||9002)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "src/index.js"]
