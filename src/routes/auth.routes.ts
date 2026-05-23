/**
 * ============================================================================
 * Cockroach — Auth Routes
 * ============================================================================
 * Maps auth endpoints to controller handlers with per-route rate limiting.
 *
 * Rate Limits:
 *   /register  — 5 requests per 15 min per IP (prevent mass account creation)
 *   /login     — 10 requests per 15 min per IP (brute-force protection)
 *   /refresh   — 30 requests per 15 min per IP (allow normal token rotation)
 *   /logout    — 30 requests per 15 min per IP
 *
 * Dependencies: express, express-rate-limit, controllers, middleware
 * ============================================================================
 */

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import {
  register,
  login,
  refreshToken,
  logout,
  logoutAll,
  changePassword,
} from '../controllers/auth.controller';
import { authenticate } from '../middleware/authenticate';

const router = Router();

// ---------------------------------------------------------------------------
// Rate Limiters — per-route, sliding window
// ---------------------------------------------------------------------------

const registerLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,
  standardHeaders: true,    // Return rate limit info in `RateLimit-*` headers
  legacyHeaders: false,     // Disable `X-RateLimit-*` headers
  message: {
    success: false,
    error: 'Too many registration attempts. Please try again later.',
  },
  keyGenerator: (req) => {
    // Rate limit by IP; respects X-Forwarded-For behind reverse proxy
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string') return forwarded.split(',')[0].trim();
    return req.socket.remoteAddress || 'unknown';
  },
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Too many login attempts. Please try again later.',
  },
  keyGenerator: (req) => {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string') return forwarded.split(',')[0].trim();
    return req.socket.remoteAddress || 'unknown';
  },
});

const refreshLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Too many refresh attempts. Please try again later.',
  },
});

const logoutLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Too many requests. Please try again later.',
  },
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// Public routes (no auth required)
router.post('/register', registerLimiter, register);
router.post('/login', loginLimiter, login);
router.post('/refresh', refreshLimiter, refreshToken);

// Protected routes (require valid session)
router.post('/logout', logoutLimiter, authenticate, logout);
router.post('/logout-all', logoutLimiter, authenticate, logoutAll);
router.post('/change-password', authenticate, changePassword);

export default router;
