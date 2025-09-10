const { PrismaClient } = require('@prisma/client');
const { GmailClient } = require('../dist/utils/gmail-client');
const { cleanEmailContent } = require('../dist/utils/html-cleaner');

async function debugCecilia() {
    const prisma = new PrismaClient();
    
    try {
        // Get authenticated user
        const user = await prisma.users.findFirst({
            where: {
                gmailAccessToken: { not: null },
                gmailRefreshToken: { not: null }
            }
        });
        
        if (!user) {
            throw new Error('No authenticated user found');
        }
        
        // Create Gmail client
        const gmailClient = new GmailClient(user);
        
        // Get Cecilia's email
        const emailData = await gmailClient.fetchEmailContent('198f8ad3c43b53fc');
        
        console.log(`📧 Cecilia raw content: ${emailData.rawEmailContent.length} chars`);
        
        // Clean it
        const cleaned = cleanEmailContent(emailData.rawEmailContent);
        console.log(`🧹 Cleaned content: ${cleaned.length} chars`);
        
        console.log('\n=== CLEANED CONTENT ===');
        console.log(cleaned);
        
        console.log('\n=== IMPORTANT PATTERNS ===');
        console.log('📅 Looking for dates...');
        
        // Check for date patterns
        const datePatterns = [
            /Incheckning[:\s]*(\w{3})\s+(\d{1,2})\s+(\w+)/gi,
            /Utcheckning[:\s]*(\w{3})\s+(\d{1,2})\s+(\w+)/gi,
            /(\d{1,2})\s+(juli|jul)/gi,
            /13.*juli/gi,
            /15.*juli/gi,
            /27.*juli/gi
        ];
        
        datePatterns.forEach((pattern, i) => {
            const matches = cleaned.match(pattern);
            console.log(`Pattern ${i}: ${pattern} → ${matches || 'No matches'}`);
        });
        
    } catch (error) {
        console.error('Error:', error.message);
    } finally {
        await prisma.$disconnect();
    }
}

debugCecilia();