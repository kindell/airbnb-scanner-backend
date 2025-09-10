/**
 * Email content decoder utilities
 * Handles quoted-printable and UTF-8 decoding for Gmail API content
 */

import { convert } from 'html-to-text';

/**
 * Decode quoted-printable UTF-8 content from Gmail API
 * This fixes issues with Swedish characters like 'ä' being encoded as =C3=A4
 * and Euro symbols being encoded as =E2=82=AC
 */
export function decodeQuotedPrintableUTF8(text: string): string {
    if (!text) return text;

    try {
        // First, decode the quoted-printable sequences (=XX)
        let result = text.replace(/=[0-9A-F]{2}/gi, (match) => {
            const hex = match.slice(1);
            const byte = parseInt(hex, 16);
            return String.fromCharCode(byte);
        });

        // Handle soft line breaks (= at end of line)
        result = result.replace(/=\r?\n/g, '');

        // Convert the incorrectly decoded string back to bytes, then decode as UTF-8
        const bytes: number[] = [];
        for (let i = 0; i < result.length; i++) {
            const code = result.charCodeAt(i);
            if (code <= 255) {
                bytes.push(code);
            } else {
                // For characters > 255, split into UTF-8 bytes
                const utf8Bytes = unescape(encodeURIComponent(result.charAt(i)))
                    .split('')
                    .map(c => c.charCodeAt(0));
                bytes.push(...utf8Bytes);
            }
        }

        // Convert bytes to proper UTF-8 string
        const buffer = Buffer.from(bytes);
        return buffer.toString('utf8');
    } catch (e) {
        console.log(`UTF-8 decoding error: ${e instanceof Error ? e.message : 'Unknown error'}`);
        return text; // Return original if decoding fails
    }
}

/**
 * Decode Gmail API email body content with proper UTF-8 handling and convert HTML to text
 */
export function decodeGmailContent(base64Data: string): string {
    try {
        // First decode from base64
        const rawContent = Buffer.from(base64Data, 'base64').toString('utf-8');
        
        // Then decode quoted-printable UTF-8 sequences
        const decodedContent = decodeQuotedPrintableUTF8(rawContent);
        
        // Convert HTML to plain text for better ML processing
        // Check if content appears to be HTML (contains HTML tags)
        if (decodedContent.includes('<') && decodedContent.includes('>')) {
            const plainText = convert(decodedContent, {
                wordwrap: false,
                preserveNewlines: true
            });
            console.log(`   📄 Converted HTML to text (${decodedContent.length} -> ${plainText.length} chars)`);
            return plainText;
        }
        
        return decodedContent;
    } catch (e) {
        console.log(`Gmail content decoding error: ${e instanceof Error ? e.message : 'Unknown error'}`);
        return Buffer.from(base64Data, 'base64').toString('utf-8'); // Fallback to basic decoding
    }
}

/**
 * Decode Gmail content for ML processing - prioritizes plain text extraction
 */
export function decodeGmailContentForML(base64Data: string): string {
    try {
        // First decode from base64
        const rawContent = Buffer.from(base64Data, 'base64').toString('utf-8');
        
        // Then decode quoted-printable UTF-8 sequences
        const decodedContent = decodeQuotedPrintableUTF8(rawContent);
        
        // Always convert to plain text for ML processing
        if (decodedContent.includes('<') && decodedContent.includes('>')) {
            const plainText = convert(decodedContent, {
                wordwrap: false,
                preserveNewlines: true
            });
            console.log(`   🤖 ML: Converted HTML to plain text (${decodedContent.length} -> ${plainText.length} chars)`);
            
            // Debug: Check if converted text contains key Swedish earnings phrases
            if (plainText.toLowerCase().includes('tjänar') || plainText.toLowerCase().includes('earnings') || plainText.includes('412')) {
                console.log(`   🔍 DEBUG: Converted text contains earnings keywords!`);
                
                // Save full content for analysis
                const fs = require('fs');
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                const filename = `/tmp/gmail-content-${timestamp}.txt`;
                fs.writeFileSync(filename, plainText);
                console.log(`   💾 Full content saved to: ${filename}`);
                
                // Show relevant lines
                const lines = plainText.split('\n').filter(line => 
                    line.toLowerCase().includes('tjänar') || 
                    line.toLowerCase().includes('earnings') ||
                    line.includes('€') || 
                    line.includes('412') ||
                    line.toLowerCase().includes('du ') ||
                    line.toLowerCase().includes('intäkter')
                );
                console.log(`   📄 Found ${lines.length} relevant lines:`);
                lines.slice(0, 5).forEach((line, i) => {
                    console.log(`     ${i+1}: "${line.trim()}"`);
                });
                
                // Character-level analysis around key terms
                const pos = plainText.toLowerCase().indexOf('tjänar');
                if (pos >= 0) {
                    const context = plainText.substring(Math.max(0, pos - 50), pos + 100);
                    console.log(`   🎯 Context around 'tjänar': "${context}"`);
                    
                    // Show raw bytes for encoding analysis
                    const bytes = Buffer.from(context).toString('hex');
                    console.log(`   🔢 Hex bytes: ${bytes.substring(0, 200)}`);
                }
            }
            
            return plainText;
        }
        
        return decodedContent;
    } catch (e) {
        console.log(`Gmail ML content decoding error: ${e instanceof Error ? e.message : 'Unknown error'}`);
        return Buffer.from(base64Data, 'base64').toString('utf-8'); // Fallback to basic decoding
    }
}