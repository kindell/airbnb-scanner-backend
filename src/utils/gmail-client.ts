import { google } from 'googleapis';
import { prisma } from '../database/client';
import { User } from '../types';

export interface GmailMessage {
  id: string;
  threadId: string;
  snippet: string;
  payload: any;
  internalDate: string;
  raw?: string; // Base64 encoded raw email content (optional fallback)
}

/**
 * Gmail API client with OAuth2 authentication
 */
export class GmailClient {
  private oauth2Client: any;
  private userId: number;

  constructor(user: User) {
    this.userId = user.id;
    this.oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_CALLBACK_URL
    );

    // Set user's tokens
    if (user.gmailAccessToken && user.gmailRefreshToken) {
      this.oauth2Client.setCredentials({
        access_token: user.gmailAccessToken,
        refresh_token: user.gmailRefreshToken,
        expiry_date: user.gmailTokenExpiry?.getTime()
      });
    }
  }

  /**
   * Get Gmail API instance
   */
  private getGmail() {
    return google.gmail({ version: 'v1', auth: this.oauth2Client });
  }

  /**
   * Search for emails with query (with retry logic)
   */
  async searchEmails(query: string, maxResults: number = 50): Promise<string[]> {
    return this.retryWithBackoff(async () => {
      const gmail = this.getGmail();
      
      const response = await gmail.users.messages.list({
        userId: 'me',
        q: query,
        maxResults
      });

      return response.data.messages?.map(msg => msg.id!) || [];
    }, `searchEmails("${query.substring(0, 50)}...")`);
  }

  /**
   * Get full email by ID with retry logic for network issues
   */
  async getEmail(messageId: string): Promise<GmailMessage> {
    return this.retryWithBackoff(async () => {
      const gmail = this.getGmail();
      
      // First try to get full format
      const response = await gmail.users.messages.get({
        userId: 'me',
        id: messageId,
        format: 'full'
      });

      // If payload is empty or has no useful content, try raw format as fallback
      const message = response.data as GmailMessage;
      if (!message.payload?.body?.data && !message.payload?.parts) {
        try {
          const rawResponse = await gmail.users.messages.get({
            userId: 'me',
            id: messageId,
            format: 'raw'
          });
          
          // Combine full format with raw data for content extraction
          (message as any).raw = rawResponse.data.raw;
        } catch (rawError) {
          console.log('Could not fetch raw format, using full format only');
        }
      }

      return message;
    }, `getEmail(${messageId})`);
  }

  /**
   * Retry logic with exponential backoff for network issues and rate limits
   */
  private async retryWithBackoff<T>(
    fn: () => Promise<T>,
    operation: string,
    maxRetries: number = 3,
    baseDelay: number = 1000
  ): Promise<T> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error: any) {
        // Handle authentication errors first
        if (error.code === 401) {
          console.log('🔄 Token expired, attempting refresh...');
          await this.refreshTokens();
          return fn(); // Retry once after token refresh
        }

        // Check if this is a retryable error
        const isRetryable = 
          error.code === 429 || // Rate limit
          error.code === 503 || // Service unavailable
          error.code === 502 || // Bad gateway
          error.code === 500 || // Internal server error
          error.code === 'ENOTFOUND' || // DNS issues
          error.code === 'ECONNRESET' || // Connection reset
          error.message?.includes('getaddrinfo ENOTFOUND'); // DNS resolution failed

        if (!isRetryable || attempt === maxRetries) {
          console.error(`❌ ${operation} failed after ${attempt} attempts:`, error.message);
          throw error;
        }

        const delay = baseDelay * Math.pow(2, attempt - 1) + Math.random() * 1000; // Jitter
        console.log(`⚠️ ${operation} failed (attempt ${attempt}/${maxRetries}): ${error.message}. Retrying in ${Math.round(delay)}ms...`);
        
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    throw new Error('This should never be reached');
  }

  /**
   * Search for Airbnb booking confirmation emails
   */
  async searchAirbnbBookingEmails(year?: number): Promise<string[]> {
    // OPTIMIZED: Only search for booking confirmations to get booking codes
    // All other emails (payouts, reminders, changes) will be fetched during enrichment
    let query = 'from:automated@airbnb.com';
    query += ' (subject:"bokning bekräftad" OR subject:"booking confirmed" OR subject:"reservation confirmed")';
    
    if (year) {
      query += ` after:${year}/1/1 before:${year}/12/31`;
    }

    console.log(`🔍 OPTIMIZED search - booking confirmations only: ${query}`);
    return this.searchEmails(query, 500);
  }

  /**
   * Search for Airbnb payout emails
   */
  async searchAirbnbPayoutEmails(year?: number): Promise<string[]> {
    let query = 'from:automated@airbnb.com OR from:noreply@airbnb.com OR from:express@airbnb.com';
    query += ' (subject:payout OR subject:utbetalning OR "payment sent" OR "betalning skickad" OR "utbetalning på" OR "kr skickades")';
    
    if (year) {
      query += ` after:${year}/1/1 before:${year}/12/31`;
    }

    console.log(`💰 Searching Gmail for payouts: ${query}`);
    return this.searchEmails(query, 200);
  }

  /**
   * Search for Airbnb booking emails from payout notifications
   * These contain booking codes but are payout emails, not booking confirmations
   */
  async searchAirbnbPayoutNotificationEmails(year?: number): Promise<string[]> {
    let query = 'from:express@airbnb.com';
    query += ' (subject:"utbetalning på" AND subject:"kr skickades")';
    
    if (year) {
      query += ` after:${year}/1/1 before:${year}/12/31`;
    }

    console.log(`💳 Searching Gmail for payout notifications with booking codes: ${query}`);
    return this.searchEmails(query, 500);
  }

  /**
   * Refresh expired tokens
   */
  private async refreshTokens(): Promise<void> {
    try {
      const { credentials } = await this.oauth2Client.refreshAccessToken();
      
      // Update tokens in OAuth2 client
      this.oauth2Client.setCredentials(credentials);
      
      // Save new tokens to database
      const userId = this.getCurrentUserId();
      await prisma.user.update({
        where: { id: userId },
        data: {
          gmailAccessToken: credentials.access_token,
          gmailRefreshToken: credentials.refresh_token || undefined,
          gmailTokenExpiry: credentials.expiry_date ? new Date(credentials.expiry_date) : null,
          updatedAt: new Date()
        }
      });
      
      console.log('✅ Gmail tokens refreshed successfully');
    } catch (error) {
      console.error('❌ Failed to refresh Gmail tokens:', error);
      throw new Error('Gmail authentication failed. User needs to re-authenticate.');
    }
  }

  /**
   * Get current user ID
   */
  private getCurrentUserId(): number {
    return this.userId;
  }

  /**
   * Check if user has valid Gmail access
   */
  async hasValidAccess(): Promise<boolean> {
    try {
      const gmail = this.getGmail();
      await gmail.users.getProfile({ userId: 'me' });
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Get user's Gmail profile info
   */
  async getProfile(): Promise<any> {
    try {
      const gmail = this.getGmail();
      const response = await gmail.users.getProfile({ userId: 'me' });
      return response.data;
    } catch (error: any) {
      if (error.code === 401) {
        await this.refreshTokens();
        return this.getProfile();
      }
      throw error;
    }
  }
}