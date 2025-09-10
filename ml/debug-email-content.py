#!/usr/bin/env python3
"""
Debug script to analyze actual email content for date extraction issues
"""

import sys
import json
sys.path.append('.')
exec(open('email-classifier.py').read())

def debug_email_content(gmail_content, expected_checkout):
    """Debug why date extraction is wrong"""
    print("=" * 60)
    print("DEBUGGING EMAIL CONTENT")
    print("=" * 60)
    
    # Show content length and snippet
    print(f"Content length: {len(gmail_content)} chars")
    print(f"Expected checkout: {expected_checkout}")
    print()
    
    # Look for all date patterns
    import re
    
    # Find all date-like patterns
    date_patterns = [
        r'(\d{1,2})\s+(jan|feb|mar|apr|maj|jun|jul|aug|sep|okt|nov|dec|januari|februari|mars|april|maj|juni|juli|augusti|september|oktober|november|december)',
        r'(\w{3})\s+(\d{1,2})\s+(\w+)',
        r'Incheckning.*?(\d{1,2})\s+(\w+)',
        r'Utcheckning.*?(\d{1,2})\s+(\w+)',
    ]
    
    print("🔍 FOUND DATE PATTERNS:")
    for i, pattern in enumerate(date_patterns):
        matches = re.findall(pattern, gmail_content, re.IGNORECASE)
        if matches:
            print(f"  Pattern {i+1}: {matches[:5]}")  # Show first 5 matches
    
    print("\n📝 CONTENT SAMPLE (first 1000 chars):")
    print(gmail_content[:1000])
    print("\n" + "." * 50)
    
    print("\n📝 CONTENT SAMPLE (around 'juli'):")
    juli_pos = gmail_content.lower().find('juli')
    if juli_pos >= 0:
        start = max(0, juli_pos - 200)
        end = min(len(gmail_content), juli_pos + 200)
        print(gmail_content[start:end])
    else:
        print("No 'juli' found")
    
    print("\n" + "=" * 60)

if __name__ == '__main__':
    # For testing, just call with sample data
    sample_content = """
    Sample email content would go here.
    Incheckning: sön 13 juli 2025
    Utcheckning: tis 15 juli 2025 
    This should extract correctly.
    """
    
    debug_email_content(sample_content, "2025-07-15")