/**
 * Enhanced Gmail Search for Change Requests
 * =========================================
 * 
 * Advanced search strategies to find missing change request emails
 * using guest names, dates, and comprehensive keyword patterns.
 */

import { GmailClient } from './gmail-client';

export interface BookingSearchData {
  bookingCode: string;
  guestName: string;
  checkInDate: string;  // YYYY-MM-DD
  checkOutDate: string; // YYYY-MM-DD
}

export class EnhancedGmailSearcher {
  private gmailClient: GmailClient;

  constructor(gmailClient: GmailClient) {
    this.gmailClient = gmailClient;
  }

  /**
   * Comprehensive search for change request emails
   */
  async searchForChangeRequests(booking: BookingSearchData): Promise<{
    strategy: string;
    query: string;
    emailIds: string[];
  }[]> {
    console.log(`🔍 Enhanced search for change requests - ${booking.bookingCode} (${booking.guestName})`);
    
    const searchStrategies = [
      await this.searchByBookingCodeAndChangeTerms(booking),
      await this.searchByGuestNameAndChangeTerms(booking),
      await this.searchByDateRangeAndGuestName(booking),
      await this.searchByPartialGuestNameAndModificationTerms(booking),
      await this.searchBySwedishChangePatterns(booking),
      await this.searchByEmailThreads(booking)
    ];

    const results = searchStrategies.filter(result => result.emailIds.length > 0);
    
    console.log(`📊 Search results: ${results.length}/${searchStrategies.length} strategies found emails`);
    results.forEach(result => {
      console.log(`   ${result.strategy}: ${result.emailIds.length} emails`);
    });

    return searchStrategies;
  }

  /**
   * Strategy 1: Booking code + change terms
   */
  private async searchByBookingCodeAndChangeTerms(booking: BookingSearchData) {
    const changeTerms = [
      'vill ändra',
      'change request',
      'ändra sin bokning',
      'uppdaterad',
      'updated',
      'modified',
      'godkänts',
      'har uppdaterats'
    ];
    
    const query = `(from:automated@airbnb.com OR from:noreply@airbnb.com OR from:express@airbnb.com) ` +
                  `${booking.bookingCode} ` +
                  `(${changeTerms.map(term => `"${term}"`).join(' OR ')})`;

    const emailIds = await this.gmailClient.searchEmails(query, 20);
    
    return {
      strategy: 'Booking Code + Change Terms',
      query,
      emailIds
    };
  }

  /**
   * Strategy 2: Guest name + change terms
   */
  private async searchByGuestNameAndChangeTerms(booking: BookingSearchData) {
    const firstName = booking.guestName.split(' ')[0];
    const changeTerms = [
      'vill ändra',
      'change request',
      'har uppdaterats',
      'updated',
      'ändra sin bokning'
    ];
    
    const query = `(from:automated@airbnb.com OR from:noreply@airbnb.com OR from:express@airbnb.com) ` +
                  `"${firstName}" ` +
                  `(${changeTerms.map(term => `"${term}"`).join(' OR ')})`;

    const emailIds = await this.gmailClient.searchEmails(query, 30);
    
    return {
      strategy: 'Guest Name + Change Terms',
      query,
      emailIds
    };
  }

  /**
   * Strategy 3: Date range around booking + guest name
   */
  private async searchByDateRangeAndGuestName(booking: BookingSearchData) {
    const firstName = booking.guestName.split(' ')[0];
    
    // Search 60 days before check-in to 30 days after check-out
    const checkInDate = new Date(booking.checkInDate);
    const searchStart = new Date(checkInDate.getTime() - 60 * 24 * 60 * 60 * 1000);
    const searchEnd = new Date(booking.checkOutDate);
    searchEnd.setDate(searchEnd.getDate() + 30);
    
    const startStr = `${searchStart.getFullYear()}/${searchStart.getMonth() + 1}/${searchStart.getDate()}`;
    const endStr = `${searchEnd.getFullYear()}/${searchEnd.getMonth() + 1}/${searchEnd.getDate()}`;
    
    const query = `(from:automated@airbnb.com OR from:noreply@airbnb.com OR from:express@airbnb.com) ` +
                  `"${firstName}" ` +
                  `after:${startStr} before:${endStr} ` +
                  `(ändra OR change OR uppdaterad OR updated OR modified)`;

    const emailIds = await this.gmailClient.searchEmails(query, 25);
    
    return {
      strategy: 'Date Range + Guest Name',
      query,
      emailIds
    };
  }

