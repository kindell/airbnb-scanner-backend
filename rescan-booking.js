#!/usr/bin/env node
/**
 * Standalone Rescan Script
 * ========================
 * 
 * Usage: node rescan-booking.js <bookingCode>
 * Example: node rescan-booking.js HMSFBXYYD2
 */

const { PrismaClient } = require('@prisma/client');

async function rescanBooking(bookingCode) {
  const prisma = new PrismaClient();
  
  try {
    console.log(`🔄 Rescanning booking: ${bookingCode}`);
    
    // Get user (assuming user ID 1 for now)
    const userId = 1;
    const user = await prisma.user.findUnique({
      where: { id: userId }
    });
    
    if (!user) {
      console.log(`❌ User ${userId} not found`);
      return;
    }
    
    // Check current booking status
    const bookingBefore = await prisma.booking.findFirst({
      where: { userId, bookingCode }
    });
    
    if (bookingBefore) {
      console.log(`📋 Current status: ${bookingBefore.status} (enrichment: ${bookingBefore.enrichmentStatus})`);
      
      // Clear Gmail associations to allow reprocessing of emails (fixes issue where cancellations aren't detected)
      if (bookingBefore.gmailId || bookingBefore.gmailThreadId) {
        console.log(`🔄 Clearing Gmail associations to allow reprocessing of emails`);
        await prisma.booking.update({
          where: { 
            userId_bookingCode: { userId, bookingCode } 
          },
          data: { 
            enrichmentStatus: 'scanning',
            gmailId: null,
            gmailThreadId: null
          }
        });
        console.log(`✅ Gmail associations cleared`);
      }
    } else {
      console.log(`📋 Booking ${bookingCode} not found in database`);
    }
    
    // Initialize Gmail client and enricher
    const { GmailClient } = require('./src/utils/gmail-client');
    const { BookingEnricher } = require('./src/utils/booking-enricher');
    
    const gmailClient = new GmailClient(user);
    const enricher = new BookingEnricher(gmailClient, userId);
    
    // Run enrichment
    console.log(`🚀 Running BookingEnricher...`);
    const result = await enricher.enrichBooking(bookingCode);
    
    console.log(`✅ Enrichment completed: ${result.emailsProcessed}/${result.emailsFound} emails processed`);
    
    // Check final status
    const bookingAfter = await prisma.booking.findFirst({
      where: { userId, bookingCode }
    });
    
    if (bookingAfter) {
      console.log(`📊 Final status: ${bookingAfter.status} (enrichment: ${bookingAfter.enrichmentStatus})`);
      
      if (bookingBefore && bookingBefore.status !== bookingAfter.status) {
        console.log(`🔄 Status changed: ${bookingBefore.status} → ${bookingAfter.status}`);
      }
    } else {
      console.log(`❌ Booking ${bookingCode} still not found after enrichment`);
    }
    
  } catch (error) {
    console.error(`❌ Error during rescan: ${error.message}`);
    console.error(error);
  } finally {
    await prisma.$disconnect();
  }
}

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length !== 1) {
    console.log(`Usage: node rescan-booking.js <bookingCode>`);
    console.log(`Example: node rescan-booking.js HMSFBXYYD2`);
    process.exit(1);
  }
  
  const bookingCode = args[0];
  await rescanBooking(bookingCode);
}

if (require.main === module) {
  main().catch(console.error);
}
