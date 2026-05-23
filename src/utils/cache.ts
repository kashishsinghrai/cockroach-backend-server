/**
 * High-performance In-Memory Cache System
 * Protects database from high traffic spikes.
 */

interface CacheEntry {
  value: any;
  expiry: number;
}

class CacheSystem {
  private cache = new Map<string, CacheEntry>();

  /**
   * Set a value in the cache with a specific Time-To-Live (TTL) in seconds.
   */
  set(key: string, value: any, ttlSeconds: number = 30): void {
    const expiry = Date.now() + ttlSeconds * 1000;
    this.cache.set(key, { value, expiry });
  }

  /**
   * Get a value from the cache. Returns null if missing or expired.
   */
  get(key: string): any | null {
    const entry = this.cache.get(key);
    if (!entry) return null;

    if (Date.now() > entry.expiry) {
      this.cache.delete(key);
      return null;
    }

    return entry.value;
  }

  /**
   * Clear the cache for a specific key (useful for manual invalidation)
   */
  del(key: string): void {
    this.cache.delete(key);
  }

  /**
   * Clear the entire cache
   */
  clear(): void {
    this.cache.clear();
  }
}

// Export a singleton instance
export const cacheUtil = new CacheSystem();
