#!/usr/bin/env ts-node
/**
 * Enrichment Debug Tool
 * ====================
 * 
 * Test enrichment on a single booking to see exactly what happens:
 * 1. What emails are found
 * 2. Which are already processed
 * 3. How ML parsing works on each email
 * 4. What data is extracted and merged
 */

import { prisma } from '../database/client';
import { GmailClient } from '../utils/gmail-client';
import { BookingEnricher } from '../utils/booking-enricher';
import { parseEmailWithML } from '../parsers/ml-parser';
import { decodeGmailContentForML } from '../utils/email-decoder';

async function testEnrichmentOnBooking(userId: number, bookingCode: string) {
  console.log(`\n🧪 Testing enrichment for booking: ${bookingCode}`);
  console.log(`👤 User ID: ${userId}`);
  
  try {
    // 1. Get user object first
    const user = await prisma.user.findUnique({
      where: { id: userId }
    });
    
    if (!user) {
      console.log(`❌ User ${userId} not found`);
      return;
    }
    
    // 2. Check if we have an existing booking or just test the search
    const booking = await prisma.booking.findUnique({
      where: { 
        userId_bookingCode: { userId, bookingCode } 
      }
    });
    
    if (booking) {
      console.log(`✅ Found existing booking: ${booking.bookingCode} - Guest: ${booking.guestName}`);
      console.log(`   Original data: Check-in: ${booking.checkInDate}, Check-out: ${booking.checkOutDate}`);
      console.log(`   Status: ${booking.status || 'No status'}`);
    } else {
      console.log(`ℹ️  No existing booking found for ${bookingCode}, testing search only`);
    }
    
    // 3. Initialize Gmail client
    const gmailClient = new GmailClient(user);
    
    // 3. Search for emails with same query as enrichment
    const restrictedQuery = `${bookingCode} (from:automated@airbnb.com OR from:noreply@airbnb.com OR from:express@airbnb.com)`;
    console.log(`\n🔍 Enrichment search query: ${restrictedQuery}`);
    
    const restrictedEmailIds = await gmailClient.searchEmails(restrictedQuery, 20);
    console.log(`📧 Found ${restrictedEmailIds.length} emails with restricted query`);
    
    if (restrictedEmailIds.length === 0) {
      console.log(`⚠️ No emails found with restricted query - let's try broader search!`);
      
      // Try broader search to see if emails exist at all
      const broadQuery = `${bookingCode}`;
      console.log(`\n🔍 Broader search query: ${broadQuery}`);
      
      const broadEmailIds = await gmailClient.searchEmails(broadQuery, 20);
      console.log(`📧 Found ${broadEmailIds.length} emails with broader query:`);
      
      if (broadEmailIds.length === 0) {
        console.log(`❌ No emails found even with broad search - booking code may not exist in Gmail`);
        return;
      } else {
        console.log(`✅ Found emails with broader search! The restricted 'from' filter is the problem!`);
        
        // Analyze the senders of found emails
        for (let i = 0; i < Math.min(5, broadEmailIds.length); i++) {
          const emailId = broadEmailIds[i];
          const email = await gmailClient.getEmail(emailId);
          const headers = email.payload?.headers || [];
          const headerMap: any = {};
          
          for (const header of headers) {
            headerMap[header.name.toLowerCase()] = header.value;
          }
          
          console.log(`   📬 Email ${i + 1}: From: ${headerMap.from}, Subject: ${headerMap.subject}`);
        }
      }
    }
    
    const emailIds = restrictedEmailIds.length > 0 ? restrictedEmailIds : [];
    
    if (emailIds.length === 0) {
      console.log(`\n⚠️ Proceeding with empty list to test enrichment anyway...`);
    }
    
    // 4. Analyze each email
    for (let i = 0; i < emailIds.length; i++) {
      const emailId = emailIds[i];
      console.log(`\n📬 Email ${i + 1}/${emailIds.length}: ${emailId}`);
      
      // Check if already processed
      const existingBooking = await prisma.booking.findFirst({
        where: {
          userId: userId,
          gmailId: emailId
        }
      });
      
      if (existingBooking) {
        console.log(`   ⏭️ Already processed as booking: ${existingBooking.bookingCode}`);
        if (existingBooking.bookingCode === bookingCode) {
          console.log(`   🔄 Same booking code - would be skipped in enrichment`);
        } else {
          console.log(`   ⚠️ Different booking code! This might be a related email`);
        }
        continue;
      }
      
      // Get email details
      const email = await gmailClient.getEmail(emailId);
      const headers = email.payload?.headers || [];
      const headerMap: any = {};
      
      for (const header of headers) {
        headerMap[header.name.toLowerCase()] = header.value;
      }
      
      console.log(`   📨 Subject: ${headerMap.subject || 'No subject'}`);
      console.log(`   👤 From: ${headerMap.from || 'Unknown sender'}`);
      console.log(`   📅 Date: ${headerMap.date || 'No date'}`);
      
      // Try to extract and parse content
      try {
        // Extract content using same logic as enricher
        const extractFromPart = (part: any): string => {
          let content = '';
          
          if (part.body?.data) {
            try {
              const decoded = Buffer.from(part.body.data, 'base64').toString('utf-8');
              content += decoded + '\n';
            } catch (e) {
              console.log(`   ⚠️ Failed to decode part ${part.mimeType}: ${e}`);
            }
          }
          
          if (part.parts) {
            for (const subPart of part.parts) {
              content += extractFromPart(subPart);
            }
          }
          
          return content;
        };
        
        let rawContent = '';
        
        // Extract from all parts recursively
        if (email.payload?.parts) {
          for (const part of email.payload.parts) {
            rawContent += extractFromPart(part);
          }
        }
        
        // Fallback: try direct body
        if (!rawContent && email.payload?.body?.data) {
          try {
            rawContent = Buffer.from(email.payload.body.data, 'base64').toString('utf-8');
          } catch (e) {
            console.log(`   ⚠️ Failed to decode direct body: ${e}`);
          }
        }
        
        if (!rawContent.trim()) {
          console.log(`   ❌ Could not extract content from email`);
          continue;
        }
        
        console.log(`   📄 Content length: ${rawContent.length} characters`);
        console.log(`   📄 Content preview: ${rawContent.substring(0, 200)}...`);
        
        // Try ML parsing
        const mlResult = await parseEmailWithML(
          headerMap.subject || '',
          headerMap.from || '',
          rawContent,
          headerMap.date
        );
        
        console.log(`   🤖 ML Parse result:`, mlResult);
        
        if (mlResult.emailType && mlResult.emailType !== 'unknown') {
          console.log(`   ✅ Would be processed: ${mlResult.emailType} (confidence: ${mlResult.confidence})`);
          console.log(`   📊 Extracted data:`, {
            guestName: mlResult.guestName,
            checkInDate: mlResult.checkInDate,
            checkOutDate: mlResult.checkOutDate,
            status: mlResult.status,
            hostEarnings: mlResult.hostEarnings
          });
        } else {
          console.log(`   ⚠️ Would be skipped: email type unknown or low confidence`);
        }
        
      } catch (error) {
        console.log(`   ❌ Error parsing email: ${error}`);
      }
    }
    
    // 5. Test actual enrichment
    console.log(`\n🚀 Running actual enrichment...`);
    const enricher = new BookingEnricher(gmailClient, user.id);
    
    try {
      const result = await enricher.enrichBooking(bookingCode);
      console.log(`📊 Enrichment result:`, result);
      
      // 6. Check final booking status after enrichment
      console.log(`\n🔍 Checking final booking status after enrichment...`);
      const finalBooking = await prisma.booking.findUnique({
        where: { 
          userId_bookingCode: { userId: user.id, bookingCode } 
        }
      });
      
      if (finalBooking) {
        console.log(`✅ Final booking status: ${finalBooking.status}`);
        console.log(`📅 Check-in: ${finalBooking.checkInDate}, Check-out: ${finalBooking.checkOutDate}`);
        console.log(`👤 Guest: ${finalBooking.guestName}`);
      } else {
        console.log(`❌ Booking not found after enrichment!`);
      }
      
    } catch (enrichmentError) {
      console.error(`❌ Enrichment error: ${enrichmentError}`);
      throw enrichmentError;
    }
    
  } catch (error) {
    console.error(`❌ Error during enrichment test: ${error}`);
    throw error;
  } finally {
    // Ensure all Prisma operations complete before exit
    await prisma.$disconnect();
  }
}

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length !== 2) {
    console.log(`Usage: npm run test-enrichment <userId> <bookingCode>`);
    console.log(`Example: npm run test-enrichment 1 HMR9HHX8LH`);
    process.exit(1);
  }
  
  const userId = parseInt(args[0]);
  const bookingCode = args[1];
  
  if (isNaN(userId)) {
    console.log(`❌ Invalid user ID: ${args[0]}`);
    process.exit(1);
  }
  
  await testEnrichmentOnBooking(userId, bookingCode);
  
  console.log(`\n✅ Enrichment test completed`);
  process.exit(0);
}

if (require.main === module) {
  main().catch(console.error);
}