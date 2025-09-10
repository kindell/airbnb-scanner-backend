export interface EmailHeaders {
  [key: string]: string | undefined;
  subject?: string;
  from?: string;
  date?: string;
}

export interface GmailEmailData {
  id: string;
  threadId: string;
  payload?: {
    headers?: Array<{ name: string; value: string }>;
    body?: { data?: string };
    parts?: Array<{
      mimeType: string;
      body?: { data?: string };
      parts?: Array<{
        mimeType: string;
        body?: { data?: string };
      }>;
    }>;
  };
}

export interface BookingData {
  emailId: string;
  confirmationCode: string;
  guestName?: string;
  checkInDate?: string;
  checkOutDate?: string;
  nights?: number;
  
  // Financial data in EUR
  guestTotalEur?: number;
  hostEarningsEur?: number;
  cleaningFeeEur?: number;
  serviceFeeEur?: number;
  occupancyTaxEur?: number;
  
  // Financial data in SEK
  guestTotalSek?: number;
  hostEarningsSek?: number;
  cleaningFeeSek?: number;
  serviceFeeSek?: number;
  occupancyTaxSek?: number;
  
  // Tax information
  hasTaxes?: boolean;
  hostEarningsBeforeTaxEur?: number;
  hostEarningsAfterTaxEur?: number;
  cleaningFeeBeforeTaxEur?: number;
  cleaningFeeAfterTaxEur?: number;
  vatRate?: number;
  taxDetails?: string;
  
  // Exchange rate
  exchangeRate?: number;
  
  // Property info
  propertyName?: string;
  
  // Metadata
  gmailId?: string;
  gmailThreadId?: string;
  emailDate?: Date;
  aiModel?: string;
  confidence?: number;
  
  // Guest rating
  guestRating?: number;
  ratingDate?: Date;
  
  rawEmailContent?: string;
}

export interface PayoutData {
  emailId: string;
  amountSek?: number;
  amountEur?: number;
  payoutDate?: string;
  description?: string;
  
  // Metadata
  gmailId?: string;
  gmailThreadId?: string;
  emailDate?: Date;
  aiModel?: string;
  confidence?: number;
}

export interface User {
  id: number;
  email: string;
  googleId?: string | null;
  displayName?: string | null;
  profilePicture?: string | null;
  settings?: string | null; // JSON string
  createdAt?: Date;
  updatedAt?: Date;
  
  // Gmail tokens
  gmailAccessToken?: string | null;
  gmailRefreshToken?: string | null;
  gmailTokenExpiry?: Date | null;
}