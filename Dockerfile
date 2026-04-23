FROM node:18

# Força o sistema a instalar o Chrome e todas as suas ferramentas invisíveis
RUN apt-get update && apt-get install -y \
    chromium \
    libglib2.0-0 \
    libnss3 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdrm2 \
    libdbus-1-3 \
    libxcb1 \
    libxkbcommon0 \
    libx11-6 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libcairo2 \
    libasound2

# Cria a pasta do robô
WORKDIR /app

# Instala as ferramentas do Node.js
COPY package*.json ./
RUN npm install

# Copia o seu código
COPY . .

# Liga o robô
CMD ["node", "index.js"]
