# 使用指定的 Node.js 22 基础镜像
FROM docker-registry.qiyi.virtual/library/node:22-iqiyi-1

# 设置工作目录
WORKDIR /app

# 复制 package.json 和 package-lock.json
COPY package*.json ./

# 安装依赖
# 使用 --production 标志只安装生产依赖
# 使用 --legacy-peer-deps 避免可能的依赖冲突
RUN npm ci --production --legacy-peer-deps

# 复制应用程序代码
COPY . .

# 创建数据目录用于持久化 SQLite 数据库
RUN mkdir -p /app/data

# 暴露应用端口
EXPOSE 3000

# 设置环境变量
ENV NODE_ENV=production

# 健康检查
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# 启动应用
CMD ["npm", "start"]
