# Use Playwright's official image which includes browsers
FROM mcr.microsoft.com/playwright:v1.52.0-jammy

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --omit=dev

# Copy application code
COPY server.js ./

# Expose the port
EXPOSE 3000

# Run as non-root user (already created in playwright image)
USER pwuser

# Start the server
CMD ["node", "server.js"]
