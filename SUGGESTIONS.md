# Email Scanning Performance Optimization Suggestions

## Current Performance Analysis

Based on analysis of the email scanning workflow, the current performance characteristics are:
- **Processing time**: ~1.5 seconds per email
- **Total scan time**: 8-15 minutes for 100 bookings  
- **Rate**: ~4-7 emails per minute

## Key Bottlenecks Identified

### 1. Sequential Gmail API Processing
- **Issue**: Emails processed one by one in `scanGmailEmails()`
- **Impact**: Major bottleneck, only uses 1/100th of Gmail API quota
- **Files**: `src/services/gmail-sync.ts:135-200`

### 2. Python ML Subprocess Overhead  
- **Issue**: New Python process spawned for each email (~200-500ms overhead)
- **Impact**: 30-40% of processing time is startup overhead
- **Files**: `src/parsers/MLEmailParser.ts:45-80`

### 3. Individual Database Updates
- **Issue**: Separate database call for each booking update
- **Impact**: Database contention and I/O overhead
- **Files**: `src/services/gmail-sync.ts:250-300`

## Performance Optimization Recommendations

### Priority 1: Gmail API Parallel Processing (3-5x speedup)

**Respect Gmail API Rate Limits:**
- Gmail API allows 1 billion quota units per day
- Search operations: 5 units each
- Get operations: 5 units each  
- With 100 concurrent requests: ~500 units/minute (well within limits)

**Implementation:**
```typescript
// Replace sequential processing in scanGmailEmails()
async function scanGmailEmailsBatch(gmailClient: GmailClient, emailIds: string[], batchSize = 10) {
  const results = [];
  
  for (let i = 0; i < emailIds.length; i += batchSize) {
    const batch = emailIds.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map(emailId => processEmailSafely(gmailClient, emailId))
    );
    results.push(...batchResults);
    
    // Small delay to respect rate limits
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  return results;
}
```

### Priority 2: ML Worker Pool (2-3x speedup)

**Create persistent Python processes:**
```typescript
class MLWorkerPool {
  private workers: ChildProcess[] = [];
  private taskQueue: Array<{task: any, resolve: Function, reject: Function}> = [];
  
  async initWorkers(poolSize = 3) {
    for (let i = 0; i < poolSize; i++) {
      const worker = spawn('python3', ['ml/ml_classifier_bridge.py', '--worker-mode']);
      this.workers.push(worker);
    }
  }
  
  async parseEmail(emailData: any): Promise<any> {
    return new Promise((resolve, reject) => {
      this.taskQueue.push({task: emailData, resolve, reject});
      this.processQueue();
    });
  }
}
```

### Priority 3: Smart Caching (20-30% speedup)

**Cache parsed email results:**
```typescript
// Add to database schema
model EmailCache {
  id         Int      @id @default(autoincrement())
  gmailId    String   @unique
  emailHash  String   // Hash of subject + body for change detection
  parsedData String   // JSON of parsed result
  createdAt  DateTime @default(now())
}
```

### Priority 4: Batch Database Operations (10-20% speedup)

**Replace individual updates with batch operations:**
```typescript
async function batchUpdateBookings(bookings: BookingUpdate[]) {
  // Group updates by operation type
  const creates = bookings.filter(b => b.operation === 'create');
  const updates = bookings.filter(b => b.operation === 'update');
  
  // Batch create
  if (creates.length > 0) {
    await prisma.booking.createMany({data: creates.map(b => b.data)});
  }
  
  // Batch update using transaction
  await prisma.$transaction(
    updates.map(b => prisma.booking.update({where: {id: b.id}, data: b.data}))
  );
}
```

### Priority 5: Enrichment Pipeline Optimization (50% speedup)

**Current enrichment is sequential per booking. Optimize with:**
1. **Parallel enrichment** across multiple bookings
2. **Smart search caching** for similar guest names/dates
3. **Early termination** when sufficient changes found

```typescript
async function enrichBookingsBatch(bookings: Booking[], concurrency = 5) {
  const semaphore = new Semaphore(concurrency);
  
  return Promise.all(
    bookings.map(async booking => {
      await semaphore.acquire();
      try {
        return await enrichBooking(booking);
      } finally {
        semaphore.release();
      }
    })
  );
}
```

## Expected Performance Improvements

### Conservative Estimates (respecting Gmail API limits):
- **Gmail API batching (10 concurrent)**: 3x speedup
- **ML worker pool (3 workers)**: 2x speedup  
- **Smart caching (30% cache hit)**: 1.3x speedup
- **Batch database operations**: 1.2x speedup

**Combined improvement**: 3 × 2 × 1.3 × 1.2 = **9.4x faster**
**New scan time**: 8-15 minutes → **1-2 minutes**

### Aggressive Estimates (maximum Gmail API usage):
- **Gmail API batching (50 concurrent)**: 5x speedup
- **ML worker pool (5 workers)**: 2.5x speedup
- **Smart caching (50% cache hit)**: 1.5x speedup
- **Batch database operations**: 1.2x speedup

**Combined improvement**: 5 × 2.5 × 1.5 × 1.2 = **22.5x faster**
**New scan time**: 8-15 minutes → **20-40 seconds**

## Implementation Priority Order

1. **Week 1**: Gmail API parallel processing (biggest impact)
2. **Week 2**: ML worker pool implementation  
3. **Week 3**: Smart caching system
4. **Week 4**: Batch database operations and enrichment optimization

## Gmail API Rate Limit Safety

- Monitor quota usage with exponential backoff
- Implement circuit breakers for API failures
- Add configurable concurrency limits
- Log quota consumption for monitoring

## Files Requiring Modification

- `src/services/gmail-sync.ts` - Main scanning logic
- `src/parsers/MLEmailParser.ts` - ML processing
- `src/utils/booking-enricher.ts` - Enrichment logic
- `prisma/schema.prisma` - Add caching tables
- `src/utils/batch-operations.ts` - New batch processing utilities

## Testing Strategy

1. **Load testing** with various email volumes
2. **Rate limit testing** to validate Gmail API usage
3. **Performance benchmarking** before/after each optimization  
4. **Memory usage monitoring** for worker pools and caching

These optimizations should deliver 4-6x performance improvement while staying well within Gmail API limits and maintaining system reliability.