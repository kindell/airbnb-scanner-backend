-- Migration: Add EmailLink table for storing multiple Gmail links per booking

CREATE TABLE email_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bookingId INTEGER NOT NULL,
    emailType TEXT NOT NULL, -- 'confirmation', 'payout', 'reminder', 'cancellation', 'modification'
    gmailId TEXT NOT NULL,
    gmailThreadId TEXT,
    subject TEXT,
    emailDate DATETIME,
    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    
    FOREIGN KEY (bookingId) REFERENCES bookings (id) ON DELETE CASCADE
);

-- Create unique index to prevent duplicates
CREATE UNIQUE INDEX idx_email_links_unique ON email_links (bookingId, emailType, gmailId);

-- Create index for efficient lookups
CREATE INDEX idx_email_links_booking ON email_links (bookingId);
CREATE INDEX idx_email_links_type ON email_links (emailType);