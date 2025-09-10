#!/usr/bin/env python3
"""
Debug Real Email Formats
========================

Fetch a specific email from Gmail to see the exact subject/body format
that our regex patterns need to match.
"""

import json
import sys
import os

# Add current directory to path
current_dir = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, current_dir)

# Import our classifier
import importlib.util
spec = importlib.util.spec_from_file_location("email_classifier", os.path.join(current_dir, "email-classifier.py"))
email_classifier_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(email_classifier_module)
AirbnbEmailClassifier = email_classifier_module.AirbnbEmailClassifier

def test_patterns():
    """Test patterns against known email formats"""
    classifier = AirbnbEmailClassifier()
    
    # Known examples from our logs
    test_cases = [
        {
            "bookingCode": "HM3RY99SBR",
            "expectedGuest": "Eva Funding",
            "expectedDate": "2026-05-30",
            # These are hypothetical subjects - we need to test with real ones
            "test_subjects": [
                # REAL Gmail subjects we found:
                "Bokning bekräftad - Eva Funding anländer 30 maj",
                "Bokning bekräftad - Sally Williams anländer 18 maj", 
                "Bokning bekräftad - Michelle MacLeod anländer 7 juni",
                # Additional test cases
                "Reservation confirmed - Eva Funding arrives May 30", 
                "Ny bokning bekräftad! Eva Funding anländer 30 maj.",
                "Din bokning är bekräftad: Eva Funding anländer 30 maj"
            ]
        }
    ]
    
    print("🧪 TESTING REGEX PATTERNS")
    print("=" * 40)
    
    for case in test_cases:
        print(f"\n📧 Testing booking: {case['bookingCode']}")
        print(f"   Expected Guest: {case['expectedGuest']}")
        print(f"   Expected Date: {case['expectedDate']}")
        
        for i, subject in enumerate(case['test_subjects']):
            print(f"\n   Test Subject {i+1}: {subject}")
            
            # Test guest name extraction
            email_type = 'booking_confirmation'
            extracted = classifier.extract_booking_data(email_type, subject, 'automated@airbnb.com', f'Booking {case["bookingCode"]} confirmed')
            
            print(f"   → Guest Name: {extracted.get('guestName', 'NULL')}")
            print(f"   → Check-in Date: {extracted.get('checkInDate', 'NULL')}")
            print(f"   → Booking Code: {extracted.get('bookingCode', 'NULL')}")
            
            # Check if we got the expected results
            if extracted.get('guestName') == case['expectedGuest']:
                print("   ✅ Guest name extraction SUCCESS")
            else:
                print("   ❌ Guest name extraction FAILED")
                
            if extracted.get('checkInDate') == case['expectedDate']:
                print("   ✅ Date extraction SUCCESS") 
            else:
                print("   ❌ Date extraction FAILED")

def main():
    test_patterns()
    
    print(f"\n\n💡 NEXT STEPS:")
    print("1. Check debug output from real Gmail emails")
    print("2. Update regex patterns based on actual email format")
    print("3. Re-train model with corrected patterns")

if __name__ == '__main__':
    main()