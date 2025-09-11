#!/usr/bin/env node
/**
 * Trigger enrichment for one specific booking to test the fix
 */

const { PrismaClient } = require('@prisma/client');

async function triggerEnrichmentTest() {
    const prisma = new PrismaClient();
    
    try {
        console.log('🧪 Testing enrichment trigger for specific booking...');
        console.log('=' .repeat(60));
        
        // Pick one booking that needs enrichment
        const testBooking = await prisma.booking.findFirst({
            where: {
                enrichmentStatus: 'scanning'
            },
            orderBy: { checkInDate: 'desc' }
        });
        
        if (!testBooking) {
            console.log('❌ No bookings found with enrichmentStatus="scanning"');
            return;
        }
        
        console.log(`🔍 Test booking: ${testBooking.bookingCode} (${testBooking.guestName})`);
        console.log(`   Current status: ${testBooking.status}`);
        console.log(`   Current enrichmentStatus: ${testBooking.enrichmentStatus}`);
        console.log('');
        
        // Trigger enrichment by simulating what happens during scan
        // Update the booking to trigger the enrichment check
        console.log('🔄 Updating booking to trigger enrichment...');
        const updatedBooking = await prisma.booking.update({
            where: { id: testBooking.id },
            data: {
                parseAttempts: testBooking.parseAttempts + 1,
                updatedAt: new Date()
            }
        });
        
        console.log('✅ Booking updated, check server logs for enrichment debug output');
        console.log('');
        console.log('Expected debug output in server logs:');
        console.log(`   🔍 [ENRICHMENT DEBUG] Booking ${testBooking.bookingCode}: EXISTS`);
        console.log(`   🔍 [ENRICHMENT DEBUG] Existing booking needs enrichment: ${testBooking.bookingCode}`);
        console.log(`   🔍 [ENRICHMENT DEBUG] Starting enrichment for ${testBooking.bookingCode}...`);
        
    } catch (error) {
        console.error('❌ Error:', error);
    } finally {
        await prisma.$disconnect();
    }
}

triggerEnrichmentTest();