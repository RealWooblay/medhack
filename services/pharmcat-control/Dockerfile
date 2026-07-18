ARG NODE_IMAGE
FROM ${NODE_IMAGE}

ENV NODE_ENV=production
WORKDIR /service

COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src

USER node
CMD ["node", "src/server.mjs"]
