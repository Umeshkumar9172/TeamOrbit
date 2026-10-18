FROM node:24-alpine

WORKDIR /app

COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN npm ci

COPY tsconfig.base.json ./
COPY backend backend
COPY database database

RUN npm run build --workspace @newtonite/api

WORKDIR /app/backend
EXPOSE 3000

CMD ["npm", "start"]
