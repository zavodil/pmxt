FROM node:22-slim

WORKDIR /app

# Install deps first (cache-friendly). tsx is a devDependency and is needed at runtime.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

EXPOSE 8080

# migrate (idempotent) then serve
CMD ["sh", "-c", "npm run migrate && npm run start"]

HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://localhost:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
