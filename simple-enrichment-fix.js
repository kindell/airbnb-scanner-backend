#!/usr/bin/env node
/**
 * Simple script to fix enrichment by using EmailProcessor directly
 */

const { PrismaClient } = require('@prisma/client');

async function fixEnrichmentWithEmailProcessor() {
    const prisma = new PrismaClient();
    
    try {
        console.log('🔧 Fixing enrichment with EmailProcessor...');
        console.log('=' .repeat(60));
        
        // Get user info
        const user = await prisma.user.findFirst({
            where: { id: 1 }
        });
        
        if (!user) {
            console.log('❌ User not found');
            return;
        }
        
        // Create a session for this process
        const session = await prisma.scanningSession.create({
            data: {
                userId: 1,
                year: 2025,
                status: 'processing',
                processedEmails: 0,
                skippedEmails: 0,
                errorEmails: 0,
                bookingsFound: 0,
                bookingsUpdated: 0,
                payoutsLinked: 0,
                changesDetected: 0,
                mlFailures: 0,
                searchQuery: 'test enrichment',
                emailTypes: 'booking_confirmation',
                dateRange: '2025',
                currentMessage: 'Testing enrichment with EmailProcessor',
                currentStep: 'processing',
                startedAt: new Date(),
                lastUpdateAt: new Date()
            }
        });
        
        console.log(`📧 Created session ${session.id} for enrichment test`);
        
        // Use EmailProcessor
        const { EmailProcessor } = require('./dist/services/email-processor');
        const processor = new EmailProcessor(1, session.id, user);
        
        console.log('🔍 Starting EmailProcessor search for year 2025...');
        await processor.searchBookingEmails(2025);
        
        console.log('✅ EmailProcessor completed successfully!');
        console.log('Check the booking statuses now - they should be enriched with proper cancellation detection');
        
    } catch (error) {
        console.error('❌ Error:', error);
    } finally {
        await prisma.$disconnect();
    }
}

fixEnrichmentWithEmailProcessor();