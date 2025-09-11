#!/usr/bin/env node
/**
 * Test EmailProcessor with a small scan to verify date correctness
 */

const { PrismaClient } = require('@prisma/client');
const { EmailProcessor } = require('./dist/services/email-processor');

async function testSmallScan() {
    const prisma = new PrismaClient();
    
    try {
        console.log('🧪 Testing EmailProcessor with small scan...');
        console.log('=' .repeat(60));
        
        // Get user
        const user = await prisma.user.findFirst({
            where: { gmailAccessToken: { not: null } }
        });
        
        if (!user) {
            console.log('❌ No Gmail credentials found');
            return;
        }
        
        console.log(`✅ Found user: ${user.email}`);
        
        // Create a test session
        const sessionRecord = await prisma.scanningSession.create({
            data: {
                userId: user.id,
                year: 2024,
                status: 'active',
                totalEmails: 0,
                processedEmails: 0,
                skippedEmails: 0,
                errorEmails: 0,
                currentStep: 'searching',
                currentMessage: 'Testing small scan'
            }
        });
        
        console.log(`✅ Created test session: ${sessionRecord.id}`);
        
        // Set up EmailProcessor
        const processor = new EmailProcessor({
            prisma,
            userId: user.id,
            user,
            sessionId: sessionRecord.id,
            year: 2024
        });
        
        // Search for booking emails (limited to 3)
        console.log('🔍 Searching for booking emails...');
        const emailIds = await processor.searchBookingEmails();
        console.log(`📧 Found ${emailIds.length} emails`);
        
        // Process only first 3 emails for testing
        const testEmailIds = emailIds.slice(0, 3);
        console.log(`🧪 Testing with first ${testEmailIds.length} emails`);
        
        // Update session with email count
        await processor.updateSessionWithEmailCount(testEmailIds.length);
        
        // Process the emails
        console.log('⚡ Processing emails...');
        const result = await processor.processEmails(testEmailIds);
        
        console.log('📊 Processing Result:');
        console.log(`  Processed: ${result.processed}`);
        console.log(`  Skipped: ${result.skipped}`);
        console.log(`  Errors: ${result.errors}`);
        console.log('');
        
        // Check what was created in database
        const createdBookings = await prisma.booking.findMany({
            orderBy: { createdAt: 'desc' }
        });
        
        console.log('📊 Created bookings:');
        console.log('=' .repeat(40));
        createdBookings.forEach((booking, i) => {
            console.log(`${i+1}. ${booking.bookingCode} - ${booking.guestName}`);
            console.log(`   Check-in: ${booking.checkInDate} (year: ${new Date(booking.checkInDate).getFullYear()})`);
            console.log(`   Check-out: ${booking.checkOutDate} (year: ${new Date(booking.checkOutDate).getFullYear()})`);
            
            // Check if dates are 2024
            const checkInYear = new Date(booking.checkInDate).getFullYear();
            const checkOutYear = new Date(booking.checkOutDate).getFullYear();
            
            if (checkInYear === 2024 && checkOutYear === 2024) {
                console.log(`   ✅ Correct year: 2024`);
            } else {
                console.log(`   ❌ Wrong year: ${checkInYear}/${checkOutYear}`);
            }
            console.log('');
        });
        
        // Summary
        const correctYearCount = createdBookings.filter(b => 
            new Date(b.checkInDate).getFullYear() === 2024 && 
            new Date(b.checkOutDate).getFullYear() === 2024
        ).length;
        
        console.log('🎯 SUMMARY:');
        console.log(`  Total bookings: ${createdBookings.length}`);
        console.log(`  Correct year (2024): ${correctYearCount}`);
        console.log(`  Wrong year: ${createdBookings.length - correctYearCount}`);
        console.log(`  Accuracy: ${correctYearCount === createdBookings.length ? '100%' : `${((correctYearCount/createdBookings.length)*100).toFixed(1)}%`}`);
        
        if (correctYearCount === createdBookings.length) {
            console.log('🎉 SUCCESS: All dates are correct!');
        } else {
            console.log('❌ FAILURE: Some dates are still wrong');
        }
        
        // Clean up
        await prisma.scanningSession.delete({
            where: { id: sessionRecord.id }
        });
        
    } catch (error) {
        console.error('❌ Error:', error);
    } finally {
        await prisma.$disconnect();
    }
}

testSmallScan();