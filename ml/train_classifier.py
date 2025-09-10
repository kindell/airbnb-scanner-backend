#!/usr/bin/env python3
"""
ML Training Script for Airbnb Email Classifier
=============================================

This script trains the machine learning model for classifying Airbnb emails.
It loads training data, trains the classifier, and saves the model for production use.
"""

import os
import sys
sys.path.append('.')
exec(open('email-classifier.py').read())

def main():
    print("🤖 AIRBNB EMAIL ML CLASSIFIER - TRAINING")
    print("=" * 50)
    
    classifier = AirbnbEmailClassifier()
    
    # Load training data from parent directory
    training_file = '../ml-training-data.json'
    if not os.path.exists(training_file):
        print(f"❌ Training data file not found: {training_file}")
        print("Please ensure ml-training-data.json exists in the project root.")
        sys.exit(1)
    
    try:
        X, y, emails = classifier.load_training_data(training_file)
    except Exception as e:
        print(f"❌ Error loading training data: {e}")
        sys.exit(1)
    
    # Train model
    try:
        X_test, y_test, y_pred = classifier.train(X, y)
    except Exception as e:
        print(f"❌ Error training model: {e}")
        sys.exit(1)
    
    # Save model
    model_file = 'airbnb_email_classifier.pkl'
    try:
        classifier.save_model(model_file)
    except Exception as e:
        print(f"❌ Error saving model: {e}")
        sys.exit(1)
    
    import numpy as np
    accuracy = np.mean(y_pred == y_test)
    print(f"\n🎉 Training complete!")
    print(f"📊 Model accuracy: {accuracy:.3f}")
    print(f"💾 Model saved as: {model_file}")
    
    # Test on a few examples to verify the model works
    print(f"\n🧪 QUICK VERIFICATION TEST:")
    print("=" * 30)
    
    test_cases = [
        {
            'subject': 'Bokning bekräftad - Anna Andersson anländer 15 juli',
            'sender': 'Airbnb <automated@airbnb.com>',
            'body': 'Din bokning HM123ABC456 är bekräftad.'
        },
        {
            'subject': 'En utbetalning på 15 234,56 kr skickades',
            'sender': 'Airbnb <express@airbnb.com>',
            'body': 'Utbetalning för bokning HM456DEF789 har skickats.'
        }
    ]
    
    for i, test in enumerate(test_cases):
        try:
            email_type, confidence = classifier.classify_email(
                test['subject'], test['sender'], test['body']
            )
            
            print(f"📧 Test {i+1}: {email_type} (confidence: {confidence:.3f})")
        except Exception as e:
            print(f"❌ Error in test {i+1}: {e}")

if __name__ == '__main__':
    main()