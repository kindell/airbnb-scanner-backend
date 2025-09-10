#!/usr/bin/env python3
"""
Update the pickle file with new patterns
"""

import pickle
import os
import sys

# Add current directory to path
current_dir = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, current_dir)

# Import the classifier to get fresh patterns
import importlib.util
spec = importlib.util.spec_from_file_location("email_classifier", os.path.join(current_dir, "email-classifier.py"))
email_classifier_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(email_classifier_module)
AirbnbEmailClassifier = email_classifier_module.AirbnbEmailClassifier

def main():
    pickle_file = os.path.join(current_dir, 'airbnb_email_classifier.pkl')
    
    # Load existing model
    print("📖 Loading existing model...")
    with open(pickle_file, 'rb') as f:
        model_data = pickle.load(f)
    
    # Create fresh classifier to get updated patterns
    print("🔄 Getting fresh patterns...")
    fresh_classifier = AirbnbEmailClassifier()
    
    # Update just the patterns (keep the trained classifier)
    print("✨ Updating patterns...")
    model_data['patterns'] = fresh_classifier.patterns
    model_data['swedish_months'] = fresh_classifier.swedish_months
    
    # Save back to pickle
    print("💾 Saving updated model...")
    with open(pickle_file, 'wb') as f:
        pickle.dump(model_data, f)
    
    print(f"✅ Successfully updated {pickle_file} with new patterns!")
    print(f"📊 Patterns now include: {list(fresh_classifier.patterns.keys())}")

if __name__ == "__main__":
    main()