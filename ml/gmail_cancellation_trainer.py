#!/usr/bin/env python3
"""
Gmail Cancellation Trainer
==========================

Searches Gmail for cancellation emails and trains ML system on real examples.
"""

import sys
import os
import json
import sqlite3
from datetime import datetime
import pandas as pd
import glob

# Import Gmail and ML components
sys.path.append('../')

import importlib.util
current_dir = os.path.dirname(os.path.abspath(__file__))

# Import ML extractor
spec = importlib.util.spec_from_file_location("ml_extractor", os.path.join(current_dir, "ml_extractor.py"))
ml_extractor_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ml_extractor_module)
MLDataExtractor = ml_extractor_module.MLDataExtractor

# Import Gmail utilities (assuming they exist in the parent directory)
try:
    sys.path.append('../src/utils')
    from gmail_service import get_gmail_service, search_emails, get_email_content
except ImportError:
    print("⚠️  Gmail utilities not available, creating mock training data")
    get_gmail_service = None

class GmailCancellationTrainer:
    def __init__(self, csv_dir="../csv"):
        self.csv_dir = csv_dir
        self.ml_extractor = MLDataExtractor()
        
        # Load existing ML model
        model_path = os.path.join(current_dir, 'ml_extractor_model.pkl')
        self.ml_extractor.load_model(model_path)
        
    def load_cancelled_bookings_from_csv(self):
        """Load all cancelled bookings from CSV files"""
        
        print("🔍 Loading cancelled bookings from CSV files...")
        
        csv_files = glob.glob(os.path.join(self.csv_dir, "*.csv"))
        cancelled_bookings = {}
        
        for csv_file in csv_files:
            try:
                df = pd.read_csv(csv_file)
                
                # Find cancelled bookings
                cancelled_rows = df[df['Status'].str.contains('Cancel', case=False, na=False)]
                
                for _, row in cancelled_rows.iterrows():
                    booking_code = row['Confirmation code']
                    
                    # Parse earnings (should be 0 for cancelled)
                    earnings_str = str(row['Earnings']).replace('€', '').replace(' ', '').replace(',', '.')
                    try:
                        earnings = float(earnings_str)
                    except:
                        earnings = 0.0
                    
                    cancelled_bookings[booking_code] = {
                        'bookingCode': booking_code,
                        'guestName': row['Guest name'],
                        'status': row['Status'],
                        'hostEarningsEur': earnings,  # Should be 0
                        'originalAmount': None,  # We don't have this from CSV
                        'checkInDate': row['Start date'],
                        'checkOutDate': row['End date'],
                        'nights': int(row['# of nights']) if pd.notna(row['# of nights']) else None
                    }
                    
            except Exception as e:
                print(f"   ❌ Error loading {csv_file}: {e}")
        
        print(f"📋 Found {len(cancelled_bookings)} cancelled bookings in CSV")
        return cancelled_bookings
    
    def search_gmail_for_cancellations(self, cancelled_bookings):
        """Search Gmail for cancellation emails for specific bookings"""
        
        if not get_gmail_service:
            print("⚠️  Gmail service not available, using mock data")
            return self.create_mock_cancellation_emails(cancelled_bookings)
        
        print("🔍 Searching Gmail for cancellation emails...")
        
        try:
            service = get_gmail_service()
            cancellation_emails = {}
            
            for booking_code, booking_info in list(cancelled_bookings.items())[:10]:  # Increased to 10
                print(f"   Searching Gmail for {booking_code} (€{booking_info['hostEarningsEur']:.2f})...")
                
                # Search for booking code AND cancellation keywords
                search_queries = [
                    f'{booking_code} avbokad',
                    f'{booking_code} avbokning', 
                    f'{booking_code} cancelled',
                    f'{booking_code} canceled',
                    f'{booking_code} "canceled by guest"',
                    f'{booking_code} reservation'
                ]
                
                for query in search_queries:
                    try:
                        email_ids = search_emails(service, query, max_results=5)
                        
                        for email_id in email_ids:
                            email_content = get_email_content(service, email_id)
                            
                            if booking_code in email_content.get('body', ''):
                                cancellation_emails[booking_code] = {
                                    'booking_info': booking_info,
                                    'email_content': email_content,
                                    'gmail_id': email_id
                                }
                                print(f"   ✅ Found cancellation email for {booking_code}")
                                break
                        
                        if booking_code in cancellation_emails:
                            break
                            
                    except Exception as e:
                        print(f"   ⚠️  Error searching for {booking_code}: {e}")
            
            print(f"📧 Found {len(cancellation_emails)} cancellation emails in Gmail")
            return cancellation_emails
            
        except Exception as e:
            print(f"❌ Gmail search failed: {e}")
            return self.create_mock_cancellation_emails(cancelled_bookings)
    
    def create_mock_cancellation_emails(self, cancelled_bookings):
        """Create realistic mock cancellation emails for training"""
        
        print("🎭 Creating mock cancellation emails for training...")
        
        mock_emails = {}
        
        # Ensure we get both types: zero-payout and with-payout cancellations
        zero_payout = [code for code, info in cancelled_bookings.items() if info['hostEarningsEur'] == 0.0]
        with_payout = [code for code, info in cancelled_bookings.items() if info['hostEarningsEur'] > 0.0]
        
        # Take up to 5 of each type for balanced training
        selected_codes = zero_payout[:5] + with_payout[:5]
        
        for booking_code in selected_codes:
            booking_info = cancelled_bookings[booking_code]
            guest_name = booking_info['guestName']
            earnings = booking_info['hostEarningsEur']
            
            # Two types of cancellations:
            # 1. Standard cancellation (no payout) - earnings = 0
            # 2. Cancelled with payout (guest paid cancellation fee) - earnings > 0
            
            if earnings == 0.0:
                # Standard cancellation - no payout
                mock_content = f"""
Subject: Bokning avbokad - {booking_code}

Hej,

Din bokning {booking_code} med {guest_name} har avbokats av gästen.

Bokningsdetaljer:
- Bokningskod: {booking_code}
- Gäst: {guest_name}
- Status: Avbokad av gäst
- Incheckning: {booking_info['checkInDate']}
- Utcheckning: {booking_info['checkOutDate']}

Ekonomisk påverkan:
- Du tjänar: € 0,00 (avbokad)
- Utbetalningsstatus: Ingen utbetalning kommer att ske

Avbokningen behandlades enligt vår avbokningspolicy.

Vänliga hälsningar,
Airbnb-teamet
                """.strip()
            else:
                # Cancelled with payout (partial payment due to cancellation policy)
                mock_content = f"""
Subject: Bokning avbokad med utbetalning - {booking_code}

Hej,

Din bokning {booking_code} med {guest_name} har avbokats av gästen.

Bokningsdetaljer:
- Bokningskod: {booking_code}
- Gäst: {guest_name}
- Status: Avbokad av gäst
- Incheckning: {booking_info['checkInDate']}
- Utcheckning: {booking_info['checkOutDate']}

Ekonomisk påverkan:
- Du tjänar: € {earnings:.2f} (avbokningsavgift)
- Utbetalningsstatus: Partiell utbetalning enligt avbokningspolicy

Gästen avbokade efter den strikta avbokningspolicyn, därför erhåller du en partiell betalning.

Vänliga hälsningar,
Airbnb-teamet
                """.strip()
            
            mock_emails[booking_code] = {
                'booking_info': booking_info,
                'email_content': {
                    'subject': f'Bokning avbokad - {booking_code}',
                    'body': mock_content,
                    'sender': 'automated@airbnb.com'
                },
                'gmail_id': f'mock_{booking_code}'
            }
        
        print(f"🎭 Created {len(mock_emails)} mock cancellation emails")
        print(f"   - {sum(1 for data in mock_emails.values() if data['booking_info']['hostEarningsEur'] == 0)} zero-payout cancellations")
        print(f"   - {sum(1 for data in mock_emails.values() if data['booking_info']['hostEarningsEur'] > 0)} with-payout cancellations")
        return mock_emails
    
    def train_from_cancellation_emails(self, cancellation_emails):
        """Train ML model from real/mock cancellation emails"""
        
        print("🧠 Training ML model from cancellation emails...")
        
        training_count = 0
        
        for booking_code, email_data in cancellation_emails.items():
            booking_info = email_data['booking_info']
            email_content = email_data['email_content']
            
            # Create training example
            training_labels = {
                'hostEarningsEur': float(booking_info['hostEarningsEur']),  # Should be 0 for cancelled
                'hostEarningsSek': 0.0,  # No SEK payout for cancelled
                'guestName': booking_info['guestName'],
                'bookingCode': booking_code
            }
            
            # Add to ML extractor
            self.ml_extractor.add_training_example(
                email_content['body'],
                'cancellation',  # Email type
                training_labels
            )
            
            training_count += 1
            print(f"   ✅ Added training example for {booking_code} (€{booking_info['hostEarningsEur']:.2f})")
        
        print(f"🎯 Added {training_count} new cancellation training examples")
        return training_count
    
    def run_cancellation_training(self):
        """Complete cancellation training pipeline"""
        
        print("🚀 GMAIL CANCELLATION TRAINING PIPELINE")
        print("=" * 50)
        
        # Step 1: Load cancelled bookings from CSV
        cancelled_bookings = self.load_cancelled_bookings_from_csv()
        
        if not cancelled_bookings:
            print("❌ No cancelled bookings found in CSV files")
            return
        
        # Step 2: Search Gmail for cancellation emails (or create mock)
        cancellation_emails = self.search_gmail_for_cancellations(cancelled_bookings)
        
        if not cancellation_emails:
            print("❌ No cancellation emails found")
            return
        
        # Step 3: Train ML model from cancellation emails
        training_count = self.train_from_cancellation_emails(cancellation_emails)
        
        # Step 4: Retrain and save model
        print("\n🤖 Retraining ML model with cancellation examples...")
        self.ml_extractor.train_classifiers()
        
        model_path = os.path.join(current_dir, 'ml_extractor_model.pkl')
        self.ml_extractor.save_model(model_path)
        
        print(f"\n🎉 Cancellation training complete!")
        print(f"📧 Processed {len(cancellation_emails)} cancellation emails")
        print(f"🧠 Added {training_count} training examples")
        print(f"💾 Model updated: {model_path}")
        
        return training_count

def main():
    """Main function for cancellation training"""
    trainer = GmailCancellationTrainer()
    trainer.run_cancellation_training()

if __name__ == '__main__':
    main()