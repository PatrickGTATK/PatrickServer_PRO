FROM node:18

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# Não define ENV PORT
# Não define EXPOSE

CMD ["node", "PatrickLiveServer_MULTI.js"]
