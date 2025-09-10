#!/usr/bin/env python3
"""
CSV Date Corrector
==================

Post-processes ML results and corrects obvious date errors using CSV reference data.
Fixes year-long bookings (365+ nights) with correct CSV dates.
"""

import os
import json
import glob
import pandas as pd
import sys

def load_csv_reference_data():
    """Load correct dates from CSV files"""
    
    current_dir = os.path.dirname(os.path.abspath(__file__))
    csv_dir = os.path.join(current_dir, "..", "csv")
    
    csv_files = glob.glob(os.path.join(csv_dir, "*.csv"))
    csv_data = {}
    
    for csv_file in csv_files:
        try:
            df = pd.read_csv(csv_file)
            for _, row in df.iterrows():
                booking_code = row['Confirmation code']
                csv_data[booking_code] = {
                    'checkInDate': row['Start date'],
                    'checkOutDate': row['End date'], 
                    'nights': int(row['# of nights']) if pd.notna(row['# of nights']) else None,
                    'guestName': row['Guest name']
                }
        except Exception as e:
            print(f"[CSV] Error loading {csv_file}: {e}", file=sys.stderr)
    
    return csv_data

def correct_ml_result(ml_result):
    """Correct ML result using CSV reference if dates are wrong"""
    
    booking_code = ml_result.get('bookingCode')
    nights = ml_result.get('nights', 0)
    
    # Check if this looks like a suspicious year-long booking
    if nights >= 300:  # 300+ nights is definitely wrong
        print(f"[CSV_CORRECTOR] Suspicious {nights} nights for {booking_code}, checking CSV...", file=sys.stderr)
        
        # Load CSV reference data
        csv_data = load_csv_reference_data()
        
        if booking_code in csv_data:
            csv_correct = csv_data[booking_code]
            
            print(f"[CSV_CORRECTOR] Found CSV correction for {booking_code}:", file=sys.stderr)
            print(f"  CSV: {csv_correct['checkInDate']} → {csv_correct['checkOutDate']} ({csv_correct['nights']} nights)", file=sys.stderr)
            print(f"  ML:  {ml_result.get('checkInDate')} → {ml_result.get('checkOutDate')} ({nights} nights)", file=sys.stderr)
            
            # Apply CSV corrections
            ml_result['checkInDate'] = csv_correct['checkInDate']
            ml_result['checkOutDate'] = csv_correct['checkOutDate'] 
            ml_result['nights'] = csv_correct['nights']
            
            # Also correct guest name if CSV has full name
            csv_guest_name = csv_correct['guestName']
            ml_guest_name = ml_result.get('guestName', '')
            if csv_guest_name and len(csv_guest_name) > len(ml_guest_name):
                ml_result['guestName'] = csv_guest_name
                print(f"[CSV_CORRECTOR] Also corrected guest name: {ml_guest_name} → {csv_guest_name}", file=sys.stderr)
            
            print(f"[CSV_CORRECTOR] ✅ Corrected {booking_code} using CSV reference", file=sys.stderr)
        else:
            print(f"[CSV_CORRECTOR] ❌ No CSV reference found for {booking_code}", file=sys.stderr)
    
    return ml_result

def main():
    """Main function - reads ML result from stdin and outputs corrected result"""
    
    try:
        # Read ML result from stdin
        input_data = json.loads(sys.stdin.read())
        
        # Correct using CSV if needed
        corrected_result = correct_ml_result(input_data)
        
        # Output corrected result
        print(json.dumps(corrected_result))
        
    except Exception as e:
        # Pass through original data if correction fails
        print(json.dumps(input_data))
        print(f"[CSV_CORRECTOR] Error: {e}", file=sys.stderr)

if __name__ == '__main__':
    main()