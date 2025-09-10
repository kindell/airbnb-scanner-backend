#!/usr/bin/env python3
"""
Test ML parser with actual Gmail subjects that are failing
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

def test_real_failing_subjects():
    """Test with the actual Gmail subjects that are failing in production"""
    classifier = AirbnbEmailClassifier()
    
    # Load the trained model
    model_file = 'airbnb_email_classifier.pkl'
    if os.path.exists(model_file):
        classifier.load_model(model_file)
        print(f"✅ Loaded model from {model_file}")
    else:
        print(f"❌ Model file {model_file} not found")
        return
    
    # Real Gmail subjects that we know are failing
    real_subjects = [
        "Bokning bekräftad - Eva Funding anländer 30 maj",
        "Bokning bekräftad - Sally Williams anländer 18 maj", 
        "Bokning bekräftad - Michelle MacLeod anländer 7 juni"
    ]
    
    print("🧪 TESTING REAL FAILING SUBJECTS")
    print("=" * 40)
    
    for i, subject in enumerate(real_subjects, 1):
        print(f"\n📧 Test {i}: {subject}")
        
        # Classify email type
        email_type, confidence = classifier.classify_email(
            subject, 
            'automated@airbnb.com', 
            'Booking confirmed body'
        )
        
        print(f"   Classification: {email_type} (confidence: {confidence:.3f})")
        
        # Extract booking data (include booking codes in body)
        extracted = classifier.extract_booking_data(
            email_type, 
            subject, 
            'automated@airbnb.com', 
            'Booking confirmed body HMHF5K4KSC confirmed'  # Include booking code
        )
        
        print(f"   Booking Code: {extracted.get('bookingCode', 'NULL')}")
        print(f"   Guest Name: {extracted.get('guestName', 'NULL')}")
        print(f"   Check-in Date: {extracted.get('checkInDate', 'NULL')}")
        
        # Check success/failure
        if extracted.get('guestName'):
            print("   ✅ SUCCESS: Guest name extracted")
        else:
            print("   ❌ FAILED: No guest name extracted")
            
            # Debug regex matching
            print("   🔍 DEBUGGING:")
            for j, pattern in enumerate(classifier.patterns['guest_name_confirmation']):
                import re
                match = re.search(pattern, subject, re.IGNORECASE)
                if match:
                    print(f"      Pattern {j+1} MATCHED: {match.group(1) if match.groups() else 'No groups'}")
                else:
                    print(f"      Pattern {j+1} failed: {pattern}")

if __name__ == '__main__':
    test_real_failing_subjects()