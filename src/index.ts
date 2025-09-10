import express from 'express';
import cors from 'cors';
import passport from 'passport';
import dotenv from 'dotenv';
import { createServer } from 'http';

const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
import { configurePassport } from './auth/passport-config';
import authRoutes from './routes/auth';
import apiRoutes from './routes/api';
import bookingStreamRoutes from './routes/booking-stream';
import { sessionManager } from './utils/persistent-session-manager';
import { initializeWebSocket } from './services/websocket-manager';

// Load environment variables
dotenv.config();

// Validate required environment variables
const requiredEnvVars = [
  'JWT_SECRET',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'DATABASE_URL'
];

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`❌ Missing required environment variable: ${envVar}`);
    process.exit(1);
  }
}

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({
  origin: [
    process.env.FRONTEND_URL || 'http://localhost:3000',
    'http://localhost:5174', // React dev server
    'http://localhost:5173'  // Alternative Vite port
  ],
  credentials: true
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Session configuration with persistent SQLite store
app.use(session({
  store: new SQLiteStore({
    db: 'sessions.sqlite',
    dir: './prisma/'
  }),
  secret: process.env.JWT_SECRET!,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
  }
}));

// Initialize Passport with sessions
app.use(passport.initialize());
app.use(passport.session());
configurePassport();

// Initialize persistent session manager (will auto-restore active sessions)
console.log('🔄 Initializing persistent session manager...');

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  });
});

// Routes
app.use('/auth', authRoutes);
app.use('/api/bookings', bookingStreamRoutes);  // Register booking-stream BEFORE api routes
app.use('/api', apiRoutes);

// API info endpoint
app.get('/', (req, res) => {
  res.json({
    name: 'Airbnb Scanner API',
    version: '1.0.0',
    endpoints: {
      health: '/health',
      auth: '/auth/google',
      api: '/api',
      websocket: '/ws'
    }
  });
});

// Error handling middleware
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('❌ Unhandled error:', err);
  res.status(500).json({ 
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({ 
    error: 'Not Found',
    path: req.originalUrl 
  });
});

// Create HTTP server and initialize WebSocket
const server = createServer(app);

// Initialize WebSocket server
const wsManager = initializeWebSocket(server);

// Start server
server.listen(PORT, () => {
  console.log(`🚀 Airbnb Scanner SaaS API running on port ${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/health`);
  console.log(`🔐 Google OAuth: http://localhost:${PORT}/auth/google`);
  console.log(`📖 API docs: http://localhost:${PORT}/`);
  console.log(`🔌 WebSocket server: ws://localhost:${PORT}/ws`);
  
  if (process.env.NODE_ENV === 'development') {
    console.log(`🛠️  Development mode enabled`);
  }
});