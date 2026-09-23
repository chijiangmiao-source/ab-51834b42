# 低温阵列扫描复核台 —— 零运行时依赖（仅 Node 20+ 内置模块）
FROM node:20-alpine

WORKDIR /app

# 无外部依赖可装，拷贝全部源码（测试与脚本随镜像提供，verify 服务复用）
COPY package.json ./
COPY server/ ./server/
COPY public/ ./public/
COPY scripts/ ./scripts/
COPY test/ ./test/

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8080
# 持久化数据建议挂载卷（compose 已挂命名卷）
ENV DATA_FILE=/app/data/store.json

RUN mkdir -p /app/data && node scripts/build-frontend.js

EXPOSE 8080

# 容器内健康检查：健康路径在服务就绪后可访问
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "server/server.js"]
