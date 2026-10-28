# NutriLens production image (used by Fly.io)
FROM node:24-slim

ENV NODE_ENV=production
WORKDIR /app

# Install only production dependencies, using the lockfile for repeatable builds.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Open-source CLIP vision model (pinned revision, SHA-256 verified)
COPY scripts/fetch-model.mjs ./scripts/fetch-model.mjs
RUN node scripts/fetch-model.mjs

COPY server ./server
COPY public ./public
# Nutrition database: USDA FoodData Central + Indian Nutrient Databank (scripts/build-foods-db.mjs)
COPY datasets ./datasets
# Trained food classifier + label files (scripts/ml/)
COPY ml ./ml

# Data (SQLite database + meal photos) lives on a mounted volume, see fly.toml.
ENV DATA_DIR=/data PORT=8080
EXPOSE 8080

CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
