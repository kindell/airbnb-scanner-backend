#!/usr/bin/env python3
"""
Date Correction Training for ML
==============================

Specifically trains the ML model with the correct dates from CSV for
the three problematic bookings: HMCPF5PQTF, HMHF5K4KSC, HMS5AQ38ED
"""

import sys
import os
import importlib.util

# Import ML components
current_dir = os.path.dirname(os.path.abspath(__file__))

# Import ML extractor
spec = importlib.util.spec_from_file_location("ml_extractor", os.path.join(current_dir, "ml_extractor.py"))
ml_extractor_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ml_extractor_module)
MLDataExtractor = ml_extractor_module.MLDataExtractor

def train_date_corrections():
    """Train ML with correct dates from CSV"""
    
    print("🗓️  TRAINING ML FOR DATE CORRECTIONS")
    print("=" * 50)
    
    # Initialize ML extractor
    ml_extractor = MLDataExtractor()
    
    # Load existing model
    model_path = os.path.join(current_dir, 'ml_extractor_model.pkl')
    ml_extractor.load_model(model_path)
    
    # Correct date training examples from CSV data
    training_examples = [
        {
            'booking_code': 'HMCPF5PQTF',
            'guest_name': 'Jakob Tønder',
            'checkin_date': '2026-05-21',
            'checkout_date': '2026-05-24',
            'nights': 3
        },
        {
            'booking_code': 'HMHF5K4KSC', 
            'guest_name': 'Sally Williams',
            'checkin_date': '2026-05-18',
            'checkout_date': '2026-05-21',
            'nights': 3
        },
        {
            'booking_code': 'HMS5AQ38ED',
            'guest_name': 'Michelle MacLeod', 
            'checkin_date': '2026-06-07',
            'checkout_date': '2026-06-11',
            'nights': 4
        }
    ]
    
    training_count = 0
    
    for example in training_examples:
        # Create synthetic confirmation email with correct dates
        email_text = f"""
Bokningskod: {example['booking_code']}
Bokning bekräftad för {example['guest_name']}

Ankomst: {example['checkin_date']}
Avresa: {example['checkout_date']}
Antal nätter: {example['nights']}

Incheckning {example['checkin_date']}
Utcheckning {example['checkout_date']}
        """.strip()
        
        labels = {
            'bookingCode': example['booking_code'],
            'guestName': example['guest_name'],
            'checkInDate': example['checkin_date'],
            'checkOutDate': example['checkout_date'], 
            'nights': example['nights']
        }
        
        print(f"🧠 Adding training example for {example['booking_code']}")
        print(f"   Check-in: {example['checkin_date']}")
        print(f"   Check-out: {example['checkout_date']}")
        print(f"   Nights: {example['nights']}")
        
        ml_extractor.add_training_example(
            email_text,
            'booking_confirmation',
            labels
        )
        
        training_count += 1
    
    print(f"\n🤖 Retraining ML model with {training_count} date correction examples...")
    ml_extractor.train_classifiers()
    
    print(f"💾 Saving updated model...")
    ml_extractor.save_model(model_path)
    
    print(f"\n🎉 Date correction training complete!")
    print(f"🧠 Added {training_count} date training examples")
    print(f"💾 Model updated: {model_path}")

if __name__ == '__main__':
    train_date_corrections()