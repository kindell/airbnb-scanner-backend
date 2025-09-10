#!/usr/bin/env python3
"""
Automated Training Data Collection
=================================

This script automatically collects training data by:
1. Fetching ALL Airbnb emails from Gmail (not just 136)
2. Using CSV booking data as ground truth for labels
3. Creating a much larger, automatically labeled dataset
4. Improving model accuracy through more diverse examples

Usage:
    python3 collect_training_data.py --user-id 1 --year 2024
"""

import sys
import json
import os
import pandas as pd
from datetime import datetime
import re

def load_csv_ground_truth(csv_dir="../csv"):
    """Load all CSV files as ground truth data"""
    print("📊 Loading CSV ground truth data...")
    
    bookings = {}
    
    # Load all CSV files
    csv_files = [f for f in os.listdir(csv_dir) if f.endswith('.csv')]
    print(f"📁 Found {len(csv_files)} CSV files")
    
    for csv_file in csv_files:
        print(f"   Processing: {csv_file}")
        df = pd.read_csv(os.path.join(csv_dir, csv_file))
        
        for _, row in df.iterrows():
            booking_code = row.get('Bekräftelsekod')  # Confirmation code
            guest_name = row.get('Gäst')  # Guest name
            start_date = row.get('Startdatum')  # Check-in date
            end_date = row.get('Slutdatum')  # Check-out date  
            total_payout = row.get('Utbetalning totalt (SEK)')  # Total payout
            
            if booking_code and booking_code not in bookings:
                bookings[booking_code] = {
                    'bookingCode': booking_code,
                    'guestName': guest_name,
                    'checkInDate': start_date,
                    'checkOutDate': end_date,
                    'payoutSEK': total_payout
                }
    
    print(f"✅ Loaded {len(bookings)} bookings from CSV as ground truth")
    return bookings

def fetch_gmail_emails_api(user_id, year=2024):
    """Fetch ALL Airbnb emails using the existing API"""
    print(f"📧 Fetching Gmail emails for user {user_id}, year {year}...")
    
    # We can call the existing API endpoint to get emails
    # This is better than rebuilding Gmail access
    import requests
    
    try:
        # Use the existing /api/process-emails endpoint in read-only mode
        response = requests.get(f'http://localhost:3000/api/gmail-emails?year={year}', 
                              headers={'Authorization': f'Bearer user-{user_id}'})
        
        if response.status_code == 200:
            emails = response.json()
            print(f"✅ Fetched {len(emails)} emails from Gmail API")
            return emails
        else:
            print(f"❌ API call failed: {response.status_code}")
            return []
            
    except Exception as e:
        print(f"❌ Failed to fetch emails: {e}")
        return []

def extract_booking_code(subject, body):
    """Extract booking code from email content"""
    full_text = subject + ' ' + body
    match = re.search(r'HM[A-Z0-9]{8,}', full_text)
    return match.group(0) if match else None

def classify_email_type(subject, sender, body, booking_code, ground_truth):
    """Automatically classify email type based on content and ground truth"""
    
    # Check if we have ground truth for this booking
    truth_data = ground_truth.get(booking_code, {}) if booking_code else {}
    
    # Classify based on sender and subject patterns
    if 'automated@airbnb.com' in sender and 'bekräftad' in subject.lower():
        return 'booking_confirmation'
    elif 'automated@airbnb.com' in sender and 'påminnelse' in subject.lower():
        return 'booking_reminder'  
    elif 'express@airbnb.com' in sender and 'utbetalning' in subject.lower():
        return 'payout'
    elif 'avbokad' in subject.lower() or 'cancelled' in subject.lower():
        return 'cancellation'
    else:
        return 'unknown'

def create_training_sample(email, email_type, ground_truth_data):
    """Create a training sample with ground truth labels"""
    
    return {
        'subject': email.get('subject', ''),
        'sender': email.get('sender', ''),
        'body': email.get('body', ''),
        'emailType': email_type,
        'truthData': {
            'bookingCode': ground_truth_data.get('bookingCode'),
            'guestName': ground_truth_data.get('guestName'),  
            'checkInDate': ground_truth_data.get('checkInDate'),
            'checkOutDate': ground_truth_data.get('checkOutDate'),
            'amountSEK': ground_truth_data.get('payoutSEK')
        }
    }

def main():
    if len(sys.argv) < 3:
        print("Usage: python3 collect_training_data.py --user-id 1 --year 2024")
        return
    
    user_id = sys.argv[2]  # --user-id 1 
    year = int(sys.argv[4]) if len(sys.argv) > 4 else 2024  # --year 2024
    
    print(f"🚀 AUTOMATED TRAINING DATA COLLECTION")
    print(f"User ID: {user_id}, Year: {year}")
    print("=" * 50)
    
    # Step 1: Load CSV ground truth
    ground_truth = load_csv_ground_truth()
    
    # Step 2: Fetch ALL Gmail emails (not just 136)
    emails = fetch_gmail_emails_api(user_id, year)
    
    if not emails:
        print("❌ No emails fetched. Check API access.")
        return
    
    # Step 3: Automatically label emails using ground truth
    print(f"🏷️ Auto-labeling {len(emails)} emails...")
    
    training_data = []
    stats = {'booking_confirmation': 0, 'booking_reminder': 0, 'payout': 0, 'cancellation': 0, 'unknown': 0}
    
    for email in emails:
        # Extract booking code
        booking_code = extract_booking_code(email.get('subject', ''), email.get('body', ''))
        
        # Classify email type
        email_type = classify_email_type(
            email.get('subject', ''), 
            email.get('sender', ''), 
            email.get('body', ''),
            booking_code,
            ground_truth
        )
        
        # Skip unknown types for training
        if email_type == 'unknown':
            stats['unknown'] += 1
            continue
        
        # Get ground truth data for this booking
        truth_data = ground_truth.get(booking_code, {}) if booking_code else {}
        
        # Create training sample
        sample = create_training_sample(email, email_type, truth_data)
        training_data.append(sample)
        
        stats[email_type] += 1
    
    # Step 4: Save expanded training data
    output_file = f'../ml-training-data-expanded-{year}.json'
    with open(output_file, 'w', encoding='utf-8') as f:
        json.dump(training_data, f, indent=2, ensure_ascii=False)
    
    print(f"\n📈 TRAINING DATA COLLECTION COMPLETE!")
    print("=" * 50)
    print(f"📊 Email Classification Stats:")
    for email_type, count in stats.items():
        print(f"   {email_type}: {count} emails")
    print(f"\n💾 Saved {len(training_data)} training samples to: {output_file}")
    print(f"📈 Improvement: {len(training_data)} vs 136 previous samples ({len(training_data)/136:.1f}x more data)")
    
    # Step 5: Quality check
    with_ground_truth = sum(1 for sample in training_data if sample['truthData']['bookingCode'])
    print(f"✅ Ground Truth Coverage: {with_ground_truth}/{len(training_data)} samples ({100*with_ground_truth/len(training_data):.1f}%)")

if __name__ == '__main__':
    main()