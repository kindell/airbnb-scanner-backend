#!/usr/bin/env node
/**
 * Test what the ML parser is actually outputting for real emails
 */

const { PrismaClient } = require('@prisma/client');
const { MLEmailParser } = require('./dist/parsers/MLEmailParser');
const { GmailClient } = require('./dist/utils/gmail-client');

async function testMLOutput() {
    const prisma = new PrismaClient();
    
    try {
        console.log('🧪 Testing ML Parser Output...');
        console.log('=' .repeat(60));
        
        // Get user
        const user = await prisma.user.findFirst({
            where: { gmailAccessToken: { not: null } }
        });
        
        if (!user) {
            console.log('❌ No Gmail credentials found');
            return;
        }
        
        // Get a recent booking to test with
        const recentBooking = await prisma.booking.findFirst({
            where: { userId: user.id },
            orderBy: { createdAt: 'desc' }
        });
        
        if (!recentBooking) {
            console.log('❌ No bookings found');
            return;
        }
        
        console.log(`📊 Testing with booking: ${recentBooking.bookingCode}`);
        console.log(`   Guest: ${recentBooking.guestName}`);
        console.log(`   DB Check-in: ${recentBooking.checkInDate} (year: ${new Date(recentBooking.checkInDate).getFullYear()})`);
        console.log(`   Gmail ID: ${recentBooking.gmailId}`);
        console.log('');
        
        if (!recentBooking.gmailId) {
            console.log('❌ No Gmail ID for this booking');
            return;
        }
        
        // Set up clients
        const gmailClient = new GmailClient(user);
        const parser = new MLEmailParser(user.id);
        
        // Get the email
        console.log('📧 Fetching email from Gmail...');
        const email = await gmailClient.getEmail(recentBooking.gmailId);
        
        // Extract content like EmailProcessor does
        const extractEmailContent = (email) => {
            const extractFromPart = (part) => {
                let content = '';
                
                if (part.body?.data) {
                    try {
                        const decoded = Buffer.from(part.body.data, 'base64').toString('utf-8');
                        content += decoded + '\\n';
                    } catch (e) {
                        // ignore
                    }
                }
                
                if (part.parts) {
                    for (const subPart of part.parts) {
                        content += extractFromPart(subPart);
                    }
                }
                
                return content;
            };
            
            if (email.payload.parts) {
                let allContent = '';
                for (const part of email.payload.parts) {
                    allContent += extractFromPart(part);
                }
                return allContent;
            }
            
            if (email.payload.body?.data) {
                return Buffer.from(email.payload.body.data, 'base64').toString('utf-8');
            }
            
            return '';
        };
        
        const emailContent = extractEmailContent(email);
        
        // Extract headers
        const extractEmailHeaders = (email) => {
            if (!email.payload?.headers) return null;
            
            const headers = {
                subject: '',
                from: '',
                to: '',
                date: '',
                messageId: ''
            };
            
            for (const header of email.payload.headers) {
                switch (header.name.toLowerCase()) {
                    case 'subject':
                        headers.subject = header.value;
                        break;
                    case 'from':
                        headers.from = header.value;
                        break;
                    case 'to':
                        headers.to = header.value;
                        break;
                    case 'date':
                        headers.date = header.value;
                        break;
                    case 'message-id':
                        headers.messageId = header.value;
                        break;
                }
            }
            
            return headers;
        };
        
        const headers = extractEmailHeaders(email);
        
        console.log('📧 Email headers:');
        console.log(`   Subject: ${headers.subject}`);
        console.log(`   From: ${headers.from}`);
        console.log(`   Date: ${headers.date}`);
        console.log(`   Email date year: ${new Date(headers.date).getFullYear()}`);
        console.log('');
        
        // Parse with ML like EmailProcessor does
        console.log('🤖 Calling ML Parser...');
        const bookingData = await parser.parseBookingEmail({
            emailId: recentBooking.gmailId,
            rawEmailContent: emailContent,
            gmailId: recentBooking.gmailId,
            gmailThreadId: email.threadId,
            headers: headers || undefined
        });
        
        console.log('📊 ML Parser Result:');
        console.log(JSON.stringify(bookingData, null, 2));
        
        if (bookingData && bookingData.checkInDate) {
            console.log('');
            console.log('🔍 Date Analysis:');
            console.log(`   ML checkInDate: "${bookingData.checkInDate}" (type: ${typeof bookingData.checkInDate})`);
            console.log(`   ML checkOutDate: "${bookingData.checkOutDate}" (type: ${typeof bookingData.checkOutDate})`);
            
            if (typeof bookingData.checkInDate === 'string') {
                const parsedIn = new Date(bookingData.checkInDate);
                console.log(`   Parsed checkIn: ${parsedIn} (year: ${parsedIn.getFullYear()})`);
            }
            
            if (typeof bookingData.checkOutDate === 'string') {
                const parsedOut = new Date(bookingData.checkOutDate);
                console.log(`   Parsed checkOut: ${parsedOut} (year: ${parsedOut.getFullYear()})`);
            }
            
            console.log('');
            console.log('🔍 Comparison:');
            console.log(`   DB year: ${new Date(recentBooking.checkInDate).getFullYear()}`);
            console.log(`   ML year: ${typeof bookingData.checkInDate === 'string' ? new Date(bookingData.checkInDate).getFullYear() : 'N/A'}`);
            console.log(`   Email year: ${new Date(headers.date).getFullYear()}`);
        }
        
    } catch (error) {
        console.error('❌ Error:', error);
    } finally {
        await prisma.$disconnect();
    }
}

testMLOutput();