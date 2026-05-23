/**
 * ============================================================================
 * Cockroach — Crypto Utilities
 * ============================================================================
 * Centralized security helpers:
 *  - JWT access/refresh token generation & verification (HS256)
 *  - Device fingerprint extraction & hashing
 *  - Secure random token generation
 *
 * Dependencies: jsonwebtoken, crypto (Node built-in)
 * ============================================================================
 */

import jwt, { JwtPayload, SignOptions } from 'jsonwebtoken';
import crypto from 'crypto';
import { Request } from 'express';

// ---------------------------------------------------------------------------
// Environment — fail fast if secrets are missing
// ---------------------------------------------------------------------------

// Lazy getters — these run at call-time (after dotenv.config), not at import-time
function getAccessSecret(): string {
  const secret = process.env.JWT_ACCESS_SECRET;
  if (!secret) throw new Error('[FATAL] JWT_ACCESS_SECRET must be set in environment variables.');
  return secret;
}

function getRefreshSecret(): string {
  const secret = process.env.JWT_REFRESH_SECRET;
  if (!secret) throw new Error('[FATAL] JWT_REFRESH_SECRET must be set in environment variables.');
  return secret;
}

function getAccessExpiry(): string {
  return process.env.ACCESS_TOKEN_EXPIRY || '15m';
}

function getRefreshExpiry(): string {
  return process.env.REFRESH_TOKEN_EXPIRY || '7d';
}

// ---------------------------------------------------------------------------
// Type Definitions
// ---------------------------------------------------------------------------

export interface AccessTokenPayload extends JwtPayload {
  userId: string;
  sessionId: string;
  fingerprint: string;
}

export interface RefreshTokenPayload extends JwtPayload {
  userId: string;
  sessionId: string;
  type: 'refresh';
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

// ---------------------------------------------------------------------------
// JWT — Access Token
// ---------------------------------------------------------------------------

/**
 * Generate a short-lived access token (default: 15 minutes).
 * Embeds userId, sessionId, and device fingerprint for zero-trust binding.
 */
export function generateAccessToken(
  userId: string,
  sessionId: string,
  fingerprint: string,
): string {
  const payload: Omit<AccessTokenPayload, 'iat' | 'exp'> = {
    userId,
    sessionId,
    fingerprint,
  };

  const options: SignOptions = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expiresIn: (process.env.ACCESS_TOKEN_EXPIRY || '15m') as any,
    algorithm: 'HS256',
    issuer: 'cockroach-api',
    audience: 'cockroach-client',
  };

  return jwt.sign(payload, getAccessSecret(), options);
}

/**
 * Verify and decode an access token.
 * Returns the decoded payload or throws on invalid/expired tokens.
 */
export function verifyAccessToken(token: string): AccessTokenPayload {
  return jwt.verify(token, getAccessSecret(), {
    algorithms: ['HS256'],
    issuer: 'cockroach-api',
    audience: 'cockroach-client',
  }) as AccessTokenPayload;
}

// ---------------------------------------------------------------------------
// JWT — Refresh Token
// ---------------------------------------------------------------------------

/**
 * Generate a long-lived refresh token (default: 7 days).
 * Contains minimal claims — userId and sessionId only.
 */
export function generateRefreshToken(
  userId: string,
  sessionId: string,
): string {
  const payload: Omit<RefreshTokenPayload, 'iat' | 'exp'> = {
    userId,
    sessionId,
    type: 'refresh',
  };

  const options: SignOptions = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expiresIn: (process.env.REFRESH_TOKEN_EXPIRY || '7d') as any,
    algorithm: 'HS256',
    issuer: 'cockroach-api',
  };

  return jwt.sign(payload, getRefreshSecret(), options);
}

/**
 * Verify and decode a refresh token.
 * Returns the decoded payload or throws on invalid/expired tokens.
 */
export function verifyRefreshToken(token: string): RefreshTokenPayload {
  const decoded = jwt.verify(token, getRefreshSecret(), {
    algorithms: ['HS256'],
    issuer: 'cockroach-api',
  }) as RefreshTokenPayload;

  if (decoded.type !== 'refresh') {
    throw new Error('Invalid token type: expected refresh token');
  }

  return decoded;
}

/**
 * Generate both access and refresh tokens as a pair.
 */
export function generateTokenPair(
  userId: string,
  sessionId: string,
  fingerprint: string,
): TokenPair {
  return {
    accessToken: generateAccessToken(userId, sessionId, fingerprint),
    refreshToken: generateRefreshToken(userId, sessionId),
  };
}

// ---------------------------------------------------------------------------
// Device Fingerprint
// ---------------------------------------------------------------------------

/**
 * Extract a deterministic device fingerprint from request headers.
 *
 * Combines: User-Agent, Accept-Language, Accept-Encoding, and a
 * client-provided X-Device-Id header (from Flutter's device_info_plus).
 * The composite string is SHA-256 hashed to produce a fixed-length,
 * privacy-respecting identifier.
 *
 * In production, the Flutter client should send `X-Device-Id` with a
 * stable device identifier (e.g., androidId / identifierForVendor).
 */
export function extractDeviceFingerprint(req: Request): string {
  const components = [
    req.headers['user-agent'] || 'unknown-ua',
    req.headers['accept-language'] || 'unknown-lang',
    req.headers['accept-encoding'] || 'unknown-enc',
    req.headers['x-device-id'] || 'unknown-device',
  ];

  const raw = components.join('|');
  return hashSHA256(raw);
}

// ---------------------------------------------------------------------------
// Hashing Utilities
// ---------------------------------------------------------------------------

/**
 * SHA-256 hash a plaintext string.
 * Used for hashing refresh tokens before storage and device fingerprints.
 */
export function hashSHA256(input: string): string {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Generate a cryptographically secure random token.
 * Default: 32 bytes → 64-char hex string.
 */
export function generateSecureToken(bytes: number = 32): string {
  return crypto.randomBytes(bytes).toString('hex');
}

/**
 * Generate a UUID v4 for session identifiers.
 */
export function generateSessionId(): string {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// Client IP Extraction
// ---------------------------------------------------------------------------

/**
 * Extract real client IP, respecting reverse-proxy headers.
 * In production behind AWS ALB/Nginx, X-Forwarded-For is trusted.
 */
export function extractClientIP(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    // Take the first IP in the chain (original client)
    return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress || '0.0.0.0';
}
