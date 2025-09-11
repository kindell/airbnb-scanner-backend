#!/usr/bin/env node
/**
 * Test enrichment by deleting and rescanning a specific booking
 */

const { PrismaClient } = require('@prisma/client');

async function testEnrichmentWithScan() {
    const prisma = new PrismaClient();
    
    try {
        console.log('🧪 Testing enrichment by rescanning specific booking...');
        console.log('=' .repeat(60));
        
        // Test with the cancelled booking: HM9CR9YRTS (Hannah)
        const bookingCode = 'HM9CR9YRTS';
        
        console.log(`🔍 Testing with booking: ${bookingCode} (should be cancelled)`);
        
        // Check current state
        const existingBooking = await prisma.booking.findFirst({
            where: { bookingCode: bookingCode }
        });
        
        if (existingBooking) {
            console.log(`📋 Current state in database:`);
            console.log(`   Guest: ${existingBooking.guestName}`);
            console.log(`   Status: ${existingBooking.status}`);
            console.log(`   EnrichmentStatus: ${existingBooking.enrichmentStatus}`);
            console.log(`   Gmail ID: ${existingBooking.gmailId}`);
            console.log('');
            
            // Delete the booking to force a rescan
            console.log('🗑️ Deleting booking to force rescan...');
            
            // First delete related records
            await prisma.emailLink.deleteMany({
                where: { bookingId: existingBooking.id }
            });
            
            await prisma.bookingUpdateEvent.deleteMany({
                where: { bookingId: existingBooking.id }
            });
            
            await prisma.booking.delete({
                where: { id: existingBooking.id }
            });
            
            console.log('✅ Booking deleted');
            console.log('');
            console.log('📧 Now you can run a scan for 2025 and the booking will be rescanned.');
            console.log('   The EmailProcessor should detect it as a new booking and run enrichment.');
            console.log('   Check the server logs for:');
            console.log(`   🔍 [ENRICHMENT DEBUG] Booking ${bookingCode}: NEW`);
            console.log(`   🔍 [ENRICHMENT DEBUG] Starting enrichment for ${bookingCode}...`);
            console.log('   🔍 [ENRICHMENT DEBUG] Creating enricher with Gmail client: YES');
            
        } else {
            console.log(`❌ Booking ${bookingCode} not found in database`);
        }
        
    } catch (error) {
        console.error('❌ Error:', error);
    } finally {
        await prisma.$disconnect();
    }
}

testEnrichmentWithScan();