/**
 * ============================================================================
 * Cockroach — Express Application
 * ============================================================================
 * Initializes the Express app with:
 *  - Security headers (Helmet)
 *  - CORS (strict origin whitelist)
 *  - JSON body parsing (with 1MB limit to prevent payload attacks)
 *  - Request logging (Morgan)
 *  - API route mounting
 *  - Global error handler (never leaks stack traces)
 *
 * Dependencies: express, helmet, cors, morgan
 * ============================================================================
 */

import express, { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import { noSqlInjectionSanitizer, xssSanitizer, hppSanitizer } from './middleware/security';

// Route imports
import authRoutes from './routes/auth.routes';
import postRoutes from './routes/post.routes';
import userRoutes from './routes/user.routes';
import searchRoutes from './routes/search.routes';
import notificationRoutes from './routes/notification.routes';
import supportRoutes from './routes/support.routes';
import adminRoutes from './routes/admin.routes';
import storyRoutes from './routes/story.routes';

// ---------------------------------------------------------------------------
// Initialize Express
// ---------------------------------------------------------------------------

const app = express();

console.log('[APP] Initializing Express middleware...');

// ---------------------------------------------------------------------------
// Security Headers — Helmet
// ---------------------------------------------------------------------------

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https://*.amazonaws.com'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameSrc: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false, // Allow S3 image loading
    hsts: {
      maxAge: 31536000, // 1 year
      includeSubDomains: true,
      preload: true,
    },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  }),
);

// ---------------------------------------------------------------------------
// CORS — Strict Origin Whitelist
// ---------------------------------------------------------------------------

const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || 'http://localhost:3000')
  .split(',')
  .map((origin) => origin.trim());

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (mobile apps, Postman, curl)
      if (!origin) return callback(null, true);
      
      // Allow any localhost port for development (Flutter Web uses random ports)
      if (origin.startsWith('http://localhost:')) {
        return callback(null, true);
      }

      if (ALLOWED_ORIGINS.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error(`Origin ${origin} not allowed by CORS`));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Device-Id',  // Flutter device fingerprint header
      'X-Request-Id', // Request tracing
    ],
    exposedHeaders: [
      'RateLimit-Limit',
      'RateLimit-Remaining',
      'RateLimit-Reset',
    ],
    maxAge: 86400, // Preflight cache: 24 hours
  }),
);

// ---------------------------------------------------------------------------
// Rate Limiting (High Traffic & DDoS Protection)
// ---------------------------------------------------------------------------

// Global rate limit: 1000 requests per 15 minutes per IP
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, 
  max: 1000,
  message: { message: 'Too many requests from this IP, please try again after 15 minutes' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(globalLimiter);

// ---------------------------------------------------------------------------
// Body Parsing & Core Security Sanitization
// ---------------------------------------------------------------------------

app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ extended: true, limit: '500mb' }));

// Apply security sanitizers AFTER body parsers
app.use(noSqlInjectionSanitizer);
app.use(xssSanitizer);
app.use(hppSanitizer);

// ---------------------------------------------------------------------------
// Request Logging
// ---------------------------------------------------------------------------

const LOG_FORMAT = process.env.NODE_ENV === 'production' ? 'combined' : 'dev';
app.use(morgan(LOG_FORMAT));

// ---------------------------------------------------------------------------
// Trust Proxy — required for rate limiter behind AWS ALB/Nginx
// ---------------------------------------------------------------------------

app.set('trust proxy', 1);

// ---------------------------------------------------------------------------
// Health Check
// ---------------------------------------------------------------------------

app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({
    success: true,
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// Apply a stricter rate limit to authentication routes
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // 20 requests per 15 minutes
  message: { message: 'Too many authentication attempts, please try again later' },
});

app.use('/api/auth', authLimiter, authRoutes);

app.use('/api/posts', postRoutes);
console.log('[APP] Routes mounted: /api/posts');

app.use('/api/users', userRoutes);
console.log('[APP] Routes mounted: /api/users');

app.use('/api/search', searchRoutes);
console.log('[APP] Routes mounted: /api/search');

app.use('/api/notifications', notificationRoutes);
console.log('[APP] Routes mounted: /api/notifications');

app.use('/api/support', supportRoutes);
console.log('[APP] Routes mounted: /api/support');

app.use('/api/admin', adminRoutes);
console.log('[APP] Routes mounted: /api/admin');

app.use('/api/stories', storyRoutes);
console.log('[APP] Routes mounted: /api/stories');

// ---------------------------------------------------------------------------
// 404 Handler
// ---------------------------------------------------------------------------

app.use((_req: Request, res: Response) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found',
  });
});

// ---------------------------------------------------------------------------
// Global Error Handler — MUST be last middleware (4 params required)
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error & { statusCode?: number; status?: number }, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[ERROR]', {
    message: err.message,
    stack: process.env.NODE_ENV === 'production' ? undefined : err.stack,
  });

  // CORS errors
  if (err.message?.includes('not allowed by CORS')) {
    res.status(403).json({ success: false, error: 'CORS policy violation' });
    return;
  }

  // Generic response — never leak stack traces in production
  const statusCode = err.statusCode || err.status || 500;
  const message = statusCode === 500 ? 'Internal server error' : err.message || 'Something went wrong';

  res.status(statusCode).json({
    success: false,
    error: message,
    ...(process.env.NODE_ENV !== 'production' && { stack: err.stack }),
  });
});

console.log('[APP] Express app initialized successfully.');

export default app;
