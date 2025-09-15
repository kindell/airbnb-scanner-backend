# Airbnb Scanner Backend

A powerful Node.js/Express backend API for scanning and analyzing Airbnb booking emails from Gmail, extracting financial data, and providing real-time updates via WebSocket.

## 🚀 Features

### Email Processing & AI Extraction
- **Gmail Integration**: OAuth2 authentication for secure Gmail access
- **ML-Powered Parsing**: Python-based AI classifier for extracting booking data
- **Smart Email Filtering**: Optimized search queries for booking confirmations, cancellations, and payouts
- **Real-time Processing**: Live progress updates via WebSocket and Server-Sent Events

### Advanced Booking Management
- **Enrichment Engine**: Automatically analyzes booking statuses and changes
- **Change Detection**: Tracks modifications, cancellations, and rebookings
- **Status Management**: Automatic categorization (confirmed, cancelled, past guest, etc.)
- **Financial Tracking**: Multi-currency support with automatic EUR/SEK conversion

### Real-time Communication
- **WebSocket Support**: Live updates for booking creation, status changes, and progress
- **SSE Streaming**: Server-Sent Events for real-time scan progress
- **Progress Tracking**: Detailed progress bars with enrichment status

## 🏗️ Architecture

### Core Components

```
src/
├── routes/
│   └── api.ts              # Main API endpoints and SSE routes
├── services/
│   ├── email-processor.ts  # Unified email processing with inline enrichment
│   └── gmail-client.ts     # Gmail API wrapper and email fetching
├── utils/
│   ├── booking-enricher.ts # Advanced booking analysis and status detection
│   └── websocket-manager.ts# WebSocket connection management
├── auth/
│   └── passport-config.ts  # Google OAuth2 configuration
├── database/
│   └── client.ts           # Prisma database client
└── ml/
    └── ml_classifier_bridge.py # Python AI classifier for email parsing
```

### Database Schema (SQLite via Prisma)

- **Users**: OAuth user profiles and Gmail tokens
- **Bookings**: Complete booking data with enrichment status
- **ScanningSession**: Processing progress and metadata
- **EmailLinks**: Email-to-booking relationships
- **BookingPayoutMatches**: Financial matching logic
- **ProcessingLogs**: Detailed operation logs

## 🛠️ Development Setup

### Prerequisites
- Node.js 18+
- Python 3.8+
- Gmail API credentials

### Installation

```bash
# Install dependencies
npm install

# Setup Python ML dependencies
pip install -r ml/requirements.txt

# Generate Prisma client
npx prisma generate

# Create database
npx prisma db push

# Start development server
npm run dev
```

### Environment Configuration

Create `.env` file:

```env
# Database
DATABASE_URL="file:./dev.db"

# JWT Secret
JWT_SECRET="your-super-secret-jwt-key"

# Google OAuth2 (Gmail API)
GOOGLE_CLIENT_ID="your-google-client-id"
GOOGLE_CLIENT_SECRET="your-google-client-secret"
GOOGLE_REDIRECT_URI="http://localhost:3000/auth/google/callback"

# Frontend URL
FRONTEND_URL="http://localhost:5173"
```

## 📡 API Endpoints

### Authentication
- `GET /auth/google` - Google OAuth login
- `GET /auth/google/callback` - OAuth callback

### Scanning & Processing
- `POST /api/scan-year` - Start email scan for specific year
- `GET /api/process-year/:year` - SSE stream for real-time scanning
- `GET /api/scanning-status/:userId` - Get current scan status
- `POST /api/rescan-booking` - Re-analyze specific booking

### Data Retrieval
- `GET /api/bookings` - List bookings with filtering and pagination
- `GET /api/payouts` - List payouts with matching
- `GET /api/user` - Get user profile

### WebSocket Events
- `booking_created` - New booking discovered
- `booking_updated` - Booking status/data changed
- `progress` - Scan progress updates
- `scan_status` - Overall scanning status

## 🤖 ML Email Processing

The system uses a sophisticated Python-based AI classifier:

### Features
- **Multi-language Support**: Handles Swedish and English Airbnb emails
- **High Accuracy**: 94%+ confidence in data extraction
- **Comprehensive Extraction**: Dates, amounts, guest names, booking codes
- **Currency Handling**: Automatic EUR/SEK detection and conversion

### Email Types Supported
- Booking confirmations (`booking_confirmation`)
- Cancellations (`cancellation`, `guest_cancellation`)
- Modifications (`booking_modification`)
- Payouts (`payout`)

## 🔄 Enrichment Process

Advanced booking analysis pipeline:

