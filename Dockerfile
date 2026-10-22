# 多阶段：build(client+server) → node:22-alpine 运行（technical-design §9）
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
RUN npm ci
# shared 源码打进 server bundle；client 产物 dist/；随后裁掉 devDependencies
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000 CLIENT_DIST=/app/client-dist
# server bundle 仅 external fastify/ws/zod（生产依赖），shared 已打包进 dist/index.mjs
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/server/dist ./dist
COPY --from=build /app/packages/client/dist ./client-dist
EXPOSE 3000
CMD ["node", "dist/index.mjs"]
