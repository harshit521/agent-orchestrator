# ---- dependencies -------------------------------------------------------
FROM node:22-bookworm-slim AS deps
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/

# The api workspace's postinstall runs `prisma generate`, which needs the
# schema and its config to exist before dependencies are installed.
COPY apps/api/prisma apps/api/prisma
COPY apps/api/prisma7.config.ts apps/api/prisma7.config.ts

RUN npm ci


# ---- build --------------------------------------------------------------
FROM deps AS build
WORKDIR /app

COPY . .

RUN npm run db:generate --workspace=apps/api
RUN npm run build


# ---- runtime ------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

# Git is required by TaskFleet's WorktreeService/Coding Agent.
# Python is required for Semgrep.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        git \
        curl \
        wget \
        ca-certificates \
        python3 \
        python3-venv \
    && rm -rf /var/lib/apt/lists/*


# ---- Gitleaks -----------------------------------------------------------
# Secret scanning
RUN GITLEAKS_VERSION=8.28.0 \
    && wget -qO /tmp/gitleaks.tar.gz \
       "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz" \
    && tar -xzf /tmp/gitleaks.tar.gz \
       -C /usr/local/bin \
       gitleaks \
    && chmod +x /usr/local/bin/gitleaks \
    && rm -f /tmp/gitleaks.tar.gz


# ---- Semgrep ------------------------------------------------------------
# Static analysis
RUN python3 -m venv /opt/semgrep \
    && /opt/semgrep/bin/pip install --no-cache-dir semgrep \
    && ln -s /opt/semgrep/bin/semgrep /usr/local/bin/semgrep


# ---- Trivy --------------------------------------------------------------
# Dependency / vulnerability scanning
RUN TRIVY_VERSION=0.76.2 \
    && wget -qO /tmp/trivy.deb \
       "https://github.com/aquasecurity/trivy/releases/download/v${TRIVY_VERSION}/trivy_${TRIVY_VERSION}_Linux-64bit.deb" \
    && dpkg -i /tmp/trivy.deb \
    && rm -f /tmp/trivy.deb


# ---- application environment -------------------------------------------
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000


# ---- application --------------------------------------------------------
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json

COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/prisma ./apps/api/prisma
COPY --from=build /app/apps/api/prisma7.config.ts ./apps/api/prisma7.config.ts

COPY --from=build /app/apps/web/dist ./apps/web/dist


# ---- TaskFleet directories ----------------------------------------------
RUN mkdir -p \
        /app/apps/api/data \
        /app/.taskfleet/worktrees \
    && chown -R node:node /app


# Run as non-root user
USER node

EXPOSE 3000


# Apply the SQLite schema, then start the API and dashboard.
CMD ["sh", "-c", "cd apps/api && npx prisma db push && exec node dist/server.js"]