### Phase 1: Discovery
- Search Gmail for booking confirmation emails
- Extract basic booking data via ML parser
- Create initial booking records

### Phase 2: Enrichment
- Find related emails (cancellations, modifications)
- Analyze booking changes over time
- Determine final status (confirmed/cancelled/modified)
- Link payout information

### Phase 3: Status Determination
```typescript
// Status logic
if (hasCancellation) return 'cancelled';
if (hasModifications) return 'modified'; 
if (checkInDate < now) return 'past_guest';
return 'confirmed';
```

## 🚦 Real-time Progress Tracking

### Progress Updates
The system provides detailed progress information:

```javascript
{
  status: 'progress',
  processed: 15,
  total: 29,
  progress: 51.7,
  message: '📧 Processing email 15/29',
  currentBooking: 'HMXQHZHRAW'
}
```

### WebSocket Integration
All progress updates are broadcast via WebSocket for live UI updates.

## 🔧 Production Deployment

### Railway Deployment
1. Connect GitHub repository
2. Set environment variables
3. Deploy automatically on push

### Environment Variables (Production)
```env
DATABASE_URL="postgresql://..." # Railway provides this
JWT_SECRET="production-secret"
GOOGLE_CLIENT_ID="prod-client-id"
GOOGLE_CLIENT_SECRET="prod-secret"
GOOGLE_REDIRECT_URI="https://your-railway-app.up.railway.app/auth/google/callback"
FRONTEND_URL="https://your-frontend-url.com"
```

## 🧪 Testing

```bash
# Run tests
npm test

# Test ML classifier
python ml/test_classifier.py

# Test specific booking
node debug-booking-email.js BOOKING_CODE
```

## 📊 Performance

### Optimizations
- **Parallel Processing**: Multiple emails processed concurrently
- **Smart Caching**: Reduced Gmail API calls
- **Incremental Updates**: Only process new/changed data
- **Connection Pooling**: Efficient database connections

### Typical Performance
- **Processing Speed**: ~20-30 emails/minute
- **Accuracy**: 94%+ for data extraction
- **Memory Usage**: ~100MB for typical scans
- **Database Size**: ~1MB per 100 bookings

## 🔍 Debugging

### Logging
The system provides comprehensive logging:
- `📧` Email processing
- `🤖` ML classifier results  
- `🔍` Enrichment progress
- `📊` Progress updates
- `💾` Database operations

### Debug Scripts
- `debug-booking-email.js` - Test individual booking processing
- `verify-2025-scan.js` - Compare scan results with CSV data

## 🚨 Error Handling

### ML Parser Failures
- Automatic retry with exponential backoff
- Fallback to regex-based extraction
- Detailed error logging with email context

### Gmail API Limits
- Rate limiting protection
- Token refresh automation
- Graceful degradation

### Database Errors
- Transaction rollbacks
- Connection recovery
- Data consistency checks

## 🤝 Contributing

1. Fork the repository
2. Create feature branch: `git checkout -b feature/amazing-feature`
3. Commit changes: `git commit -m 'Add amazing feature'`
4. Push to branch: `git push origin feature/amazing-feature`
5. Open Pull Request

## 📝 Recent Updates

### v2.1.0 - ML Performance & Reliability (September 2024)
- ✅ **Circuit Breaker Pattern**: Intelligent failure handling in ML worker pool
- ✅ **Resource Management**: Memory limits (512MB per worker) and process optimization
- ✅ **Batch Processing Improvements**: Reduced batch size to 20 emails for better performance
- ✅ **Duplicate Prevention**: Track enriched bookings to prevent redundant processing
- ✅ **Two-Phase Enrichment**: Pre-scan batches for accurate progress reporting
- ✅ **Railway Deployment Fix**: Improved Dockerfile for reliable container builds

### v2.0.0 - EmailProcessor Refactoring
- ✅ Unified email processing architecture
- ✅ Inline enrichment during scanning
- ✅ Real-time progress bar updates
- ✅ Fixed WebSocket progress broadcasting
- ✅ Improved error handling and logging
- ✅ Better date parsing and conversion

### Performance Improvements
- ML worker pool now handles failures gracefully with automatic circuit breaking
- Reduced memory footprint through better process management
- More accurate progress tracking with pre-scanning phase
- Optimized batch sizes for Gmail API rate limits

### Bug Fixes
- Fixed progress bar not showing during enrichment
- Resolved timeout issues with long-running scans
- Corrected date parsing for 2025/2026 bookings
- Fixed scanning status API for server restarts
- Eliminated duplicate enrichment processing

## 📄 License

Private project - All rights reserved.