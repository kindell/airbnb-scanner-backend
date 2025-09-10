import { prisma } from '../database/client';

export interface EmailLinkData {
  bookingId: number;
  emailType: 'confirmation' | 'payout' | 'reminder' | 'cancellation' | 'modification';
  gmailId: string;
  gmailThreadId?: string;
  subject?: string;
  emailDate?: Date;
}

/**
 * EmailLink Manager - Handles storing and retrieving Gmail links for different email types
 */
export class EmailLinkManager {
  
  /**
   * Add or update email link for a booking
   */
  static async addEmailLink(data: EmailLinkData): Promise<void> {
    try {
      await prisma.emailLink.upsert({
        where: {
          bookingId_emailType_gmailId: {
            bookingId: data.bookingId,
            emailType: data.emailType,
            gmailId: data.gmailId
          }
        },
        create: {
          bookingId: data.bookingId,
          emailType: data.emailType,
          gmailId: data.gmailId,
          gmailThreadId: data.gmailThreadId,
          subject: data.subject,
          emailDate: data.emailDate
        },
        update: {
          gmailThreadId: data.gmailThreadId,
          subject: data.subject,
          emailDate: data.emailDate
        }
      });
      
      console.log(`📧 Saved ${data.emailType} email link: ${data.gmailId} for booking ${data.bookingId}`);
    } catch (error) {
      console.error(`❌ Failed to save email link:`, error);
    }
  }

  /**
   * Add email link by booking code (finds booking first)
   */
  static async addEmailLinkByBookingCode(
    userId: number, 
    bookingCode: string, 
    emailType: EmailLinkData['emailType'],
    gmailId: string,
    gmailThreadId?: string,
    subject?: string,
    emailDate?: Date
  ): Promise<void> {
    try {
      // Find booking by code
      const booking = await prisma.booking.findUnique({
        where: {
          userId_bookingCode: {
            userId,
            bookingCode
          }
        }
      });

      if (!booking) {
        console.warn(`⚠️ Booking ${bookingCode} not found, cannot save email link`);
        return;
      }

      await this.addEmailLink({
        bookingId: booking.id,
        emailType,
        gmailId,
        gmailThreadId,
        subject,
        emailDate
      });

    } catch (error) {
      console.error(`❌ Failed to add email link by booking code:`, error);
    }
  }

  /**
   * Get all email links for a booking
   */
  static async getEmailLinksForBooking(bookingId: number): Promise<any[]> {
    try {
      return await prisma.emailLink.findMany({
        where: { bookingId },
        orderBy: { createdAt: 'desc' }
      });
    } catch (error) {
      console.error(`❌ Failed to get email links for booking ${bookingId}:`, error);
      return [];
    }
  }

  /**
   * Get email links by type for a booking
   */
  static async getEmailLinksByType(
    bookingId: number, 
    emailType: EmailLinkData['emailType']
  ): Promise<any[]> {
    try {
      return await prisma.emailLink.findMany({
        where: { 
          bookingId,
          emailType 
        },
        orderBy: { createdAt: 'desc' }
      });
    } catch (error) {
      console.error(`❌ Failed to get ${emailType} email links:`, error);
      return [];
    }
  }

  /**
   * Check if email link already exists
   */
  static async emailLinkExists(
    bookingId: number,
    emailType: EmailLinkData['emailType'],
    gmailId: string
  ): Promise<boolean> {
    try {
      const existing = await prisma.emailLink.findUnique({
        where: {
          bookingId_emailType_gmailId: {
            bookingId,
            emailType,
            gmailId
          }
        }
      });
      return !!existing;
    } catch (error) {
      console.error(`❌ Failed to check email link existence:`, error);
      return false;
    }
  }

  /**
   * Generate Gmail URLs for email links
   */
  static generateGmailUrls(emailLinks: any[]): { [key: string]: string[] } {
    const urls: { [key: string]: string[] } = {};
    
    for (const link of emailLinks) {
      if (!urls[link.emailType]) {
        urls[link.emailType] = [];
      }
      
      urls[link.emailType].push(`https://mail.google.com/mail/u/0/#inbox/${link.gmailId}`);
    }
    
    return urls;
  }
}