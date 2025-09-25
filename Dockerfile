# ---- 1. Base image with Node ----
FROM node:18-bullseye

# ---- 2. Set environment variables ----


# ---- 3. Install FFmpeg ----
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

# ---- 4. Set working directory ----
WORKDIR /app

# ---- 5. Copy package files first (better cache) ----
COPY package*.json ./

# ---- 6. Install dependencies ----
RUN npm install --production

# ---- 7. Copy the rest of your code ----
COPY . .

# ---- 8. Expose port & run ----
EXPOSE 3000
CMD ["node", "server.js"]
