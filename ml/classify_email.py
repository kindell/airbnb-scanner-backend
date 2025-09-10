#!/usr/bin/env python3
"""
Email Classification Script
===========================

This script is called by the Node.js TypeScript application to classify
and extract data from Airbnb emails using the trained ML model.

Input: JSON via stdin with {subject, sender, body}
Output: JSON with classification results and extracted data
"""

import sys
import json
import os
import re

# Add current directory to path so we can import our modules
current_dir = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, current_dir)

import importlib.util
spec = importlib.util.spec_from_file_location("email_classifier", os.path.join(current_dir, "email-classifier.py"))
email_classifier_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(email_classifier_module)
AirbnbEmailClassifier = email_classifier_module.AirbnbEmailClassifier

# Enhanced Payout Parser class (inline to avoid import issues)
class EnhancedPayoutParser:
    def __init__(self):
        # Patterns for extracting EUR amounts from email body
        self.eur_patterns = [
            # Pattern: €368,60 + €45,60 = 4 612,87 kr
            r'€\s*(\d+(?:[\s,]\d{3})*(?:[.,]\d{2})?)\s*\+\s*€\s*(\d+(?:[\s,]\d{3})*(?:[.,]\d{2})?)\s*=\s*(\d+(?:[\s,]\d{3})*(?:[.,]\d{2})?)\s*kr',
            
            # Pattern: €2394,73 = 27 528,94 kr  
            r'€\s*(\d+(?:[\s,]\d{3})*(?:[.,]\d{2})?)\s*=\s*(\d+(?:[\s,]\d{3})*(?:[.,]\d{2})?)\s*kr',
            
            # Generic EUR amounts 
            r'€\s*(\d+(?:[\s,]\d{3})*(?:[.,]\d{2})?)',
            r'(\d+(?:[\s,]\d{3})*(?:[.,]\d{2})?)\s*€',
        ]
        
        # Pattern for SEK from subject
        self.sek_subject_pattern = r'En utbetalning på ([\d\s,]+(?:\.\d{2})?) *kr|A ([\d\s,]+(?:\.\d{2})?) *kr payout was sent'
    
    def normalize_amount(self, amount_str):
        """Convert various number formats to float"""
        if not amount_str:
            return 0.0
        
        # Remove spaces and handle different decimal separators
        cleaned = amount_str.replace(' ', '').replace('\u00a0', '')  # Remove regular and non-breaking spaces
        
        # Handle European format: 1,234.56 or 1 234,56
        if ',' in cleaned and '.' in cleaned:
            # Check which comes last to determine decimal separator
            last_comma = cleaned.rfind(',')
            last_dot = cleaned.rfind('.')
            
            if last_dot > last_comma:
                # Dot is decimal separator: 1,234.56
                cleaned = cleaned.replace(',', '')
            else:
                # Comma is decimal separator: 1.234,56
                cleaned = cleaned.replace('.', '').replace(',', '.')
        elif ',' in cleaned:
            # Only comma - could be thousand separator or decimal
            parts = cleaned.split(',')
            if len(parts) == 2 and len(parts[1]) == 2:
                # Likely decimal: 123,45
                cleaned = parts[0] + '.' + parts[1]
        
        try:
            return float(cleaned)
        except ValueError:
            return 0.0
    
    def extract_eur_breakdown(self, body):
        """Extract EUR amounts and breakdown from email body"""
        results = {
            'hostEarningsEur': 0.0,
            'cleaningFeeEur': 0.0, 
            'totalEur': 0.0,
        }
        
        # Try calculation patterns first (most reliable)
        for pattern in self.eur_patterns[:2]:  # First 2 are calculation patterns
            match = re.search(pattern, body, re.IGNORECASE)
            if match:
                if '+' in pattern and len(match.groups()) >= 3:
                    # Pattern: €X + €Y = Z kr
                    eur1 = self.normalize_amount(match.group(1))
                    eur2 = self.normalize_amount(match.group(2))
                    
                    results['hostEarningsEur'] = eur1
                    results['cleaningFeeEur'] = eur2
                    results['totalEur'] = eur1 + eur2
                    return results
                elif '=' in pattern and len(match.groups()) >= 2:
                    # Pattern: €X = Y kr
                    eur = self.normalize_amount(match.group(1))
                    
                    results['hostEarningsEur'] = eur
                    results['totalEur'] = eur
                    return results
        
        # Fallback: look for any EUR amounts
        eur_amounts = []
        for pattern in self.eur_patterns[2:]:  # Generic patterns
            matches = re.findall(pattern, body, re.IGNORECASE)
            for match in matches:
                amount = self.normalize_amount(match)
                if amount > 0:
                    eur_amounts.append(amount)
        
        # If we found EUR amounts, use the largest as host earnings
        if eur_amounts:
            results['hostEarningsEur'] = max(eur_amounts)
            results['totalEur'] = results['hostEarningsEur']
        
        return results
    
    def parse_payout_email(self, subject, body):
        """Main parsing function"""
        result = {
            'hostEarningsEur': 0.0,
            'cleaningFeeEur': 0.0,
            'totalEur': 0.0,
        }
        
        # Extract EUR breakdown from body
        eur_data = self.extract_eur_breakdown(body)
        result.update(eur_data)
        
        return result

