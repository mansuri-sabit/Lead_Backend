FROM mcr.microsoft.com/playwright:v1.58.2-jammy

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
# Do NOT hardcode PORT — Render injects it at runtime and the app reads process.env.PORT

CMD ["node", "--import", "tsx", "server.js"]
