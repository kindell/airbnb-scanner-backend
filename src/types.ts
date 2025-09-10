export interface User {
  id: number;
  email: string;
  googleId: string | null;
  displayName: string | null;
  profilePicture: string | null;
  settings: string | null;
  createdAt: Date;
  updatedAt: Date;
  gmailAccessToken: string | null;
  gmailRefreshToken: string | null;
  gmailTokenExpiry: Date | null;
}

export interface GmailEmailData {
  emailId: string;
  rawEmailContent: string;
  gmailId: string;
  gmailThreadId: string;
  headers?: EmailHeaders;
}

export interface EmailHeaders {
  from: string;
  to: string;
  subject: string;
  date: string;
  messageId: string;
}

export interface BookingData {
  emailId: string;
  rawEmailContent: string;
  gmailId: string;
  gmailThreadId: string;
  bookingCode: string; // Changed from confirmationCode to match database
  emailType?: 'booking_confirmation' | 'booking_reminder' | 'cancellation' | 'change_request' | 'modification' | 'payout';
  guestName?: string;
  checkInDate?: string;
  checkOutDate?: string;
  nights?: number;
  guestTotalEur?: number;
  guestTotalSek?: number;
  hostEarningsEur?: number;
  hostEarningsSek?: number;
  cleaningFeeEur?: number;
  cleaningFeeSek?: number;
  serviceFeeEur?: number;
  serviceFeeSek?: number;
  propertyName?: string;
  hasTaxes?: boolean;
  hostEarningsBeforeTaxEur?: number;
  hostEarningsAfterTaxEur?: number;
  cleaningFeeBeforeTaxEur?: number;
  cleaningFeeAfterTaxEur?: number;
  vatRate?: number;
  taxDetails?: string;
  status?: string | null; // 'processed', 'cancelled', 'cancelled_with_payout', 'modified'
}

export interface PayoutData {
  emailId: string;
  rawEmailContent: string;
  gmailId: string;
  gmailThreadId: string;
  payoutId?: string;
  emailType?: 'payout';
  amount: number;
  currency: string;
  amountSek?: number;
  exchangeRate?: number;
  payoutDate: string;
}