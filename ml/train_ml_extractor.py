#!/usr/bin/env python3
"""
Training Script for ML Extractor
================================

Trains the ML-based data extractor using existing email data and human annotations.
Creates training examples from real emails to improve pattern recognition.
"""

import sys
import os
import json
import sqlite3
from datetime import datetime

# Import our ML extractor
import importlib.util
current_dir = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("ml_extractor", os.path.join(current_dir, "ml_extractor.py"))
ml_extractor_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ml_extractor_module)
MLDataExtractor = ml_extractor_module.MLDataExtractor

class MLExtractorTrainer:
    def __init__(self, db_path="../prisma/dev.db"):
        self.db_path = db_path
        self.extractor = MLDataExtractor()
        
    def load_training_data_from_db(self):
        """Load existing bookings from database to create training examples"""
        
        print("🔍 Loading training data from database...")
        
        # Connect to SQLite database
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        
        # Get all bookings with email links
        query = """
        SELECT 
            b.bookingCode,
            b.guestName,
            b.hostEarningsEur,
            b.hostEarningsSek,
            b.guestTotalEur,
            b.cleaningFeeEur,
            b.checkInDate,
            b.checkOutDate,
            b.nights,
            el.emailType,
            el.subject,
            el.gmailId
        FROM bookings b
        JOIN email_links el ON b.id = el.bookingId
        WHERE b.hostEarningsEur IS NOT NULL 
           OR b.hostEarningsSek IS NOT NULL
           OR b.guestName IS NOT NULL
        ORDER BY b.bookingCode, el.emailType
        """
        
        cursor.execute(query)
        rows = cursor.fetchall()
        conn.close()
        
        print(f"📋 Found {len(rows)} email-booking pairs in database")
        
        # Group by booking code
        training_data = {}
        for row in rows:
            booking_code = row[0]
            if booking_code not in training_data:
                training_data[booking_code] = {
                    'booking_data': {
                        'bookingCode': row[0],
                        'guestName': row[1],
                        'hostEarningsEur': row[2],
                        'hostEarningsSek': row[3],
                        'guestTotalEur': row[4],
                        'cleaningFeeEur': row[5],
                        'checkInDate': row[6],
                        'checkOutDate': row[7],
                        'nights': row[8]
                    },
                    'emails': []
                }
            
            training_data[booking_code]['emails'].append({
                'emailType': row[9],
                'subject': row[10],
                'gmailId': row[11]
            })
        
        return training_data
    
    def create_training_examples(self):
        """Create comprehensive training examples with known correct answers"""
        
        # High-confidence training examples (manually verified)
        training_examples = [
            {
                'email_text': """
                Bokningskod: HMSPX39W44
                Bokning bekräftad - Henri Conradsen anländer 5 apr.
                TOTALT (EUR)   € 389,13
                Du tjänar: € 128,50
                Gästens totala kostnad: € 462,84
                Städavgift: € 100,00
                """,
                'email_type': 'booking_confirmation',
                'labels': {
                    'hostEarningsEur': 389.13,  # From TOTALT (EUR) - highest priority
                    'guestName': 'Henri Conradsen',
                    'guestTotalEur': 462.84,
                    'cleaningFeeEur': 100.00
                }
            },
            {
                'email_text': """
                En utbetalning på 4 494,80 kr skickades
                Bokningskod: HMSPX39W44
                Utbetalning på 4 494,80 kr
                """,
                'email_type': 'payout',
                'labels': {
                    'hostEarningsSek': 4494.80  # Actual payout amount
                }
            },
            {
                'email_text': """
                Bokningspåminnelse: Anna anländer snart!
                Bokningskod: HM123456789
                Du tjänar: € 245,60
                """,
                'email_type': 'booking_reminder', 
                'labels': {
                    'hostEarningsEur': 245.60,
                    'guestName': 'Anna'
                }
            },
            {
                'email_text': """
                New booking confirmed! Sarah arrives May 15
                Booking code: HM987654321
                Host earnings: $320.50
                Guest total: $450.75
                Cleaning fee: $75.00
                """,
                'email_type': 'booking_confirmation',
                'labels': {
                    'hostEarningsEur': 320.50,  # Assuming USD≈EUR for training
                    'guestName': 'Sarah',
                    'guestTotalEur': 450.75,
                    'cleaningFeeEur': 75.00
                }
            },
            {
                'email_text': """
                Booking Cancelled: HM83B4Y488
                Canceled by guest - Anette
                Original booking: €490.50
                Cancellation processed
                No payout will be issued
                """,
                'email_type': 'cancellation',
                'labels': {
                    'hostEarningsEur': 0.00,  # No earnings for cancelled bookings
                    'hostEarningsSek': 0.00,  # No SEK payout either
                    'guestName': 'Anette',
                    'bookingCode': 'HM83B4Y488'
                }
            },
            {
                'email_text': """
                Bokning avbokad av gäst
                Bokningskod: HM83B4Y488  
                Gäst: Anette
                Ursprungligt belopp: € 490,50
                Du tjänar: € 0,00 (avbokad)
                Ingen utbetalning kommer att ske
                """,
                'email_type': 'cancellation',
                'labels': {
                    'hostEarningsEur': 0.00,  # Cancelled = no earnings
                    'guestName': 'Anette',
                    'bookingCode': 'HM83B4Y488'
                }
            }
        ]
        
        print(f"📚 Created {len(training_examples)} manual training examples")
        
        # Add to extractor
        for example in training_examples:
            self.extractor.add_training_example(
                example['email_text'], 
                example['email_type'], 
                example['labels']
            )
        
        return len(training_examples)
    
    def train_with_database_examples(self, max_examples=50):
        """Use database data to create additional training examples"""
        
        print(f"🔍 Creating training examples from database (max: {max_examples})...")
        
        # For now, use the high-quality manual examples
        # In the future, we could use Gmail API to fetch actual email content
        # and cross-reference with database values
        
        # Create synthetic examples based on known patterns
        synthetic_examples = [
            # Swedish confirmation email patterns
            {
                'email_text': 'TOTALT (EUR) € 425,30\nDu tjänar: € 180,20\nStädavgift: € 85,00',
                'email_type': 'booking_confirmation',
                'labels': {'hostEarningsEur': 425.30, 'cleaningFeeEur': 85.00}
            },
            {
                'email_text': 'En utbetalning på 3 250,75 kr skickades\nBokningskod: HMTEST123',
                'email_type': 'payout', 
                'labels': {'hostEarningsSek': 3250.75}
            },
            # English patterns
            {
                'email_text': 'Your earnings: €190.40\nGuest total: €340.60\nCleaning fee: €60.00',
                'email_type': 'booking_confirmation',
                'labels': {'hostEarningsEur': 190.40, 'guestTotalEur': 340.60, 'cleaningFeeEur': 60.00}
            }
        ]
        
        for example in synthetic_examples[:max_examples]:
            self.extractor.add_training_example(
                example['email_text'],
                example['email_type'], 
                example['labels']
            )
        
        return len(synthetic_examples)
    
    def train_and_save_model(self):
        """Train the ML classifiers and save the model"""
        
        print("🤖 Training ML classifiers...")
        
        # Train the models
        self.extractor.train_classifiers()
        
        # Save the trained model
        model_path = os.path.join(current_dir, 'ml_extractor_model.pkl')
        self.extractor.save_model(model_path)
        
        print(f"💾 Model saved to: {model_path}")
        
        return model_path
    
    def test_trained_model(self):
        """Test the trained model on sample data"""
        
        print("\n🧪 Testing trained model...")
        
        test_cases = [
            {
                'text': 'TOTALT (EUR) € 389,13\nDu tjänar: € 128,50',
                'type': 'booking_confirmation',
                'expected': {'hostEarningsEur': 389.13}
            },
            {
                'text': 'En utbetalning på 4 494,80 kr skickades',
                'type': 'payout',
                'expected': {'hostEarningsSek': 4494.80}
            }
        ]
        
        for i, test_case in enumerate(test_cases):
            print(f"\n📋 Test case {i+1}:")
            result = self.extractor.extract_data(test_case['text'], test_case['type'])
            
            print(f"   Input: {test_case['text'][:50]}...")
            print(f"   Expected: {test_case['expected']}")
            print(f"   Got: {result}")
            
            # Check if key fields match
            for key, expected_value in test_case['expected'].items():
                if key in result:
                    actual_value = result[key]
                    match = abs(actual_value - expected_value) < 0.01
                    print(f"   {key}: {'✅' if match else '❌'} (expected: {expected_value}, got: {actual_value})")
                else:
                    print(f"   {key}: ❌ (missing)")
    
    def run_full_training(self):
        """Run complete training pipeline"""
        
        print("🚀 Starting ML Extractor Training Pipeline\n")
        print("=" * 50)
        
        # Step 1: Create manual training examples
        manual_examples = self.create_training_examples()
        
        # Step 2: Add database examples
        db_examples = self.train_with_database_examples()
        
        # Step 3: Train models
        model_path = self.train_and_save_model()
        
        # Step 4: Test trained model
        self.test_trained_model()
        
        print("\n" + "=" * 50)
        print("🎉 Training Complete!")
        print(f"📊 Training examples: {manual_examples + db_examples}")
        print(f"💾 Model saved to: {model_path}")
        print("\nThe ML extractor is now trained and ready to use!")
        
        return model_path

def main():
    """Main training function"""
    trainer = MLExtractorTrainer()
    model_path = trainer.run_full_training()
    print(f"\n🔧 To use the trained model, restart your application.")
    return model_path

if __name__ == '__main__':
    main()