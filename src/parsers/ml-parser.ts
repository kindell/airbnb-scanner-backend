/**
 * ML Parser Utility Functions
 * ============================
 * 
 * Wrapper functions for ML email parsing used by enrichment system
 */

import { MLEmailParser } from './MLEmailParser';

/**
 * Parse email with ML and return structured data
 */
export async function parseEmailWithML(
  subject: string,
  sender: string,
  body: string,
  userId: number,
  emailDate?: string
): Promise<any> {
  const parser = new MLEmailParser(userId);
  
  const emailData = {
    emailId: '', // Not needed for parsing
    gmailId: '', // Not needed for parsing
    gmailThreadId: '', // Not needed for parsing
    rawEmailContent: body,
    headers: subject || sender ? { subject, from: sender, date: emailDate || '', to: '', messageId: '' } : undefined
  };
  
  // Try parsing as booking email first (includes change requests and modifications)
  console.log(`🔍 parseEmailWithML: Trying parseBookingEmail for subject: "${subject}"`);
  const bookingResult = await parser.parseBookingEmail(emailData);
  if (bookingResult) {
    console.log(`✅ parseEmailWithML: parseBookingEmail succeeded with type: ${bookingResult.emailType}`);
    return bookingResult;
  }
  
  // For payout emails, check if it has a booking code first
  if (subject.toLowerCase().includes('utbetalning') || subject.toLowerCase().includes('payout')) {
    console.log(`🔍 parseEmailWithML: Detected payout email, checking for booking code first`);
    
    // Try parsing as payout notification for booking (has booking code)
    console.log(`🔍 parseEmailWithML: Trying parsePayoutNotificationForBooking`);
    const payoutNotificationResult = await parser.parsePayoutNotificationForBooking(emailData);
    if (payoutNotificationResult) {
      console.log(`✅ parseEmailWithML: parsePayoutNotificationForBooking succeeded`);
      return payoutNotificationResult;
    }
    
    // Fallback to regular payout parsing (no booking code)
    console.log(`🔍 parseEmailWithML: Trying parsePayoutEmail`);
    const payoutResult = await parser.parsePayoutEmail(emailData);
    if (payoutResult) {
      console.log(`✅ parseEmailWithML: parsePayoutEmail succeeded`);
      return payoutResult;
    }
  }
  
  console.log(`❌ parseEmailWithML: All parsing methods failed`);
  return null;
}