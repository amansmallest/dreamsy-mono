# One image for the API and the harness worker (worker needs Chromium for playtests).
#   docker build -f deploy/Dockerfile -t dreamsy .
#   API:    CMD default        worker: command ["pnpm","-C","harness","worker"]
FROM mcr.microsoft.com/playwright:v1.65.1-noble
WORKDIR /app
RUN npm i -g pnpm@10.4.1
COPY . .
RUN printf 'packages:\n  - services/api\n  - harness\n  - format\n  - engine-web\n' > pnpm-workspace.yaml \
 && pnpm install --no-frozen-lockfile --filter @dreamsy/api... --filter @dreamsy/harness... \
 && pnpm -C engine-web exec vite build --logLevel warn
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787
EXPOSE 8787
CMD ["sh", "-c", "pnpm -s -C services/api db:migrate && pnpm -s -C services/api start"]
