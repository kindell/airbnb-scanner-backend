# Gmail Search Query Analysis

## Current Query (too restrictive):
```
from:automated@airbnb.com (subject:"bokning bekräftad" OR subject:"booking confirmed" OR subject:"reservation confirmed") after:2025/1/1 before:2025/12/31
```

## Problems:
- Only catches 3 specific subject lines
- Misses other confirmation variations
- Ignores other Airbnb email types that might contain booking codes

## Suggested Improved Queries:

### Option 1: Broader Subject Search
```
from:automated@airbnb.com (
  subject:"bokning bekräftad" OR 
  subject:"booking confirmed" OR 
  subject:"reservation confirmed" OR
  subject:"Your reservation is confirmed" OR
  subject:"Booking request accepted" OR
  subject:"confirmed" OR
  subject:"bekräftad"
) after:2025/1/1 before:2025/12/31
```

### Option 2: All Airbnb Emails (recommended for testing)
```
from:automated@airbnb.com after:2025/1/1 before:2025/12/31
```

### Option 3: Include Different Senders
```
(from:automated@airbnb.com OR from:noreply@airbnb.com OR from:notifications@airbnb.com) 
after:2025/1/1 before:2025/12/31
```

### Option 4: Content-Based Search (most comprehensive)
```
(from:automated@airbnb.com OR from:noreply@airbnb.com OR from:notifications@airbnb.com)
(
  subject:confirmed OR subject:bekräftad OR 
  body:confirmed OR body:bekräftad OR
  subject:reservation OR subject:booking
) after:2025/1/1 before:2025/12/31
```

## Recommendation:
Start with Option 2 (all Airbnb emails) to see the full scope, then narrow down based on what types of emails actually contain booking information.