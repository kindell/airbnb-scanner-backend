#!/usr/bin/env node
/**
 * Test enrichment process on existing bookings
 */

const { PrismaClient } = require('@prisma/client');

async function testEnrichment() {
    const prisma = new PrismaClient();
    
    try {
        console.log('🔍 Testing enrichment process...');
        console.log('=' .repeat(60));
        
        // Get a few bookings that need enrichment
        const bookings = await prisma.booking.findMany({
            where: {
                enrichmentStatus: 'scanning'
            },
            take: 3,
            orderBy: { checkInDate: 'desc' }
        });
        
        console.log(`📊 Found ${bookings.length} bookings with enrichmentStatus='scanning'`);
        
        if (bookings.length === 0) {
            console.log('❌ No bookings found that need enrichment');
            return;
        }
        
        for (const booking of bookings) {
            console.log('');
            console.log(`🔍 Testing booking: ${booking.bookingCode}`);
            console.log(`   Guest: ${booking.guestName}`);
            console.log(`   Status: ${booking.status}`);
            console.log(`   EnrichmentStatus: ${booking.enrichmentStatus}`);
            console.log(`   CheckIn: ${booking.checkInDate.toISOString().split('T')[0]}`);
            
            // Try to trigger enrichment by updating the booking
            // This simulates what happens during a scan
            try {
                const { BookingEnricher } = require('./dist/utils/booking-enricher');
                const enricher = new BookingEnricher(null, booking.userId); // No gmail client for this test
                
                console.log(`   🔄 Running enrichment...`);
                const result = await enricher.enrichBooking(booking.bookingCode);
                console.log(`   ✅ Enrichment result:`, result);
                
                // Check updated status
                const updatedBooking = await prisma.booking.findUnique({
                    where: { id: booking.id }
                });
                
                console.log(`   📊 Updated status: ${updatedBooking.status}`);
                console.log(`   📊 Updated enrichmentStatus: ${updatedBooking.enrichmentStatus}`);
                
            } catch (enrichError) {
                console.log(`   ❌ Enrichment failed:`, enrichError.message);
            }
        }
        
    } catch (error) {
        console.error('❌ Error:', error);
    } finally {
        await prisma.$disconnect();
    }
}

testEnrichment();