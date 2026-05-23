/**
 * ============================================================================
 * Cockroach — Server Entry Point
 * ============================================================================
 * Boot sequence:
 *  1. Load .env via dotenv (MUST happen before anything else)
 *  2. Connect to MongoDB Atlas
 *  3. Start Express HTTP server
 *  4. Register graceful shutdown handlers
 *
 * IMPORTANT: We use dynamic import() for ./app so that dotenv.config()
 * runs FIRST. Static `import` statements are hoisted by the JS engine
 * and execute before any top-level code, which would cause modules
 * like crypto.ts to read undefined env vars and crash silently.
 * ============================================================================
 */

// Step 1: Load environment variables BEFORE any other module
import dotenv from 'dotenv';
const envResult = dotenv.config();

if (envResult.error) {
  console.error('[STARTUP] Warning: Could not load .env file:', envResult.error.message);
  console.error('[STARTUP] Continuing with system environment variables...');
}

console.log('[STARTUP] Environment loaded. NODE_ENV =', process.env.NODE_ENV || 'development');

// Step 2: Now import mongoose (no top-level env reads)
import mongoose from 'mongoose';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT || '5000', 10);
const MONGODB_URI = process.env.MONGODB_URI;
const NODE_ENV = process.env.NODE_ENV || 'development';

// ---------------------------------------------------------------------------
// MongoDB Connection
// ---------------------------------------------------------------------------

async function connectDatabase(): Promise<void> {
  if (!MONGODB_URI) {
    console.error('[FATAL] MONGODB_URI is not defined in environment variables.');
    console.error('[FATAL] Create a .env file from .env.example and set MONGODB_URI.');
    process.exit(1);
  }

  console.log('[DB] Connecting to MongoDB Atlas...');

  try {
    await mongoose.connect(MONGODB_URI, {
      maxPoolSize: 10,
      minPoolSize: 2,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
    });

    console.log('[DB] ✅ MongoDB connected successfully');

    mongoose.connection.on('error', (err) => {
      console.error('[DB] Connection error:', err.message);
    });

    mongoose.connection.on('disconnected', () => {
      console.warn('[DB] Disconnected from MongoDB');
    });

    mongoose.connection.on('reconnected', () => {
      console.log('[DB] Reconnected to MongoDB');
    });
  } catch (err) {
    console.error('[FATAL] ❌ Failed to connect to MongoDB:', (err as Error).message);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Start Server
// ---------------------------------------------------------------------------

let server: ReturnType<typeof import('http').createServer> | null = null;

async function startServer(): Promise<void> {
  console.log('[STARTUP] Initializing Cockroach API...');

  // Step 3: Connect to database
  await connectDatabase();

  // Step 4: Dynamic import of app AFTER dotenv has loaded
  // This ensures crypto.ts, s3.service.ts etc. read env vars correctly
  console.log('[STARTUP] Loading Express application...');
  const { default: app } = await import('./app');

  // Step 5: Start HTTP server
  server = app.listen(PORT, '0.0.0.0', async () => {
    // Step 6: Initialize Socket.io
    const { initializeSocket } = await import('./socket');
    initializeSocket(server!);

    console.log('');
    console.log('╔══════════════════════════════════════════════════╗');
    console.log('║         🪳  COCKROACH API SERVER  🪳              ║');
    console.log('╠══════════════════════════════════════════════════╣');
    console.log(`║  Status  : ✅ Running                            ║`);
    console.log(`║  Port    : ${String(PORT).padEnd(37)}║`);
    console.log(`║  Env     : ${NODE_ENV.padEnd(37)}║`);
    console.log(`║  Health  : http://localhost:${PORT}/health              ║`);
    console.log('╚══════════════════════════════════════════════════╝');
    console.log('');
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[FATAL] ❌ Port ${PORT} is already in use.`);
      process.exit(1);
    }
    console.error('[FATAL] Server error:', err.message);
    throw err;
  });
}

// ---------------------------------------------------------------------------
// Graceful Shutdown
// ---------------------------------------------------------------------------

async function gracefulShutdown(signal: string): Promise<void> {
  console.log(`\n[SHUTDOWN] Received ${signal}. Starting graceful shutdown...`);

  if (server) {
    await new Promise<void>((resolve) => {
      server!.close(() => {
        console.log('[SHUTDOWN] HTTP server closed.');
        resolve();
      });
    });
  }

  try {
    await mongoose.connection.close();
    console.log('[SHUTDOWN] MongoDB connection closed.');
  } catch (err) {
    console.error('[SHUTDOWN] Error closing MongoDB:', (err as Error).message);
  }

  console.log('[SHUTDOWN] ✅ Graceful shutdown complete.');
  process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

process.on('uncaughtException', (err: Error) => {
  console.error('[FATAL] Uncaught Exception:', err.message);
  console.error(err.stack);
  process.exit(1);
});

process.on('unhandledRejection', (reason: unknown) => {
  console.error('[FATAL] Unhandled Rejection:', reason);
  process.exit(1);
});

// ---------------------------------------------------------------------------
// Boot!
// ---------------------------------------------------------------------------

startServer().catch((err) => {
  console.error('[FATAL] Failed to start server:', err);
  process.exit(1);
});
