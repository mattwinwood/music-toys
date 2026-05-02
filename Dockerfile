FROM node:20-alpine

WORKDIR /app

COPY package.json ./
COPY server.js ./
COPY public ./public

ENV NODE_ENV=production
ENV PORT=3220
EXPOSE 3220

USER node

CMD ["node", "server.js"]
