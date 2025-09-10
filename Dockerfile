# Use Node.js 22 as base image (matching Railway)
FROM node:22-slim

# Install Python and pip
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-venv \
    && rm -rf /var/lib/apt/lists/*

# Create a symlink for python3 to python (optional)
RUN ln -s /usr/bin/python3 /usr/bin/python

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install Node.js dependencies
RUN npm ci --only=production

# Copy Python ML files
COPY ml/ ./ml/

# Install Python dependencies if requirements.txt exists
RUN if [ -f ml/requirements.txt ]; then pip3 install -r ml/requirements.txt; fi

# Copy application code
COPY . .

# Generate Prisma client
RUN npx prisma generate

# Expose port
EXPOSE 3000

# Start command
CMD ["sh", "-c", "npx prisma db push && node dist/index.js"]