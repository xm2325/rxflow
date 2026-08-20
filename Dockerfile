FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
# PostgreSQL is loaded dynamically only when selected, but the production image
# must still contain the locked pg runtime dependency for Cloud SQL deployments.
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/fixtures ./fixtures
ENV PORT=8080
EXPOSE 8080
# The runtime image is read-only for application code and does not require root.
USER node
CMD ["node", "dist/src/server.js"]
