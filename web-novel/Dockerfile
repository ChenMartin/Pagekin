FROM node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9
WORKDIR /app
COPY --chown=node:node server.mjs store.mjs desktop-archive.mjs desktop-copy.mjs writing-context.mjs version.mjs maintenance.mjs ./
COPY --chown=node:node public ./public
RUN mkdir /data && chown node:node /data
USER node
ENV APP_DATA_DIR=/data APP_HOST=0.0.0.0 PORT=3100
EXPOSE 3100
CMD ["node", "server.mjs"]
