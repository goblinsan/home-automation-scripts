FROM node:24-alpine

WORKDIR /app

RUN apk add --no-cache openssh-client sshpass

COPY package.json ./
COPY src ./src
COPY configs ./configs
COPY deploy ./deploy
COPY docs ./docs
COPY migration ./migration

EXPOSE 4173

CMD ["node", "src/cli.ts", "serve-ui", "--config", "/config/gateway.config.json", "--host", "0.0.0.0", "--port", "4173", "--out", "/data/generated"]
