# Backend Server

A TypeScript HTTP server built with Express, WebSocket support, and tsx for development.

## Features

- **Express.js** - Fast, unopinionated web framework
- **WebSocket** - Real-time bidirectional communication
- **TypeScript** - Type-safe development
- **tsx** - Fast TypeScript execution for development
- **CORS** - Cross-origin resource sharing enabled
- **Error handling** - Comprehensive error handling middleware
- **Health checks** - Built-in health monitoring endpoint

## Getting Started

### Prerequisites

- Node.js (v16 or higher)
- pnpm (package manager)

### Installation

```bash
cd apps/backend
pnpm install
```

### Development

Start the development server with hot reload:

```bash
npm run dev
```

The server will start on `http://localhost:3001`

### Production

Build the TypeScript code:

```bash
npm run build
```

Start the production server:

```bash
npm start
```

## API Endpoints

### REST API

- `GET /` - Server status and available endpoints
- `GET /health` - Health check endpoint
- `GET /api/users` - Get list of users
- `POST /api/users` - Create a new user
  - Body: `{ "name": "string", "email": "string" }`

### WebSocket

Connect to `ws://localhost:3001` for real-time communication.

#### Message Types

**Welcome Message** (sent on connection):
```json
{
  "type": "welcome",
  "message": "Connected to WebSocket server",
  "timestamp": "2025-01-24T05:25:18.000Z"
}
```

**Echo Response** (sent back when you send a message):
```json
{
  "type": "echo",
  "originalMessage": { "your": "message" },
  "timestamp": "2025-01-24T05:25:18.000Z"
}
```

**Broadcast** (sent to all other connected clients):
```json
{
  "type": "broadcast",
  "message": { "your": "message" },
  "timestamp": "2025-01-24T05:25:18.000Z"
}
```

**Error Response** (sent when invalid JSON is received):
```json
{
  "type": "error",
  "message": "Invalid JSON format",
  "timestamp": "2025-01-24T05:25:18.000Z"
}
```

## Testing the Server

### Test REST API

```bash
# Get server status
curl http://localhost:3001

# Health check
curl http://localhost:3001/health

# Get users
curl http://localhost:3001/api/users

# Create user
curl -X POST http://localhost:3001/api/users \
  -H "Content-Type: application/json" \
  -d '{"name": "John Doe", "email": "john@example.com"}'
```

### Test WebSocket

You can test WebSocket connections using a WebSocket client or browser console:

```javascript
// In browser console
const ws = new WebSocket('ws://localhost:3001');

ws.onopen = () => {
  console.log('Connected to WebSocket');
  ws.send(JSON.stringify({ message: 'Hello Server!' }));
};

ws.onmessage = (event) => {
  console.log('Received:', JSON.parse(event.data));
};

ws.onclose = () => {
  console.log('WebSocket connection closed');
};
```

## Project Structure

```
apps/backend/
├── src/
│   └── app.ts          # Main server file
├── dist/               # Compiled JavaScript (after build)
├── package.json        # Dependencies and scripts
├── tsconfig.json       # TypeScript configuration
└── README.md          # This file
```

## Environment Variables

- `PORT` - Server port (default: 3001)
- `NODE_ENV` - Environment mode (development/production)

## Features Included

- **CORS Support** - Allows cross-origin requests
- **JSON Parsing** - Automatic JSON body parsing
- **URL Encoding** - Support for URL-encoded payloads
- **Error Handling** - Global error handling middleware
- **404 Handling** - Custom 404 responses
- **Graceful Shutdown** - Proper cleanup on SIGTERM/SIGINT
- **WebSocket Ping/Pong** - Keep-alive mechanism
- **Connection Logging** - WebSocket connection tracking
- **Message Broadcasting** - Real-time message distribution

## Development Notes

- Uses `tsx` for fast TypeScript execution during development
- TypeScript strict mode enabled for better type safety
- Automatic server restart on file changes during development
- Comprehensive error logging and handling
- WebSocket connections are automatically cleaned up on disconnect
