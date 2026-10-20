# Hearthvale: build the static bundle, then serve dist/ + the API middleware
# with a dependency-free Node server (server/serve.js). No vite at runtime.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/dist ./dist
COPY --from=build /app/src ./src
COPY --from=build /app/server ./server
COPY package.json ./
EXPOSE 3001
# local.env (API key) is bind-mounted at /app/local.env at runtime.
CMD ["node", "server/serve.js"]
