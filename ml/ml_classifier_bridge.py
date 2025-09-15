#!/usr/bin/env python3
"""
ML Classifier Bridge
===================

Bridges the old email-classifier.py with the new ML-based extractor.
Provides backwards compatibility while adding ML-powered extraction.
"""

import sys
import json
import os

# Import both old and new systems
import importlib.util

# Load old classifier
current_dir = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("email_classifier", os.path.join(current_dir, "email-classifier.py"))
email_classifier_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(email_classifier_module)
AirbnbEmailClassifier = email_classifier_module.AirbnbEmailClassifier

# Load new ML extractor
spec_ml = importlib.util.spec_from_file_location("ml_extractor", os.path.join(current_dir, "ml_extractor.py"))
ml_extractor_module = importlib.util.module_from_spec(spec_ml)
spec_ml.loader.exec_module(ml_extractor_module)
MLDataExtractor = ml_extractor_module.MLDataExtractor

class MLClassifierBridge:
    def __init__(self):
        # Initialize both systems
        self.old_classifier = AirbnbEmailClassifier()
        self.ml_extractor = MLDataExtractor()
        
        # Try to load existing ML model
        model_path = os.path.join(current_dir, 'ml_extractor_model.pkl')
        self.ml_extractor.load_model(model_path)
        
        # Load old model for classification
        old_model_path = os.path.join(current_dir, 'airbnb_email_classifier.pkl')
        if os.path.exists(old_model_path):
            self.old_classifier.load_model(old_model_path)
    
    def classify_and_extract(self, subject, sender, body, email_date=None):
        """Classify email type using old system, extract data using ML system"""
        
        # Use old classifier for email type (it's well-trained)
        email_type, confidence = self.old_classifier.classify_email(subject, sender, body)
        
        print(f"[BRIDGE] Email classified as: {email_type} (confidence: {confidence:.3f})", file=sys.stderr)
        
        # Use ML extractor for data extraction (more intelligent)
        extracted_data = self.ml_extractor.extract_data(body, email_type)
        
        # Fallback to old extraction for fields not found by ML
        # Pass None for scanning_year - we should use email_date instead
        old_data = self.old_classifier.extract_booking_data(email_type, subject, sender, body, email_date, None)
        
        # Merge results, prioritizing ML extractor
        result = {}
        
        # Start with old data as base
        for key, value in old_data.items():
            if value is not None:
                result[key] = value
        
        # Override with ML extractor results (higher quality)
        for key, value in extracted_data.items():
            if value is not None:
                # Validate guest name - reject obvious parsing errors
                if key == 'guestName' and self._is_invalid_guest_name(value):
                    print(f"[BRIDGE] Rejecting invalid guest name: {value}", file=sys.stderr)
                    continue
                result[key] = value
                print(f"[BRIDGE] ML override: {key} = {value}", file=sys.stderr)
        
        # Add metadata
        result['emailType'] = email_type
        result['confidence'] = float(confidence)
        
        return result
    
    def _is_invalid_guest_name(self, name):
        """Check if a guest name is likely a parsing error"""
        if not name or not isinstance(name, str):
            return True
            
        name = name.strip().lower()
        
        # Swedish parsing error patterns
        invalid_patterns = [
            'timmar efter det att din gäst',
            'efter det att din gäst',
            'din gäst',
            'bekräftelse',
            'bokning',
            'reservation',
            'checka',
            'airbnb',
            'confirmed',
            'confirmation',
            'your guest',
            'guest',
            'booking',
            'check-in',
            'checkout'
        ]
        
        # Check if name contains invalid patterns
        for pattern in invalid_patterns:
            if pattern in name:
                return True
        
        # Check if it's too long (likely instruction text)
        if len(name) > 50:
            return True
            
        # Check if it contains multiple sentences (periods, exclamation marks)
        if '.' in name or '!' in name or '?' in name:
            return True
            
        return False

def worker_mode():
    """Run in persistent worker mode for ML Worker Pool"""
    
    # Check if model exists
    model_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'airbnb_email_classifier.pkl')
    if not os.path.exists(model_file):
        print(json.dumps({"error": "ML model not found"}), file=sys.stderr)
        sys.exit(1)
    
    # Initialize bridge once (expensive operation)
    bridge = MLClassifierBridge()
    
    # Signal ready to Node.js (force to stdout with explicit buffering control)
    sys.stdout.write("READY\n")
    sys.stdout.flush()
    sys.stderr.write("Worker ready signal sent\n")
    sys.stderr.flush()
    
    # Process tasks from stdin continuously
    try:
        while True:
            line = sys.stdin.readline()
            if not line:  # EOF, worker should exit
                break
                
            line = line.strip()
            if not line:  # Empty line, skip
                continue
                
            try:
                # Parse task data
                input_data = json.loads(line)
                
                subject = input_data.get('subject', '')
                sender = input_data.get('sender', '')
                body = input_data.get('body', '')
                email_date = input_data.get('emailDate', None)
                
                # Use bridge to classify and extract
                result = bridge.classify_and_extract(subject, sender, body, email_date)
                
                # Output result as JSON with newline terminator
                print(json.dumps(result))
                sys.stdout.flush()
                
            except Exception as e:
                # Send error response
                error_result = {"error": str(e)}
                print(json.dumps(error_result))
                sys.stdout.flush()
                
    except KeyboardInterrupt:
        # Graceful shutdown
        sys.exit(0)
    except Exception as e:
        print(json.dumps({"error": f"Worker error: {str(e)}"}), file=sys.stderr)
        sys.exit(1)

def main():
    """Main function for command-line usage (same interface as classify_email.py)"""
    
    # Check if model exists
    model_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'airbnb_email_classifier.pkl')
    if not os.path.exists(model_file):
        print(json.dumps({"error": "ML model not found"}), file=sys.stderr)
        sys.exit(1)
    
    try:
        # Read input from stdin (same as classify_email.py)
        input_data = json.loads(sys.stdin.read())
        
        # Debug: log what we received
        print(f"[DEBUG INPUT] Received keys: {list(input_data.keys())}", file=sys.stderr)
        print(f"[DEBUG INPUT] emailDate value: {input_data.get('emailDate', 'NOT_FOUND')}", file=sys.stderr)
        
        subject = input_data.get('subject', '')
        sender = input_data.get('sender', '')
        body = input_data.get('body', '')
        email_date = input_data.get('emailDate', None)
        
        # Use bridge to classify and extract
        bridge = MLClassifierBridge()
        result = bridge.classify_and_extract(subject, sender, body, email_date)
        
        # Output result as JSON (same format as classify_email.py)
        print(json.dumps(result))
        
    except Exception as e:
        error_result = {"error": str(e)}
        print(json.dumps(error_result), file=sys.stderr)
        sys.exit(1)

if __name__ == '__main__':
    # Check for worker mode argument
    if len(sys.argv) > 1 and sys.argv[1] == '--worker-mode':
        worker_mode()
    else:
        main()