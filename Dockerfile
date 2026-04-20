FROM node:24-alpine

WORKDIR /app

RUN apk add --no-cache openssh-client sshpass

COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY src ./src
COPY configs ./configs
COPY deploy ./deploy
COPY docs ./docs
COPY db ./db
COPY examples ./examples
COPY legacy ./legacy

EXPOSE 4173

CMD ["node", "src/cli.ts", "serve-ui", "--config", "/config/gateway.config.json", "--host", "0.0.0.0", "--port", "4173", "--out", "/data/generated"]
