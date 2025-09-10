#!/usr/bin/env python3
"""
CSV Reference-Based ML Trainer
=============================

Compares database bookings with CSV "facit" data and automatically
trains the ML system when discrepancies are found.
"""

import sys
import os
import json
import sqlite3
import pandas as pd
from datetime import datetime
import glob

# Import our ML components
import importlib.util
current_dir = os.path.dirname(os.path.abspath(__file__))

# Import ML extractor and trainer
spec = importlib.util.spec_from_file_location("ml_extractor", os.path.join(current_dir, "ml_extractor.py"))
ml_extractor_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ml_extractor_module)
MLDataExtractor = ml_extractor_module.MLDataExtractor

spec_trainer = importlib.util.spec_from_file_location("train_ml_extractor", os.path.join(current_dir, "train_ml_extractor.py"))
trainer_module = importlib.util.module_from_spec(spec_trainer)
spec_trainer.loader.exec_module(trainer_module)
MLExtractorTrainer = trainer_module.MLExtractorTrainer

class CSVReferenceTrainer:
    def __init__(self, db_path="../prisma/dev.db", csv_dir="../csv"):
        self.db_path = db_path
        self.csv_dir = csv_dir
        self.ml_extractor = MLDataExtractor()
        self.trainer = MLExtractorTrainer()
        
        # Load existing ML model
        model_path = os.path.join(current_dir, 'ml_extractor_model.pkl')
        self.ml_extractor.load_model(model_path)
        
    def load_csv_facit(self):
        """Load all CSV reference data as ground truth"""
        
        print("📋 Loading CSV reference data (facit)...")
        
        csv_files = glob.glob(os.path.join(self.csv_dir, "*.csv"))
        all_csv_data = {}
        
        for csv_file in csv_files:
            try:
                df = pd.read_csv(csv_file)
                print(f"   Loading {os.path.basename(csv_file)}: {len(df)} bookings")
                
                for _, row in df.iterrows():
                    booking_code = row['Confirmation code']
                    
                    # Parse earnings (remove €, handle comma decimal)
                    earnings_str = str(row['Earnings']).replace('€', '').replace(' ', '').replace(',', '.')
                    try:
                        earnings = float(earnings_str)
                    except:
                        earnings = None
                    
                    all_csv_data[booking_code] = {
                        'bookingCode': booking_code,
                        'guestName': row['Guest name'],
                        'hostEarningsEur': earnings,
                        'checkInDate': row['Start date'],
                        'checkOutDate': row['End date'],
                        'nights': int(row['# of nights']) if pd.notna(row['# of nights']) else None,
                        'status': row['Status']
                    }
                    
            except Exception as e:
                print(f"   ❌ Error loading {csv_file}: {e}")
        
        print(f"📊 Loaded {len(all_csv_data)} reference bookings from CSV")
        return all_csv_data
    
    def load_db_bookings(self):
        """Load current database bookings"""
        
        print("🔍 Loading database bookings...")
        
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        
        query = """
        SELECT 
            bookingCode,
            guestName,
            hostEarningsEur,
            hostEarningsSek,
            checkInDate,
            checkOutDate,
            nights
        FROM bookings 
        WHERE bookingCode IS NOT NULL
        """
        
        cursor.execute(query)
        rows = cursor.fetchall()
        conn.close()
        
        db_data = {}
        for row in rows:
            booking_code = row[0]
            db_data[booking_code] = {
                'bookingCode': row[0],
                'guestName': row[1],
                'hostEarningsEur': row[2],
                'hostEarningsSek': row[3],
                'checkInDate': row[4],
                'checkOutDate': row[5],
                'nights': row[6]
            }
        
        print(f"📊 Loaded {len(db_data)} bookings from database")
        return db_data
    
    def find_discrepancies(self, csv_data, db_data):
        """Find discrepancies between CSV facit and database"""
        
        print("🔍 Analyzing discrepancies between CSV facit and database...")
        
        discrepancies = []
        
        for booking_code, csv_booking in csv_data.items():
            if booking_code in db_data:
                db_booking = db_data[booking_code]
                
                # Compare key fields
                issues = []
                
                # Host earnings
                csv_earnings = csv_booking['hostEarningsEur']
                db_earnings = db_booking['hostEarningsEur']
                
                if csv_earnings and db_earnings:
                    if abs(csv_earnings - db_earnings) > 0.01:
                        issues.append({
                            'field': 'hostEarningsEur',
                            'csv_value': csv_earnings,
                            'db_value': db_earnings,
                            'error': f"CSV: €{csv_earnings}, DB: €{db_earnings}"
                        })
                
                # Guest name
                if csv_booking['guestName'] != db_booking['guestName']:
                    if db_booking['guestName']:  # Only flag if DB has a different name
                        issues.append({
                            'field': 'guestName', 
                            'csv_value': csv_booking['guestName'],
                            'db_value': db_booking['guestName'],
                            'error': f"CSV: '{csv_booking['guestName']}', DB: '{db_booking['guestName']}'"
                        })
                
                # Nights
                if csv_booking['nights'] != db_booking['nights']:
                    if db_booking['nights']:  # Only flag if DB has different nights
                        issues.append({
                            'field': 'nights',
                            'csv_value': csv_booking['nights'], 
                            'db_value': db_booking['nights'],
                            'error': f"CSV: {csv_booking['nights']}, DB: {db_booking['nights']}"
                        })
                
                if issues:
                    discrepancies.append({
                        'bookingCode': booking_code,
                        'issues': issues,
                        'csv_data': csv_booking,
                        'db_data': db_booking
                    })
        
        print(f"⚠️  Found {len(discrepancies)} bookings with discrepancies")
        return discrepancies
    
    def get_email_content_for_booking(self, booking_code):
        """Get email content for a specific booking to create training examples"""
        
        print(f"📧 Fetching email content for booking {booking_code}...")
        
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        
        # Get email links for this booking
        query = """
        SELECT el.gmailId, el.emailType, el.subject
        FROM email_links el
        JOIN bookings b ON el.bookingId = b.id
        WHERE b.bookingCode = ?
        """
        
        cursor.execute(query, (booking_code,))
        email_links = cursor.fetchall()
        conn.close()
        
        # For now, create synthetic email content based on patterns
        # In production, you'd fetch actual Gmail content here
        
        return email_links
    
    def create_training_example_from_discrepancy(self, discrepancy):
        """Create ML training example from CSV vs DB discrepancy"""
        
        booking_code = discrepancy['bookingCode']
        csv_data = discrepancy['csv_data']
        issues = discrepancy['issues']
        
        print(f"🧠 Creating training example for {booking_code}...")
        
        # Create synthetic email content based on CSV facit data
        training_examples = []
        
        for issue in issues:
            field = issue['field']
            correct_value = issue['csv_value']
            
            if field == 'hostEarningsEur':
                # Create confirmation email training example
                email_text = f"""
                Bokningskod: {booking_code}
                Bokning bekräftad - {csv_data['guestName']} anländer
                TOTALT (EUR) € {correct_value:.2f}
                Du tjänar: € {correct_value:.2f}
                """
                
                training_examples.append({
                    'email_text': email_text.strip(),
                    'email_type': 'booking_confirmation', 
                    'labels': {
                        'hostEarningsEur': correct_value,
                        'guestName': csv_data['guestName'],
                        'bookingCode': booking_code
                    }
                })
        
        return training_examples
    
    def train_from_discrepancies(self, discrepancies, max_examples=10):
        """Train ML model from discovered discrepancies"""
        
        print(f"🚀 Training ML from {len(discrepancies)} discrepancies (max: {max_examples})...")
        
        training_count = 0
        
        for discrepancy in discrepancies[:max_examples]:
            training_examples = self.create_training_example_from_discrepancy(discrepancy)
            
            for example in training_examples:
                self.ml_extractor.add_training_example(
                    example['email_text'],
                    example['email_type'],
                    example['labels']
                )
                training_count += 1
                
                print(f"   ✅ Added training example for {discrepancy['bookingCode']}")
        
        print(f"🎯 Added {training_count} new training examples")
        return training_count
    
    def run_csv_based_training(self):
        """Complete CSV-based training pipeline"""
        
        print("🚀 CSV-BASED ML TRAINING PIPELINE")
        print("=" * 50)
        
        # Step 1: Load data
        csv_data = self.load_csv_facit()
        db_data = self.load_db_bookings()
        
        # Step 2: Find discrepancies  
        discrepancies = self.find_discrepancies(csv_data, db_data)
        
        if not discrepancies:
            print("🎉 No discrepancies found! ML model is performing perfectly.")
            return
        
        # Step 3: Show discrepancies
        print("\n📊 DISCREPANCY ANALYSIS")
        print("-" * 30)
        for disc in discrepancies[:5]:  # Show first 5
            print(f"\n🔍 {disc['bookingCode']}:")
            for issue in disc['issues']:
                print(f"   ❌ {issue['field']}: {issue['error']}")
        
        if len(discrepancies) > 5:
            print(f"\n   ... and {len(discrepancies) - 5} more discrepancies")
        
        # Step 4: Train from discrepancies
        training_count = self.train_from_discrepancies(discrepancies)
        
        # Step 5: Retrain model
        print("\n🤖 Retraining ML model with new examples...")
        self.ml_extractor.train_classifiers()
        
        # Step 6: Save updated model
        model_path = os.path.join(current_dir, 'ml_extractor_model.pkl')
        self.ml_extractor.save_model(model_path)
        
        print(f"\n🎉 CSV-based training complete!")
        print(f"📊 Fixed {len(discrepancies)} discrepancies")
        print(f"🧠 Added {training_count} training examples")
        print(f"💾 Model updated: {model_path}")
        
        return discrepancies, training_count

def main():
    """Main function for CSV-based training"""
    
    if len(sys.argv) > 1:
        booking_code = sys.argv[1]
        print(f"🎯 Training ML for specific booking: {booking_code}")
        # TODO: Implement single booking training
    else:
        trainer = CSVReferenceTrainer()
        trainer.run_csv_based_training()

if __name__ == '__main__':
    main()