FROM node:24-alpine

WORKDIR /app

COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN npm ci

COPY tsconfig.base.json ./
COPY frontend frontend

WORKDIR /app/frontend
EXPOSE 5173

CMD ["npm", "run", "dev"]
