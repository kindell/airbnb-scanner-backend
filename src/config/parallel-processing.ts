/**
 * Configuration for Gmail API parallel processing optimization
 */

export interface ParallelProcessingConfig {
  enabled: boolean;
  batchSize: number;
  delayMs: number;
  maxConcurrency: number;
}

// Default configuration respecting Gmail API rate limits
export const DEFAULT_PARALLEL_CONFIG: ParallelProcessingConfig = {
  enabled: true,              // Enable parallel processing by default
  batchSize: 10,             // Process 10 emails concurrently (conservative)
  delayMs: 100,              // 100ms delay between batches for rate limiting
  maxConcurrency: 10         // Maximum concurrent API calls
};

// Aggressive configuration for faster processing (use with caution)
export const AGGRESSIVE_PARALLEL_CONFIG: ParallelProcessingConfig = {
  enabled: true,
  batchSize: 6,              // Process 6 emails concurrently (reduced from 10)
  delayMs: 50,               // 50ms delay between batches
  maxConcurrency: 6          // Higher concurrency (reduced from 10)
};

// Conservative configuration for rate limit safety
export const CONSERVATIVE_PARALLEL_CONFIG: ParallelProcessingConfig = {
  enabled: true,
  batchSize: 5,              // Process 5 emails concurrently
  delayMs: 200,              // 200ms delay between batches  
  maxConcurrency: 5          // Lower concurrency for safety
};

/**
 * Get parallel processing config based on environment
 */
export function getParallelProcessingConfig(): ParallelProcessingConfig {
  const env = process.env.NODE_ENV || 'development';
  const configOverride = process.env.GMAIL_PARALLEL_CONFIG;
  
  // Allow environment override
  if (configOverride) {
    switch (configOverride.toLowerCase()) {
      case 'aggressive':
        console.log('🚀 Using AGGRESSIVE parallel processing config');
        return AGGRESSIVE_PARALLEL_CONFIG;
      case 'conservative':  
        console.log('🐌 Using CONSERVATIVE parallel processing config');
        return CONSERVATIVE_PARALLEL_CONFIG;
      case 'disabled':
        console.log('❌ Parallel processing DISABLED');
        return { ...DEFAULT_PARALLEL_CONFIG, enabled: false };
      default:
        console.log('📊 Using DEFAULT parallel processing config');
        return DEFAULT_PARALLEL_CONFIG;
    }
  }
  
  // Development = aggressive, production = conservative
  if (env === 'development') {
    console.log('🚀 Development mode: Using AGGRESSIVE parallel processing');
    return AGGRESSIVE_PARALLEL_CONFIG;
  } else {
    console.log('🐌 Production mode: Using CONSERVATIVE parallel processing');
    return CONSERVATIVE_PARALLEL_CONFIG;
  }
}

/**
 * Calculate expected performance improvement
 */
export function calculatePerformanceImprovement(config: ParallelProcessingConfig, emailCount: number): {
  estimatedTimeSeconds: number;
  improvementFactor: number;
  originalTimeSeconds: number;
} {
  // Original sequential processing: ~1.5s per email
  const originalTimeSeconds = emailCount * 1.5;
  
  if (!config.enabled) {
    return {
      estimatedTimeSeconds: originalTimeSeconds,
      improvementFactor: 1,
      originalTimeSeconds
    };
  }
  
  // Calculate batch processing time
  const batchCount = Math.ceil(emailCount / config.batchSize);
  const batchProcessingTime = batchCount * 1.5; // 1.5s per batch (parallel within batch)
  const delayTime = (batchCount - 1) * (config.delayMs / 1000); // Delays between batches
  
  const estimatedTimeSeconds = batchProcessingTime + delayTime;
  const improvementFactor = originalTimeSeconds / estimatedTimeSeconds;
  
  return {
    estimatedTimeSeconds,
    improvementFactor,
    originalTimeSeconds
  };
}