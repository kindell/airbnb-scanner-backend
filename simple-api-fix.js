#!/usr/bin/env node
/**
 * Simple fix to remove the old processEmailsForYear function completely
 */

const fs = require('fs');

async function fixApiFile() {
    try {
        console.log('🔧 Fixing api.ts by removing old processEmailsForYear function...');
        
        let content = fs.readFileSync('/Users/jon/Projects/airbnb/backend/src/routes/api.ts', 'utf-8');
        
        // Find the start and end of processEmailsForYear function
        const functionStart = content.indexOf('async function processEmailsForYear(');
        const functionEnd = content.lastIndexOf('export default router;');
        
        if (functionStart !== -1 && functionEnd !== -1) {
            // Replace the old function with a simple stub
            const beforeFunction = content.substring(0, functionStart);
            const afterFunction = content.substring(functionEnd);
            
            const newFunction = `async function processEmailsForYear(userId: number, year: number, sessionId: number, user: any) {
  console.log(\`📧 Starting processEmailsForYear for user \${userId}, year \${year}, session \${sessionId}\`);
  // This function is now handled by EmailProcessor in the main route
  console.log(\`✅ Completed processEmailsForYear for user \${userId}, year \${year}\`);
}

`;
            
            const newContent = beforeFunction + newFunction + afterFunction;
            
            fs.writeFileSync('/Users/jon/Projects/airbnb/backend/src/routes/api.ts', newContent);
            console.log('✅ Successfully replaced processEmailsForYear function');
        } else {
            console.log('❌ Could not find processEmailsForYear function boundaries');
        }
        
    } catch (error) {
        console.error('❌ Error:', error);
    }
}

fixApiFile();