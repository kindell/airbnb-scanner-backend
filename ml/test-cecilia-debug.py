#!/usr/bin/env python3
"""
Debug script specifically for Cecilia case
"""

import sys
import re
sys.path.append('.')
exec(open('email-classifier.py').read())

def debug_cecilia_patterns():
    """Debug pattern matching for Cecilia case"""
    
    classifier = AirbnbEmailClassifier()
    
    # Common email content patterns that might be in the real email
    test_cases = [
        "Du tjänar: €3,00",
        "du tjänar €3,00", 
        "Du tjänar €3,00",
        "Värdens intäkter: €3,00",
        "Host earnings: €3.00",
        "€3,00 Du tjänar",
        "€225,00 x 2 nätter = €450,00\nDu tjänar: €3,00",
        "Total: €500,00\nDu tjänar: €3,00\nServiceavgift: €225,00",
    ]
    
    print("🔍 Testing Host Earnings Pattern:")
    print("=" * 50)
    
    for i, test_text in enumerate(test_cases):
        print(f"\nTest {i+1}: '{test_text}'")
        match = re.search(classifier.patterns['host_earnings_eur'], test_text, re.IGNORECASE)
        if match:
            print(f"  ✅ Match: {match.groups()}")
            amount_str = match.group(1) or match.group(2)
            amount_str = re.sub(r'[\s\u00a0]+', '', amount_str).replace(',', '.')
            print(f"  💰 Parsed amount: {float(amount_str)}")
        else:
            print(f"  ❌ No match")
    
    print("\n" + "=" * 50)
    print("🗓️  Testing Date Pattern:")
    
    date_test_cases = [
        "Incheckning: sön 13 juli 2025\nUtcheckning: tis 15 juli 2025",
        "13 juli 2025 - 15 juli 2025", 
        "13 juli - 15 juli",
        "13 juli 27 juli",  # What might cause the wrong date selection
        "Incheckning sön 13 juli\nUtcheckning tis 15 juli\nMen också 27 juli finns här",
    ]
    
    for i, test_text in enumerate(date_test_cases):
        print(f"\nDate test {i+1}: '{test_text}'")
        
        # Test fallback pattern
        all_dates_pattern = r'(\d{1,2})\s+(jan|feb|mar|apr|maj|jun|jul|aug|sep|okt|nov|dec|januari|februari|mars|april|maj|juni|juli|augusti|september|oktober|november|december)\.?\s*(?:(\d{4}))?'
        all_dates = re.findall(all_dates_pattern, test_text, re.IGNORECASE)
        print(f"  📅 All dates found: {all_dates}")
        
        if all_dates:
            # Simulate the date parsing logic
            parsed_dates = []
            for day, month, year in all_dates:
                if month.lower() in classifier.swedish_months:
                    if not year:
                        year = "2025"  # Assume current year
                    try:
                        from datetime import datetime
                        date_obj = datetime.strptime(f"{year}-{classifier.swedish_months[month.lower()]}-{day.zfill(2)}", "%Y-%m-%d")
                        date_str = f"{year}-{classifier.swedish_months[month.lower()]}-{day.zfill(2)}"
                        parsed_dates.append((date_obj, date_str))
                    except ValueError:
                        continue
            
            if len(parsed_dates) >= 2:
                parsed_dates.sort(key=lambda x: x[0])
                print(f"  🔄 Sorted dates: {[d[1] for d in parsed_dates]}")
                
                # Check for realistic pairs
                for i in range(len(parsed_dates)):
                    for j in range(i + 1, len(parsed_dates)):
                        checkin_date, checkin_str = parsed_dates[i]
                        checkout_date, checkout_str = parsed_dates[j]
                        nights = (checkout_date - checkin_date).days
                        print(f"    📊 {checkin_str} → {checkout_str}: {nights} nights")
                        
                        if 1 <= nights <= 30:
                            print(f"    ✅ SELECTED: {checkin_str} → {checkout_str}")
                            break

if __name__ == '__main__':
    debug_cecilia_patterns()