#!/usr/bin/env python3
"""
Add Training Example
===================

Interactive script to add new training examples to the ML model.
"""

import sys
import os

# Import ML extractor
import importlib.util
current_dir = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("ml_extractor", os.path.join(current_dir, "ml_extractor.py"))
ml_extractor_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ml_extractor_module)
MLDataExtractor = ml_extractor_module.MLDataExtractor

def add_training_example():
    """Interactive training example addition"""
    
    print("🧠 ADD TRAINING EXAMPLE")
    print("=" * 30)
    
    # Load existing model
    extractor = MLDataExtractor()
    model_path = os.path.join(current_dir, 'ml_extractor_model.pkl')
    extractor.load_model(model_path)
    
    # Get input from user
    print("📧 Email content:")
    email_text = input("Enter email text: ")
    
    print("\n📋 Email type:")
    print("1. booking_confirmation")
    print("2. payout") 
    print("3. booking_reminder")
    print("4. cancellation")
    print("5. change_request")
    print("6. modification")
    
    email_type_map = {
        '1': 'booking_confirmation',
        '2': 'payout',
        '3': 'booking_reminder', 
        '4': 'cancellation',
        '5': 'change_request',
        '6': 'modification'
    }
    
    choice = input("Select email type (1-6): ")
    email_type = email_type_map.get(choice, 'booking_confirmation')
    
    # Get correct labels
    labels = {}
    
    print(f"\n🎯 Enter correct values for {email_type}:")
    
    # Common fields
    if input("Host earnings EUR? (y/n): ").lower() == 'y':
        labels['hostEarningsEur'] = float(input("Value: "))
    
    if input("Host earnings SEK? (y/n): ").lower() == 'y':
        labels['hostEarningsSek'] = float(input("Value: "))
        
    if input("Guest name? (y/n): ").lower() == 'y':
        labels['guestName'] = input("Name: ")
    
    if input("Guest total EUR? (y/n): ").lower() == 'y':
        labels['guestTotalEur'] = float(input("Value: "))
        
    if input("Cleaning fee EUR? (y/n): ").lower() == 'y':
        labels['cleaningFeeEur'] = float(input("Value: "))
    
    # Add training example
    extractor.add_training_example(email_text, email_type, labels)
    
    print("✅ Training example added!")
    print(f"📧 Type: {email_type}")
    print(f"🎯 Labels: {labels}")
    
    # Save updated model
    extractor.save_model(model_path)
    print(f"💾 Model saved: {model_path}")

if __name__ == '__main__':
    add_training_example()