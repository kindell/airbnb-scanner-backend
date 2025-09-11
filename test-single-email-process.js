#!/usr/bin/env node
/**
 * Test EmailProcessor on a single email to see the actual ML output
 */

const { PrismaClient } = require('@prisma/client');
const { EmailProcessor } = require('./dist/services/email-processor');

async function testSingleEmail() {
    const prisma = new PrismaClient();
    
    try {
        console.log('🧪 Testing EmailProcessor on single email...');
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
                totalEmails: 1,
                processedEmails: 0,
                skippedEmails: 0,
                errorEmails: 0,
                currentStep: 'processing',
                currentMessage: 'Testing single email'
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
        
        // Use the known Gmail ID from our test
        const testGmailId = '18d1d64b9d635d3a'; // Felix booking HMZQS53KKE
        
        console.log(`🔍 Processing email: ${testGmailId}`);
        
        // Process just this one email to see what happens
        const result = await processor.processEmails([testGmailId]);
        
        console.log('📊 Processing Result:');
        console.log(JSON.stringify(result, null, 2));
        
        // Check what was created in database
        const createdBooking = await prisma.booking.findFirst({
            where: { 
                gmailId: testGmailId
            },
            orderBy: { createdAt: 'desc' }
        });
        
        if (createdBooking) {
            console.log('📊 Created booking in database:');
            console.log(`  Code: ${createdBooking.bookingCode}`);
            console.log(`  Guest: ${createdBooking.guestName}`);
            console.log(`  Check-in: ${createdBooking.checkInDate} (year: ${new Date(createdBooking.checkInDate).getFullYear()})`);
            console.log(`  Check-out: ${createdBooking.checkOutDate} (year: ${new Date(createdBooking.checkOutDate).getFullYear()})`);
        } else {
            console.log('❌ No booking was created');
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

testSingleEmail();