FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
COPY --chown=node:node clinics ./clinics
# Демо-пример отдельно: по нему проверка находит в файлах клиник забытые демо-врачи и цены.
COPY --chown=node:node clinics/demo.json ./templates/clinic-demo.json
RUN mkdir -p /app/data && chown node:node /app/data
# Без root: даже при взломе процесса злоумышленник не получит права на систему.
USER node
# База SQLite и бэкапы — держите /app/data на постоянном диске (volume), иначе записи пропадут при перезапуске.
VOLUME ["/app/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
