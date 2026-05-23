/**
 * ============================================================================
 * Cockroach — S3 Media Service (AWS SDK v3)
 * ============================================================================
 * Presigned URL pattern — client uploads/downloads directly to S3,
 * keeping EC2 server load minimal.
 *
 * Features:
 *  - Presigned PUT URLs for client-side uploads (max 50MB, 15min expiry)
 *  - Presigned GET URLs for secure media reads (1hr expiry)
 *  - Content-type validation (images, videos only)
 *  - Organized key structure: media/{userId}/{type}/{uuid}.{ext}
 *  - Delete support for content moderation
 *
 * Dependencies: @aws-sdk/client-s3, @aws-sdk/s3-request-presigner, crypto
 * ============================================================================
 */

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import crypto from 'crypto';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

let _s3Client: S3Client | null = null;
let _bucket: string | null = null;

/** Lazy S3 client — created on first use, after dotenv has loaded */
function getS3Client(): S3Client {
  if (!_s3Client) {
    const region = process.env.AWS_REGION || 'ap-south-1';
    _s3Client = new S3Client({
      region,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
      },
    });
  }
  return _s3Client;
}

function getBucket(): string {
  if (!_bucket) {
    _bucket = process.env.AWS_S3_BUCKET_NAME || '';
    if (!_bucket) {
      throw new Error('[FATAL] AWS_S3_BUCKET_NAME must be set in environment variables.');
    }
  }
  return _bucket;
}

