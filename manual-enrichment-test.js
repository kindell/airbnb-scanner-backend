#!/usr/bin/env node
/**
 * Manually trigger enrichment for specific bookings using the BookingEnricher directly
 */

const { PrismaClient } = require('@prisma/client');

async function manualEnrichmentTest() {
    const prisma = new PrismaClient();
    
    try {
        console.log('🧪 Testing manual enrichment for specific cancelled booking...');
        console.log('=' .repeat(60));
        
        // Test with one of the cancelled bookings from CSV: HM9CR9YRTS (Hannah)
        const bookingCode = 'HM9CR9YRTS'; // This should be cancelled according to CSV
        
        console.log(`🔍 Testing enrichment for ${bookingCode} (should be cancelled according to CSV)`);
        
        // Check if this booking exists in DB
        const dbBooking = await prisma.booking.findFirst({
            where: {
                bookingCode: bookingCode
            }
        });
        
        if (!dbBooking) {
            console.log(`❌ Booking ${bookingCode} not found in database`);
            console.log('This is expected - the cancelled booking is missing from DB');
            
            // Let's test with a booking that exists in DB instead
            const existingBooking = await prisma.booking.findFirst({
                where: {
                    enrichmentStatus: 'scanning'
                },
                orderBy: { checkInDate: 'desc' }
            });
            
            if (!existingBooking) {
                console.log('❌ No bookings found for testing');
                return;
            }
            
            console.log(`📋 Testing with existing booking: ${existingBooking.bookingCode} (${existingBooking.guestName})`);
            console.log(`   Current status: ${existingBooking.status}`);
            console.log(`   Current enrichmentStatus: ${existingBooking.enrichmentStatus}`);
            
            // Try to trigger enrichment manually
            try {
                const { BookingEnricher } = require('./dist/utils/booking-enricher');
                
                // This will fail because we don't have GmailClient, but let's see the error
                console.log('🔄 Attempting manual enrichment (will fail due to no Gmail client)...');
                const enricher = new BookingEnricher(null, existingBooking.userId);
                const result = await enricher.enrichBooking(existingBooking.bookingCode);
                console.log('   Result:', result);
                
            } catch (enrichError) {
                console.log('   ❌ Expected error (no Gmail client):', enrichError.message);
            }
            
        } else {
            console.log(`📋 Found ${bookingCode} in database:`);
            console.log(`   Guest: ${dbBooking.guestName}`);
            console.log(`   Status: ${dbBooking.status} (CSV says it should be 'Canceled by guest')`);
            console.log(`   EnrichmentStatus: ${dbBooking.enrichmentStatus}`);
            console.log(`   CheckIn: ${dbBooking.checkInDate.toISOString().split('T')[0]}`);
        }
        
    } catch (error) {
        console.error('❌ Error:', error);
    } finally {
        await prisma.$disconnect();
    }
}

manualEnrichmentTest();