  /**
   * Strategy 4: Partial guest name + modification terms
   */
  private async searchByPartialGuestNameAndModificationTerms(booking: BookingSearchData) {
    const firstName = booking.guestName.split(' ')[0];
    const lastName = booking.guestName.split(' ')[1] || '';
    
    const modificationTerms = [
      'Din bokning',
      'Your booking', 
      'bokning har',
      'booking has been',
      'reservation har',
      'ombokning',
      'rebooking'
    ];
    
    const query = `(from:automated@airbnb.com OR from:noreply@airbnb.com OR from:express@airbnb.com) ` +
                  `("${firstName}" OR "${lastName}") ` +
                  `(${modificationTerms.map(term => `"${term}"`).join(' OR ')})`;

    const emailIds = await this.gmailClient.searchEmails(query, 25);
    
    return {
      strategy: 'Partial Guest Name + Modification Terms',
      query,
      emailIds
    };
  }

  /**
   * Strategy 5: Swedish-specific change patterns
   */
  private async searchBySwedishChangePatterns(booking: BookingSearchData) {
    const firstName = booking.guestName.split(' ')[0];
    
    // Specific Swedish patterns for Airbnb change requests
    const swedishPatterns = [
      `${firstName} vill ändra`,
      `Din bokning med ${firstName}`,
      `${firstName} har ändrat`,
      'ändring av bokning',
      'bokningsändring',
      'ombokning',
      'förändring av bokning'
    ];
    
    const query = `(from:automated@airbnb.com OR from:noreply@airbnb.com OR from:express@airbnb.com) ` +
                  `(${swedishPatterns.map(pattern => `"${pattern}"`).join(' OR ')})`;

    const emailIds = await this.gmailClient.searchEmails(query, 20);
    
    return {
      strategy: 'Swedish Change Patterns',
      query,
      emailIds
    };
  }

  /**
   * Strategy 6: Email thread exploration
   */
  private async searchByEmailThreads(booking: BookingSearchData) {
    // Look for any emails mentioning the booking code and then search their threads
    const query = `(from:automated@airbnb.com OR from:noreply@airbnb.com OR from:express@airbnb.com) ` +
                  `${booking.bookingCode}`;

    const emailIds = await this.gmailClient.searchEmails(query, 10);
    
    return {
      strategy: 'Email Thread Exploration',
      query,
      emailIds
    };
  }

  /**
   * Generate comprehensive search report
   */
  async generateSearchReport(booking: BookingSearchData): Promise<{
    totalEmailsFound: number;
    uniqueEmailIds: string[];
    strategySummary: Array<{
      strategy: string;
      emailsFound: number;
      query: string;
    }>;
  }> {
    const searchResults = await this.searchForChangeRequests(booking);
    
    // Collect all unique email IDs
    const allEmailIds = searchResults.flatMap(result => result.emailIds);
    const uniqueEmailIds = [...new Set(allEmailIds)];
    
    const strategySummary = searchResults.map(result => ({
      strategy: result.strategy,
      emailsFound: result.emailIds.length,
      query: result.query
    }));
    
    return {
      totalEmailsFound: uniqueEmailIds.length,
      uniqueEmailIds,
      strategySummary
    };
  }

  /**
   * Smart date-based search around original booking confirmation
   */
  async searchAroundConfirmationDate(booking: BookingSearchData, confirmationDate: Date): Promise<{
    beforeEmails: string[];
    afterEmails: string[];
  }> {
    const firstName = booking.guestName.split(' ')[0];
    
    // Search 30 days before and after confirmation
    const beforeStart = new Date(confirmationDate.getTime() - 30 * 24 * 60 * 60 * 1000);
    const afterEnd = new Date(confirmationDate.getTime() + 30 * 24 * 60 * 60 * 1000);
    
    const beforeQuery = `(from:automated@airbnb.com OR from:noreply@airbnb.com) ` +
                       `"${firstName}" ` +
                       `(ändra OR change OR uppdaterad OR updated) ` +
                       `after:${beforeStart.getFullYear()}/${beforeStart.getMonth() + 1}/${beforeStart.getDate()} ` +
                       `before:${confirmationDate.getFullYear()}/${confirmationDate.getMonth() + 1}/${confirmationDate.getDate()}`;
    
    const afterQuery = `(from:automated@airbnb.com OR from:noreply@airbnb.com) ` +
                      `"${firstName}" ` +
                      `(ändra OR change OR uppdaterad OR updated) ` +
                      `after:${confirmationDate.getFullYear()}/${confirmationDate.getMonth() + 1}/${confirmationDate.getDate()} ` +
                      `before:${afterEnd.getFullYear()}/${afterEnd.getMonth() + 1}/${afterEnd.getDate()}`;
    
    const beforeEmails = await this.gmailClient.searchEmails(beforeQuery, 15);
    const afterEmails = await this.gmailClient.searchEmails(afterQuery, 15);
    
    return {
      beforeEmails,
      afterEmails
    };
  }
}