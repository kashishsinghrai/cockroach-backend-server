import { Request, Response, NextFunction } from 'express';

/**
 * Recursively mutate objects to prevent NoSQL Injection in-place.
 * Removes any keys that start with '$' (e.g. $gt, $ne).
 */
const inPlaceSanitizeNoSql = (obj: any): void => {
  if (obj === null || typeof obj !== 'object') return;
  
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      if (typeof obj[i] === 'object') {
        inPlaceSanitizeNoSql(obj[i]);
      }
    }
  } else {
    for (const key in obj) {
      if (key.startsWith('$')) {
        delete obj[key];
      } else if (typeof obj[key] === 'object') {
        inPlaceSanitizeNoSql(obj[key]);
      }
    }
  }
};

export const noSqlInjectionSanitizer = (req: Request, res: Response, next: NextFunction): void => {
  inPlaceSanitizeNoSql(req.body);
  inPlaceSanitizeNoSql(req.query);
  inPlaceSanitizeNoSql(req.params);
  next();
};

/**
 * Basic XSS Sanitizer.
 * In a real-world scenario, you might want to use a robust library like DOMPurify.
 * Here we simply strip out dangerous tags from strings.
 */
const stripXss = (str: string): string => {
  return str
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '') // Remove <script> tags
    .replace(/onload=|onerror=|javascript:/gi, ''); // Remove inline event handlers
};

const inPlaceSanitizeXss = (obj: any): void => {
  if (obj === null || typeof obj !== 'object') return;
  
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      if (typeof obj[i] === 'string') {
        obj[i] = stripXss(obj[i]);
      } else if (typeof obj[i] === 'object') {
        inPlaceSanitizeXss(obj[i]);
      }
    }
  } else {
    for (const key in obj) {
      if (typeof obj[key] === 'string') {
        obj[key] = stripXss(obj[key]);
      } else if (typeof obj[key] === 'object') {
        inPlaceSanitizeXss(obj[key]);
      }
    }
  }
};

export const xssSanitizer = (req: Request, res: Response, next: NextFunction): void => {
  inPlaceSanitizeXss(req.body);
  inPlaceSanitizeXss(req.query);
  inPlaceSanitizeXss(req.params);
  next();
};

/**
 * Prevent HTTP Parameter Pollution (HPP).
 * Express parses multiple query parameters of the same name into an array.
 * This can crash logic expecting a string. This middleware takes the last value.
 */
export const hppSanitizer = (req: Request, res: Response, next: NextFunction): void => {
  if (req.query) {
    for (const key in req.query) {
      if (Array.isArray(req.query[key])) {
        const arr = req.query[key] as any[];
        req.query[key] = arr[arr.length - 1]; // Take the last supplied parameter
      }
    }
  }
  next();
};
