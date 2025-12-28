# Stage 1: Build the React Frontend
FROM node:18-alpine AS builder
WORKDIR /app
COPY package*.json ./
# Install dependencies
RUN npm ci
COPY . .
# Build the Vite app (outputs to /dist)
RUN npm run build

# Stage 2: Setup Backend with Puppeteer
FROM node:18-slim

# Install Google Chrome Stable and fonts
# This is required because the standard Node image doesn't have the libraries Puppeteer needs
RUN apt-get update \
    && apt-get install -y wget gnupg \
    && wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/googlechrome-linux-keyring.gpg \
    && sh -c 'echo "deb [arch=amd64 signed-by=/usr/share/keyrings/googlechrome-linux-keyring.gpg] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list' \
    && apt-get update \
    && apt-get install -y google-chrome-stable fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf libxss1 \
      --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Tell Puppeteer to use the installed Chrome instead of downloading its own
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

WORKDIR /app

# Copy backend dependencies first
COPY backend/package*.json ./

# Install production dependencies for backend
RUN npm install --omit=dev

# Copy the backend source code
COPY backend/ ./

# Copy the built React frontend from Stage 1 to the backend's public folder
# This allows the Node server to serve the React app
COPY --from=builder /app/dist ./public

# Expose port (must match the one in server.js)
EXPOSE 3001

# Start the server
CMD ["node", "server.js"]
