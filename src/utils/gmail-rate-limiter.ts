/**
 * Gmail Rate Limiter
 * =================
 * 
 * Håller koll på Gmail API requests och säkerställer att vi inte överskrider rate limits.
 * Begränsar till max 1 request per sekund för att undvika 429-fel och timeouts.
 */

export class GmailRateLimiter {
  private static instance: GmailRateLimiter;
  private queue: Array<{
    fn: () => Promise<any>;
    resolve: (value: any) => void;
    reject: (error: any) => void;
  }> = [];
  private isProcessing = false;
  private lastRequestTime = 0;
  private readonly MIN_INTERVAL = 1000; // 1 second between requests

  static getInstance(): GmailRateLimiter {
    if (!GmailRateLimiter.instance) {
      GmailRateLimiter.instance = new GmailRateLimiter();
    }
    return GmailRateLimiter.instance;
  }

  /**
   * Queue a Gmail API request with rate limiting
   */
  async queueRequest<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
      // Check if already aborted
      if (signal?.aborted) {
        reject(new Error('Request aborted before queuing'));
        return;
      }
      
      // Add abort listener
      const abortListener = () => {
        reject(new Error('Request aborted'));
        // Remove from queue if still waiting
        const index = this.queue.findIndex(item => item.resolve === resolve);
        if (index !== -1) {
          this.queue.splice(index, 1);
        }
      };
      
      signal?.addEventListener('abort', abortListener, { once: true });
      
      this.queue.push({ 
        fn, 
        resolve: (value) => {
          signal?.removeEventListener('abort', abortListener);
          resolve(value);
        }, 
        reject: (error) => {
          signal?.removeEventListener('abort', abortListener);
          reject(error);
        }
      });
      this.processQueue();
    });
  }

  private async processQueue(): Promise<void> {
    if (this.isProcessing || this.queue.length === 0) {
      return;
    }

    this.isProcessing = true;

    while (this.queue.length > 0) {
      const { fn, resolve, reject } = this.queue.shift()!;

      try {
        // Enforce rate limiting - wait if necessary
        const timeSinceLastRequest = Date.now() - this.lastRequestTime;
        if (timeSinceLastRequest < this.MIN_INTERVAL) {
          const waitTime = this.MIN_INTERVAL - timeSinceLastRequest;
          console.log(`🐌 [RATE LIMIT] Waiting ${waitTime}ms before next Gmail request (queue: ${this.queue.length})`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }

        console.log(`📡 [RATE LIMIT] Making Gmail API request (queue: ${this.queue.length})`);
        this.lastRequestTime = Date.now();

        const result = await fn();
        resolve(result);
      } catch (error) {
        reject(error);
      }
    }

    this.isProcessing = false;
  }

  /**
   * Get current queue status
   */
  getStatus() {
    return {
      queueLength: this.queue.length,
      isProcessing: this.isProcessing,
      lastRequestTime: this.lastRequestTime
    };
  }
}

export const gmailRateLimiter = GmailRateLimiter.getInstance();