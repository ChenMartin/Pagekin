FROM node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS base
FROM base AS editor-build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY build-editor.mjs ./
COPY editor ./editor
RUN npm run build:editor
RUN npm prune --omit=dev --ignore-scripts --no-audit --no-fund

FROM base AS runtime
WORKDIR /app
ARG PAGEKIN_INSTALL_MEDIA=0
RUN if [ "$PAGEKIN_INSTALL_MEDIA" = 1 ]; then \
      node -e 'process.stdout.write(require("node:tls").rootCertificates.join("\n") + "\n")' > /tmp/pagekin-debian-ca.pem && \
      sed -i 's@http://deb.debian.org@https://deb.debian.org@g' /etc/apt/sources.list.d/debian.sources && \
      apt-get -o Acquire::https::CaInfo=/tmp/pagekin-debian-ca.pem -o Acquire::Retries=2 -o Acquire::https::Timeout=25 update && \
      apt-get -o Acquire::https::CaInfo=/tmp/pagekin-debian-ca.pem -o Acquire::Retries=2 -o Acquire::https::Timeout=25 install -y --no-install-recommends ffmpeg && \
      rm /tmp/pagekin-debian-ca.pem && \
      rm -rf /var/lib/apt/lists/*; \
    fi
COPY --chown=node:node server.mjs store.mjs input.mjs screenplay-store.mjs desktop-archive.mjs desktop-copy.mjs writing-context.mjs review-report.mjs revision-merge.mjs continuation.mjs version.mjs maintenance.mjs semantic.mjs ./
COPY --chown=node:node manuscript-export.mjs reference-novels.mjs character-continuity.mjs continuity-report.mjs ./
COPY --chown=node:node desktop-character-import.mjs desktop-continuity.mjs novel-progress.mjs model-profiles.mjs webdav-backup.mjs ./
COPY --chown=node:node architecture-store.mjs thread-evidence.mjs ./
COPY --chown=node:node storyboard.mjs production-runs.mjs ./
COPY --chown=node:node media-store.mjs media-files.mjs media-render.mjs ./
COPY --chown=node:node epub-extraction.ts epub-preview-worker.mjs ./
COPY --chown=node:node public ./public
COPY --from=editor-build --chown=node:node /build/node_modules ./node_modules
COPY --from=editor-build --chown=node:node /build/public/editor.bundle.mjs /build/public/editor.notices.txt ./public/
RUN mkdir /data && chown node:node /data
USER node
ENV APP_DATA_DIR=/data APP_HOST=0.0.0.0 PORT=3100
EXPOSE 3100
CMD ["node", "server.mjs"]