function getRegion(): string {
  return process.env.AWS_REGION || 'ap-south-1';
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const UPLOAD_EXPIRY_SECONDS = 900;      // 15 minutes
const DOWNLOAD_EXPIRY_SECONDS = 3600;   // 1 hour
const MAX_UPLOAD_SIZE = 50 * 1024 * 1024; // 50 MB

/** Allowed MIME types for upload */
const ALLOWED_MIME_TYPES: Record<string, string[]> = {
  image: ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'],
  video: ['video/mp4', 'video/webm', 'video/quicktime'],
  avatar: ['image/jpeg', 'image/png', 'image/webp'],
};

type MediaCategory = keyof typeof ALLOWED_MIME_TYPES;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PresignedUploadResult {
  uploadUrl: string;
  key: string;
  expiresIn: number;
  maxSize: number;
  publicUrl: string;
}

export interface PresignedDownloadResult {
  downloadUrl: string;
  expiresIn: number;
}

// ---------------------------------------------------------------------------
// Key Generation
// ---------------------------------------------------------------------------

/**
 * Build an organized S3 key: media/{userId}/{category}/{uuid}.{ext}
 * The UUID prevents filename collisions and hides original filenames.
 */
function buildMediaKey(
  userId: string,
  category: MediaCategory,
  originalFilename: string,
): string {
  const ext = originalFilename.split('.').pop()?.toLowerCase() || 'bin';
  const uuid = crypto.randomUUID();
  return `media/${userId}/${category}/${uuid}.${ext}`;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateMimeType(contentType: string, category: MediaCategory): boolean {
  const allowed = ALLOWED_MIME_TYPES[category];
  return allowed ? allowed.includes(contentType.toLowerCase()) : false;
}

// ---------------------------------------------------------------------------
// Presigned Upload URL
// ---------------------------------------------------------------------------

/**
 * Generate a presigned PUT URL for client-side direct upload to S3.
 *
 * The client receives this URL and performs a PUT request with the file body.
 * Server never touches the file bytes — keeps EC2 load minimal.
 */
export async function generateUploadUrl(
  userId: string,
  category: MediaCategory,
  originalFilename: string,
  contentType: string,
  fileSizeBytes?: number,
): Promise<PresignedUploadResult> {
  // Validate content type
  if (!validateMimeType(contentType, category)) {
    throw new Error(
      `Invalid content type "${contentType}" for category "${category}". ` +
      `Allowed: ${ALLOWED_MIME_TYPES[category]?.join(', ')}`,
    );
  }

  // Validate file size (if provided by client)
  if (fileSizeBytes && fileSizeBytes > MAX_UPLOAD_SIZE) {
    throw new Error(
      `File size ${(fileSizeBytes / 1024 / 1024).toFixed(1)}MB exceeds maximum ${MAX_UPLOAD_SIZE / 1024 / 1024}MB`,
    );
  }

  const key = buildMediaKey(userId, category, originalFilename);

  const command = new PutObjectCommand({
    Bucket: getBucket(),
    Key: key,
    ContentType: contentType,
    ContentLength: fileSizeBytes,
    Metadata: {
      'uploaded-by': userId,
      'category': category,
      'original-name': encodeURIComponent(originalFilename.slice(0, 255)),
    },
  });

  const uploadUrl = await getSignedUrl(getS3Client(), command, {
    expiresIn: UPLOAD_EXPIRY_SECONDS,
  });

  const publicUrl = `https://${getBucket()}.s3.${getRegion()}.amazonaws.com/${key}`;

  return {
    uploadUrl,
    key,
    expiresIn: UPLOAD_EXPIRY_SECONDS,
    maxSize: MAX_UPLOAD_SIZE,
    publicUrl,
  };
}

// ---------------------------------------------------------------------------
// Presigned Download URL
// ---------------------------------------------------------------------------

/**
 * Generate a presigned GET URL for secure media reads.
 * Use this for private/unlisted content. For public media,
 * use the CloudFront CDN URL directly instead.
 */
export async function generateDownloadUrl(
  key: string,
  expiresIn: number = DOWNLOAD_EXPIRY_SECONDS,
): Promise<PresignedDownloadResult> {
  const command = new GetObjectCommand({
    Bucket: getBucket(),
    Key: key,
  });

  const downloadUrl = await getSignedUrl(getS3Client(), command, { expiresIn });

  return { downloadUrl, expiresIn };
}

// ---------------------------------------------------------------------------
// Delete Object
// ---------------------------------------------------------------------------

/**
 * Delete a media object from S3.
 * Used for content moderation, account deletion, or user-initiated removal.
 */
export async function deleteMedia(key: string): Promise<void> {
  const command = new DeleteObjectCommand({
    Bucket: getBucket(),
    Key: key,
  });

  await getS3Client().send(command);
}

// ---------------------------------------------------------------------------
// Check if Object Exists
// ---------------------------------------------------------------------------

/**
 * Verify a media object exists in S3 before referencing it in posts.
 * Returns content metadata or null if not found.
 */
export async function getMediaMetadata(
  key: string,
): Promise<{ contentType: string; contentLength: number; lastModified: Date } | null> {
  try {
    const command = new HeadObjectCommand({
      Bucket: getBucket(),
      Key: key,
    });

    const response = await getS3Client().send(command);

    return {
      contentType: response.ContentType || 'application/octet-stream',
      contentLength: response.ContentLength || 0,
      lastModified: response.LastModified || new Date(),
    };
  } catch (err: unknown) {
    const e = err as { name?: string };
    if (e.name === 'NotFound' || e.name === 'NoSuchKey') return null;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Batch Upload URLs (for multi-media posts like Instagram grids)
// ---------------------------------------------------------------------------

export interface BatchUploadRequest {
  originalFilename: string;
  contentType: string;
  fileSizeBytes?: number;
}

/**
 * Generate presigned upload URLs for multiple files at once.
 * Used when creating Instagram-style multi-image posts.
 * Maximum 10 files per batch.
 */
export async function generateBatchUploadUrls(
  userId: string,
  category: MediaCategory,
  files: BatchUploadRequest[],
): Promise<PresignedUploadResult[]> {
  const MAX_BATCH = 10;
  if (files.length > MAX_BATCH) {
    throw new Error(`Maximum ${MAX_BATCH} files per batch upload`);
  }

  const results = await Promise.all(
    files.map((file) =>
      generateUploadUrl(userId, category, file.originalFilename, file.contentType, file.fileSizeBytes),
    ),
  );

  return results;
}
