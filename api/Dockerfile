# binge-api — accounts + watched list. No npm deps.
FROM node:22-alpine
WORKDIR /app
COPY server.mjs .
VOLUME /data
EXPOSE 3000
CMD ["node", "--experimental-sqlite", "server.mjs"]
