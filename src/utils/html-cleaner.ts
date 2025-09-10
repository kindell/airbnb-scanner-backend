/**
 * HTML Content Cleaner for ML Email Parsing
 * ==========================================
 * 
 * TypeScript/JavaScript version av HTML cleaner för att rengöra
 * Gmail API-data från HTML, URL-kodning och brus för bättre ML-parsing.
 */

export class EmailContentCleaner {
    private htmlTagPattern = /<[^>]+>/g;
    private urlPattern = /https?:\/\/[^\s<>"']+/gi;
    private trackingPattern = /%[a-zA-Z0-9]+%|opentrack|unsubscribe|tracking/gi;
    private whitespacePattern = /\s+/g;
    private lineBreakPattern = /[\r\n]+/g;

    // Booking-relevanta mönster att bevara
    private bookingCodePattern = /HM[A-Z0-9]{8}/g;
    private swedishDatePattern = /\b(\w{3})\s+(\d{1,2})\s+(jan|feb|mar|apr|maj|jun|jul|aug|sep|okt|nov|dec|januari|februari|mars|april|maj|juni|juli|augusti|september|oktober|november|december)\.?\s*(?:(\d{4}))?/gi;
    private amountPattern = /€\s*[\d\s,]+|Du tjänar[:\s]+[€\d\s,.]+|[\d\s]+,\d+\s*kr|utbetalning\s+på\s+[\d\s,]+\s*kr/gi;

    /**
     * Huvudmetod för att rengöra email-innehåll för ML-parsing
     */
    cleanForML(rawContent: string): string {
        if (!rawContent) {
            return '';
        }

        let content = rawContent;

        // Steg 1: URL-dekodning
        content = this.decodeUrls(content);

        // Steg 2: HTML entities dekodning
        content = this.decodeHtmlEntities(content);

        // Steg 3: Extrahera viktiga delar först
        const importantParts = this.extractImportantParts(content);

        // Steg 4: Ta bort HTML tags
        content = this.removeHtmlTags(content);

        // Steg 5: Ta bort tracking och onödig info
        content = this.removeTrackingInfo(content);

        // Steg 6: Rensa whitespace och formattera
        content = this.normalizeWhitespace(content);

        // Steg 7: Lägg tillbaka viktiga delar först i texten
        content = this.prependImportantParts(content, importantParts);

        // Steg 8: Extrahera huvudinnehåll (första 5000 chars efter rensning)
        content = this.extractMainContent(content);

        return content.trim();
    }

    private decodeUrls(content: string): string {
        try {
            // Multiple passes för nested encoding
            for (let i = 0; i < 3; i++) {
                const decoded = decodeURIComponent(content);
                if (decoded === content) {
                    break;
                }
                content = decoded;
            }
        } catch (error) {
            // Om dekodning misslyckas, använd original
        }
        return content;
    }

    private decodeHtmlEntities(content: string): string {
        const entities: { [key: string]: string } = {
            '&quot;': '"',
            '&amp;': '&',
            '&lt;': '<',
            '&gt;': '>',
            '&nbsp;': ' ',
            '&#39;': "'",
            '&apos;': "'",
        };

        return content.replace(/&[#\w]+;/g, (entity) => {
            return entities[entity] || entity;
        });
    }

    private extractImportantParts(content: string): {
        bookingCodes: string[];
        dates: string[];
        amounts: string[];
    } {
        const important = {
            bookingCodes: [] as string[],
            dates: [] as string[],
            amounts: [] as string[]
        };

        // Extrahera booking codes
        const bookingMatches = content.match(this.bookingCodePattern);
        if (bookingMatches) {
            important.bookingCodes = [...new Set(bookingMatches)]; // Remove duplicates
        }

        // Extrahera datum
        const dateMatches = content.match(this.swedishDatePattern);
        if (dateMatches) {
            important.dates = dateMatches.slice(0, 4); // Max 4 dates
        }

        // Extrahera belopp
        const amountMatches = content.match(this.amountPattern);
        if (amountMatches) {
            important.amounts = amountMatches.slice(0, 2); // Max 2 amounts
        }

        return important;
    }

    private removeHtmlTags(content: string): string {
        // Lägg till mellanslag innan vissa tags för att undvika att ord klister ihop
        content = content.replace(/<\/(div|p|br|tr|td)>/gi, ' ');
        content = content.replace(/<(br|hr)/gi, ' <$1');

        // Ta bort alla HTML tags
        content = content.replace(this.htmlTagPattern, '');

        return content;
    }

    private removeTrackingInfo(content: string): string {
        // Ta bort URLs (de flesta är tracking)
        content = content.replace(this.urlPattern, ' ');

        // Ta bort tracking-specifik text
        content = content.replace(this.trackingPattern, '');

        // Ta bort vanliga email signatures och footers
        const footerPatterns = [
            /Airbnb Ireland.*$/gm,
            /Best regards.*$/gm,
            /This email was sent.*$/gm,
            /Unsubscribe.*$/gm
        ];

        for (const pattern of footerPatterns) {
            content = content.replace(pattern, '');
        }

        return content;
    }

    private normalizeWhitespace(content: string): string {
        // Konvertera alla line breaks till \n
        content = content.replace(this.lineBreakPattern, '\n');

        // Konvertera multipla spaces till single space
        content = content.replace(this.whitespacePattern, ' ');

        // Rensa tomma rader (men behåll någon struktur)
        const lines = content.split('\n');
        const cleanLines = lines
            .map(line => line.trim())
            .filter(line => line.length > 0);

        return cleanLines.join('\n');
    }

    private prependImportantParts(content: string, importantParts: {
        bookingCodes: string[];
        dates: string[];
        amounts: string[];
    }): string {
        const prefixParts: string[] = [];

        // Lägg booking codes först
        if (importantParts.bookingCodes.length > 0) {
            prefixParts.push(`Bokningskod: ${importantParts.bookingCodes[0]}`);
        }

        // Lägg datum tidigt
        if (importantParts.dates.length > 0) {
            prefixParts.push(`Datum: ${importantParts.dates.join(', ')}`);
        }

        // Lägg belopp
        if (importantParts.amounts.length > 0) {
            prefixParts.push(`Belopp: ${importantParts.amounts.join(', ')}`);
        }

        if (prefixParts.length > 0) {
            const prefix = prefixParts.join('\n') + '\n\n';
            content = prefix + content;
        }

        return content;
    }

    private extractMainContent(content: string): string {
        // Skicka hela innehållet till ML-modellen - ingen trunkering!
        // Tidigare begränsning på 5000/8000 chars orsakade förlust av "DU TJÄNAR" raden
        return content;
    }
}

/**
 * Enkel wrapper-funktion för att rengöra email-innehåll
 */
export function cleanEmailContent(rawContent: string): string {
    const cleaner = new EmailContentCleaner();
    return cleaner.cleanForML(rawContent);
}

// Test-funktion
if (require.main === module) {
    // Test med exempel-data
    const testContent = `
    %opentrack%
    <html><body><div>
    <p>MATTHIAS ANLÄNDER MÅNDAG, 1 SEP..</p>
    <table><tr><td>Bokningskod: HMFH9A8E35</td></tr></table>
    <div>Incheckning: mån 1 sep</div>
    <div>Utcheckning: sön 14 sep</div>
    <p>Du tjänar: € 366,25</p>
    <a href="https://tracking.airbnb.com/long-url">Link</a>
    </body></html>
    `;

    const cleaned = cleanEmailContent(testContent);
    console.log('=== CLEANED CONTENT ===');
    console.log(cleaned);
}