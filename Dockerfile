FROM node:lts-bullseye-slim

WORKDIR /app

# Salin package.json dan package-lock.json
COPY package*.json ./

# Install dependencies dan PM2
RUN apt-get update && apt-get install -y \
  wget \
  ca-certificates \
  fonts-liberation \
  libappindicator3-1 \
  libasound2 \
  libatk-bridge2.0-0 \
  libatk1.0-0 \
  libcups2 \
  libglib2.0-0 \
  libgdk-pixbuf2.0-0 \
  libnspr4 \
  libnss3 \
  libx11-xcb1 \
  libxcomposite1 \
  libxdamage1 \
  libxrandr2 \
  xdg-utils \
  libgbm1 \
  qpdf && \
  apt-get clean && rm -rf /var/lib/apt/lists/* && \
  npm install -g pm2 && \
  npm install

# Copy semua file aplikasi
COPY . .

# Expose port yang digunakan aplikasi (sesuaikan dengan aplikasi Anda)
EXPOSE 3000

# Set environment variable NODE_ENV ke production
ENV NODE_ENV=production

# Menjalankan aplikasi dengan PM2
CMD ["pm2-runtime", "index.js"]
