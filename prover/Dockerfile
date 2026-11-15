FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund
COPY standalone/server.mjs ./standalone/
COPY checks.mjs fetch-artifacts.sh ./
RUN bash fetch-artifacts.sh
ENV PORT=3000
EXPOSE 3000
CMD ["node", "standalone/server.mjs"]
