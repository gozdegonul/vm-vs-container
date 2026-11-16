# Same Node.js version as the VM (22 LTS), on a small Alpine base image.
FROM node:22-alpine

WORKDIR /app
COPY server.js .

# Run as the unprivileged "node" user that the base image provides.
USER node

ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
