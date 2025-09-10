#!/usr/bin/env python3
"""
HTML Content Cleaner for ML Email Parsing
=========================================

Rengör Gmail API-data från HTML, URL-kodning och brus för bättre ML-parsing.
"""

import re
import html
import urllib.parse
from typing import Optional

class EmailContentCleaner:
    """Rengör email-innehåll för optimal ML-parsing"""
    
    def __init__(self):
        # Regex patterns för cleaning
        self.html_tag_pattern = re.compile(r'<[^>]+>')
        self.url_pattern = re.compile(r'https?://[^\s<>"\']+', re.IGNORECASE)
        self.email_tracking_pattern = re.compile(r'%[a-zA-Z0-9]+%|opentrack|unsubscribe|tracking', re.IGNORECASE)
        self.extra_whitespace_pattern = re.compile(r'\s+')
        self.line_break_pattern = re.compile(r'[\r\n]+')
        
        # Booking-relevanta mönster att bevara
        self.booking_code_pattern = re.compile(r'HM[A-Z0-9]{8}')
        self.swedish_date_pattern = re.compile(
            r'\b(\w{3})\s+(\d{1,2})\s+(jan|feb|mar|apr|maj|jun|jul|aug|sep|okt|nov|dec|januari|februari|mars|april|maj|juni|juli|augusti|september|oktober|november|december)\.?\s*(?:(\d{4}))?',
            re.IGNORECASE
        )
        self.amount_pattern = re.compile(r'€\s*\d+[,.]?\d*|Du tjänar[:\s]+[€\d\s,.]+'
                                       , re.IGNORECASE)
    
    def clean_for_ml(self, raw_content: str) -> str:
        """
        Huvudmetod för att rengöra email-innehåll för ML-parsing
        
        Args:
            raw_content: Rå email-innehåll från Gmail API
            
        Returns:
            Rengjort innehåll optimerat för ML-parsing
        """
        if not raw_content:
            return ""
        
        content = raw_content
        
        # Steg 1: URL-dekodning
        content = self._decode_urls(content)
        
        # Steg 2: HTML entities dekodning
        content = self._decode_html_entities(content)
        
        # Steg 3: Extrahera viktiga delar först
        important_parts = self._extract_important_parts(content)
        
        # Steg 4: Ta bort HTML tags
        content = self._remove_html_tags(content)
        
        # Steg 5: Ta bort tracking och onödig info
        content = self._remove_tracking_info(content)
        
        # Steg 6: Rensa whitespace och formattera
        content = self._normalize_whitespace(content)
        
        # Steg 7: Lägg tillbaka viktiga delar först i texten
        content = self._prepend_important_parts(content, important_parts)
        
        # Steg 8: Extrahera huvudinnehåll (första 2000 chars efter rensning)
        content = self._extract_main_content(content)
        
        return content.strip()
    
    def _decode_urls(self, content: str) -> str:
        """Dekoda URL-enkodad text"""
        try:
            # Multiple passes för nested encoding
            for _ in range(3):
                decoded = urllib.parse.unquote_plus(content)
                if decoded == content:
                    break
                content = decoded
        except Exception:
            pass  # Om dekodning misslyckas, använd original
        return content
    
    def _decode_html_entities(self, content: str) -> str:
        """Dekoda HTML entities som &quot;, &amp;, etc."""
        try:
            content = html.unescape(content)
        except Exception:
            pass
        return content
    
    def _extract_important_parts(self, content: str) -> dict:
        """Extrahera viktiga delar innan rensning"""
        important = {
            'booking_codes': [],
            'dates': [],
            'amounts': []
        }
        
        # Extrahera booking codes
        important['booking_codes'] = self.booking_code_pattern.findall(content)
        
        # Extrahera datum (mer aggressivt)
        date_matches = self.swedish_date_pattern.findall(content)
        for match in date_matches:
            date_str = ' '.join([part for part in match if part]).strip()
            if date_str and date_str not in important['dates']:
                important['dates'].append(date_str)
        
        # Extrahera belopp
        amount_matches = self.amount_pattern.findall(content)
        important['amounts'] = [amt.strip() for amt in amount_matches[:5]]  # Max 5 amounts
        
        return important
    
    def _remove_html_tags(self, content: str) -> str:
        """Ta bort HTML tags men behåll text-innehåll"""
        # Lägg till mellanslag innan vissa tags för att undvika att ord klister ihop
        content = re.sub(r'</(div|p|br|tr|td)>', ' ', content, flags=re.IGNORECASE)
        content = re.sub(r'<(br|hr)', ' <\\1', content, flags=re.IGNORECASE)
        
        # Ta bort alla HTML tags
        content = self.html_tag_pattern.sub('', content)
        
        return content
    
    def _remove_tracking_info(self, content: str) -> str:
        """Ta bort tracking URLs och onödig info"""
        # Ta bort URLs (de flesta är tracking)
        content = self.url_pattern.sub(' ', content)
        
        # Ta bort tracking-specifik text
        content = self.email_tracking_pattern.sub('', content)
        
        # Ta bort vanliga email signatures och footers
        footer_patterns = [
            r'Airbnb Ireland.*?$',
            r'Best regards.*?$',
            r'This email was sent.*?$',
            r'Unsubscribe.*?$'
        ]
        
        for pattern in footer_patterns:
            content = re.sub(pattern, '', content, flags=re.MULTILINE | re.IGNORECASE)
        
        return content
    
    def _normalize_whitespace(self, content: str) -> str:
        """Normalisera whitespace och line breaks"""
        # Konvertera alla line breaks till \n
        content = self.line_break_pattern.sub('\n', content)
        
        # Konvertera multipla spaces till single space
        content = self.extra_whitespace_pattern.sub(' ', content)
        
        # Rensa tomma rader (men behåll någon struktur)
        lines = content.split('\n')
        clean_lines = []
        
        for line in lines:
            line = line.strip()
            if line:  # Bara non-empty lines
                clean_lines.append(line)
        
        # Join med single line breaks
        content = '\n'.join(clean_lines)
        
        return content
    
    def _prepend_important_parts(self, content: str, important_parts: dict) -> str:
        """Lägg viktiga delar först i texten för bättre ML-parsing"""
        prefix_parts = []
        
        # Lägg booking codes först
        if important_parts['booking_codes']:
            codes = list(set(important_parts['booking_codes']))  # Remove duplicates
            prefix_parts.append(f"Bokningskod: {codes[0]}")
        
        # Lägg datum tidigt
        if important_parts['dates']:
            dates = important_parts['dates'][:4]  # Max 4 dates
            prefix_parts.append(f"Datum: {', '.join(dates)}")
        
        # Lägg belopp
        if important_parts['amounts']:
            amounts = important_parts['amounts'][:2]  # Max 2 amounts
            prefix_parts.append(f"Belopp: {', '.join(amounts)}")
        
        if prefix_parts:
            prefix = '\n'.join(prefix_parts) + '\n\n'
            content = prefix + content
        
        return content
    
    def _extract_main_content(self, content: str) -> str:
        """Extrahera huvudinnehåll (första relevanta delen)"""
        # Ta första 2000 chars för ML-processing (tillräckligt för de flesta emails)
        if len(content) > 2000:
            # Försök att klippa vid en naturlig breakpoint
            truncated = content[:2000]
            last_newline = truncated.rfind('\n')
            if last_newline > 1500:  # Om vi hittar en bra breakpoint
                content = truncated[:last_newline]
            else:
                content = truncated
        
        return content


def clean_email_content(raw_content: str) -> str:
    """
    Enkel wrapper-funktion för att rengöra email-innehåll
    
    Args:
        raw_content: Rå email-innehåll från Gmail API
        
    Returns:
        Rengjort innehåll för ML-parsing
    """
    cleaner = EmailContentCleaner()
    return cleaner.clean_for_ml(raw_content)


# Test function
if __name__ == "__main__":
    # Test med exempel-data
    test_content = '''
    %opentrack%
    <html><body><div>
    <p>MATTHIAS ANLÄNDER MÅNDAG, 1 SEP..</p>
    <table><tr><td>Bokningskod: HMFH9A8E35</td></tr></table>
    <div>Incheckning: mån 1 sep</div>
    <div>Utcheckning: sön 14 sep</div>
    <p>Du tjänar: € 366,25</p>
    <a href="https://tracking.airbnb.com/long-url">Link</a>
    </body></html>
    '''
    
    cleaned = clean_email_content(test_content)
    print("=== CLEANED CONTENT ===")
    print(cleaned)