def main():
    # Check if model exists
    model_file = os.path.join(current_dir, 'airbnb_email_classifier.pkl')
    if not os.path.exists(model_file):
        print(json.dumps({"error": "ML model not found"}), file=sys.stderr)
        sys.exit(1)
    
    try:
        # Read input from stdin
        input_data = json.loads(sys.stdin.read())
        
        subject = input_data.get('subject', '')
        sender = input_data.get('sender', '')
        body = input_data.get('body', '')
        email_date = input_data.get('emailDate', None)  # Optional email date
        print(f"[DEBUG INPUT] emailDate from input: {email_date}", file=sys.stderr)
        
        # Load and use classifier
        classifier = AirbnbEmailClassifier()
        classifier.load_model(model_file)
        
        # Classify email
        email_type, confidence = classifier.classify_email(subject, sender, body)
        
        # Debug payout emails AND confirmation emails specifically
        if email_type == 'payout':
            print(f"[DEBUG] Payout email - Subject: '{subject}', Sender: '{sender}', Body length: {len(body)}", file=sys.stderr)
        
        # Debug all confirmation emails temporarily
        if email_type == 'booking_confirmation' or 'HMF4MBHP35' in body or 'HMFH9A8E35' in body:
            import time
            timestamp = time.time()
            booking_code = 'hmf4mbhp35' if 'HMF4MBHP35' in body else 'hmfh9a8e35'
            print(f"[DEBUG] {booking_code.upper()} found in {email_type} - Subject: '{subject}', Body sample: {body[:500]}...", file=sys.stderr)
            # Save content to file for debugging with timestamp
            with open(f'/tmp/{booking_code}_content_{timestamp}.txt', 'w') as f:
                f.write(f"TIMESTAMP: {timestamp}\n")
                f.write(f"EMAIL TYPE: {email_type}\n")
                f.write(f"SUBJECT: {subject}\n")
                f.write(f"SENDER: {sender}\n")
                f.write(f"BODY LENGTH: {len(body)}\n")
                f.write(f"BODY:\n{body}")
            print(f"[DEBUG] {booking_code.upper()} content saved to: /tmp/{booking_code}_content_{timestamp}.txt", file=sys.stderr)
        
        # Extract data
        extracted_data = classifier.extract_booking_data(email_type, subject, sender, body, email_date)
        
        # Enhanced payout parsing - extract precise EUR amounts from email body
        if email_type == 'payout':
            try:
                payout_parser = EnhancedPayoutParser()
                enhanced_data = payout_parser.parse_payout_email(subject, body)
                
                # Override with precise EUR amounts if found
                if enhanced_data.get('totalEur', 0) > 0:
                    print(f"[ENHANCED PAYOUT] Found EUR in body: €{enhanced_data['totalEur']:.2f} (host: €{enhanced_data['hostEarningsEur']:.2f}, cleaning: €{enhanced_data['cleaningFeeEur']:.2f})", file=sys.stderr)
                    
                    # Use the precise EUR amounts from email body
                    extracted_data['hostEarningsEur'] = enhanced_data['totalEur']  # Total EUR for host earnings
                    if enhanced_data['cleaningFeeEur'] > 0:
                        extracted_data['cleaningFeeEur'] = enhanced_data['cleaningFeeEur']
                        # If we have a breakdown, use just the host portion
                        extracted_data['hostEarningsEur'] = enhanced_data['hostEarningsEur']
                        
                    print(f"[ENHANCED PAYOUT] Final amounts: host €{extracted_data['hostEarningsEur']:.2f}, cleaning €{extracted_data.get('cleaningFeeEur', 0):.2f}", file=sys.stderr)
                else:
                    print(f"[ENHANCED PAYOUT] No EUR amounts found in body, using original parsing", file=sys.stderr)
                    
            except Exception as e:
                print(f"[ENHANCED PAYOUT ERROR] {str(e)}", file=sys.stderr)
        
        # Prepare result
        result = {
            "emailType": email_type,
            "confidence": float(confidence),
            "bookingCode": extracted_data.get('bookingCode'),
            "guestName": extracted_data.get('guestName'),
            # CRITICAL: Set status based on email type
            "status": "cancelled" if email_type == "cancellation" else ("confirmed" if email_type == "booking_confirmation" else extracted_data.get('status')),
            "amount": extracted_data.get('amount'),
            "currency": extracted_data.get('currency'),
            "debug_subject": subject if email_type == 'payout' else None,
            "debug_amount_match": "Found amount in text" if email_type == 'payout' and extracted_data.get('amount') else ("No amount match" if email_type == 'payout' else None),
            "checkInDate": extracted_data.get('checkInDate'),
            "checkOutDate": extracted_data.get('checkOutDate'),
            # Change request specific fields
            "originalCheckInDate": extracted_data.get('originalCheckInDate'),
            "originalCheckOutDate": extracted_data.get('originalCheckOutDate'),
            # Financial data
            "nights": extracted_data.get('nights'),
            # EUR fields
            "guestTotalEur": extracted_data.get('guestTotalEur'),
            "hostEarningsEur": extracted_data.get('hostEarningsEur'),
            "cleaningFeeEur": extracted_data.get('cleaningFeeEur'),
            "nightlyRateEur": extracted_data.get('nightlyRateEur'),
            "serviceFeeEur": extracted_data.get('serviceFeeEur'),
            "propertyTaxEur": extracted_data.get('propertyTaxEur'),
            # SEK fields (for 2020-2021)
            "guestTotalSek": extracted_data.get('guestTotalSek'),
            "hostEarningsSek": extracted_data.get('hostEarningsSek'),
            "cleaningFeeSek": extracted_data.get('cleaningFeeSek'),
            "serviceFeeSek": extracted_data.get('serviceFeeSek'),
            "guestCount": extracted_data.get('guestCount')
        }
        
        # Output result as JSON
        print(json.dumps(result))
        
    except Exception as e:
        error_result = {"error": str(e)}
        print(json.dumps(error_result), file=sys.stderr)
        sys.exit(1)

if __name__ == '__main__':
    main()