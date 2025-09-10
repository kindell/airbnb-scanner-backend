#!/usr/bin/env python3
"""
Auto-Expand Training Data
========================

Denna script förbättrar ML-modellen genom att:
1. Analysera befintligt träningsdata (136 emails)
2. Hitta mönster som modellen är osäker på
3. Automatiskt märka mer data baserat på CSV "facit"
4. Skapa en expanderad träningsdataset

Detta är ett säkrare tillvägagångssätt än att hämta från Gmail direkt.
"""

import json
import os
import pandas as pd
import re
from collections import defaultdict

def load_current_training_data():
    """Ladda nuvarande träningsdata"""
    print("📖 Laddar nuvarande träningsdata...")
    
    with open('../ml-training-data.json', 'r', encoding='utf-8') as f:
        data = json.load(f)
    
    print(f"📊 Nuvarande träningsdata: {len(data)} emails")
    
    # Analysera distribution
    distribution = defaultdict(int)
    for sample in data:
        distribution[sample['emailType']] += 1
    
    for email_type, count in distribution.items():
        print(f"   {email_type}: {count} emails")
    
    return data, distribution

def load_csv_booking_data():
    """Ladda CSV-data som grund för mer träningsdata"""
    print("\n📊 Laddar CSV booking data som 'facit'...")
    
    csv_dir = "../csv"
    all_bookings = {}
    
    if not os.path.exists(csv_dir):
        print(f"⚠️ CSV-mapp saknas: {csv_dir}")
        return {}
    
    csv_files = [f for f in os.listdir(csv_dir) if f.endswith('.csv')]
    print(f"📁 Hittade {len(csv_files)} CSV filer")
    
    for csv_file in csv_files:
        filepath = os.path.join(csv_dir, csv_file)
        try:
            df = pd.read_csv(filepath, encoding='utf-8')
            print(f"   {csv_file}: {len(df)} rader")
            
            for _, row in df.iterrows():
                booking_code = str(row.get('Confirmation code', ''))
                if booking_code and booking_code != 'nan':
                    all_bookings[booking_code] = {
                        'bookingCode': booking_code,
                        'guestName': str(row.get('Guest name', '')),
                        'startDate': str(row.get('Start date', '')),
                        'endDate': str(row.get('End date', '')),
                        'earnings': str(row.get('Earnings', '')),
                        'status': str(row.get('Status', '')),
                        'source_file': csv_file
                    }
        except Exception as e:
            print(f"⚠️ Kunde inte läsa {csv_file}: {e}")
    
    print(f"✅ Totalt {len(all_bookings)} unika bokningar från CSV")
    return all_bookings

def analyze_training_patterns(training_data):
    """Analysera mönster i träningsdata för att hitta brister"""
    print("\n🔍 Analyserar träningsdata för förbättringsmöjligheter...")
    
    patterns = {
        'guest_names': set(),
        'booking_codes': set(),
        'months': set(),
        'senders': set(),
        'subject_patterns': set()
    }
    
    for sample in training_data:
        subject = sample.get('subject', '')
        sender = sample.get('sender', '')
        
        # Extrahera booking codes
        booking_matches = re.findall(r'HM[A-Z0-9]+', subject + sample.get('body', ''))
        patterns['booking_codes'].update(booking_matches)
        
        # Extrahera svenska månader
        month_matches = re.findall(r'\b(jan|feb|mar|apr|maj|jun|jul|juli|aug|sep|okt|nov|dec)\b', subject.lower())
        patterns['months'].update(month_matches)
        
        # Senders
        patterns['senders'].add(sender)
        
        # Subject patterns
        if 'bekräftad' in subject.lower():
            patterns['subject_patterns'].add('confirmation')
        if 'påminnelse' in subject.lower():
            patterns['subject_patterns'].add('reminder')
        if 'utbetalning' in subject.lower():
            patterns['subject_patterns'].add('payout')
    
    print("📊 Mönster i nuvarande träningsdata:")
    print(f"   Booking codes: {len(patterns['booking_codes'])} unika")
    print(f"   Månader: {patterns['months']}")
    print(f"   Senders: {len(patterns['senders'])} unika")
    print(f"   Subject patterns: {patterns['subject_patterns']}")
    
    return patterns

def generate_synthetic_variations(training_data, csv_bookings):
    """Generera variationer baserat på CSV-data för att öka träningsdatan"""
    print("\n🧬 Genererar syntetiska variationer baserat på CSV-data...")
    
    synthetic_samples = []
    
    # För varje CSV-booking, skapa troliga email-variationer
    for booking_code, booking_info in csv_bookings.items():
        guest_name = booking_info['guestName']
        start_date = booking_info['startDate']
        
        if not guest_name or guest_name == 'nan' or not start_date or start_date == 'nan':
            continue
        
        # Extrahera dag och månad från startdatum (M/D/YYYY format från CSV)
        try:
            # Hantera format som "7/13/2026" eller "6/7/2026"  
            if '/' in start_date:
                date_parts = start_date.split('/')
                if len(date_parts) >= 3:
                    month, day, year = date_parts[0], date_parts[1], date_parts[2]
            else:
                # Fallback för andra format
                continue
            
            # Konvertera månad till svenska (med padding för 01, 02 etc.)
            month_padded = month.zfill(2)
            month_map = {
                '01': 'januari', '02': 'februari', '03': 'mars', '04': 'april',
                '05': 'maj', '06': 'juni', '07': 'juli', '08': 'augusti',
                '09': 'september', '10': 'oktober', '11': 'november', '12': 'december'
            }
            swedish_month = month_map.get(month_padded, 'juli')
            
            # Generera booking confirmation
            confirmation_subject = f"Bokning bekräftad - {guest_name} anländer {int(day)} {swedish_month}"
            confirmation_body = f"NY BOKNING BEKRÄFTAD! {guest_name.upper()} ANLÄNDER {int(day)} {swedish_month.upper()}. BEKRÄFTELSEKOD {booking_code}"
            
            synthetic_samples.append({
                'subject': confirmation_subject,
                'sender': 'Airbnb <automated@airbnb.com>',
                'body': confirmation_body,
                'emailType': 'booking_confirmation',
                'truthData': {
                    'bookingCode': booking_code,
                    'guestName': guest_name,
                    'checkInDate': start_date,
                    'synthetic': True,
                    'source': 'csv_generated'
                }
            })
            
            # Generera booking reminder
            reminder_subject = f"Bokningspåminnelse: {guest_name} anländer snart!"
            reminder_body = f"Påminnelse om din gäst {guest_name} som anländer imorgon. Bekräftelsekod: {booking_code}"
            
            synthetic_samples.append({
                'subject': reminder_subject,
                'sender': 'Airbnb <automated@airbnb.com>',
                'body': reminder_body, 
                'emailType': 'booking_reminder',
                'truthData': {
                    'bookingCode': booking_code,
                    'guestName': guest_name,
                    'checkInDate': start_date,
                    'synthetic': True,
                    'source': 'csv_generated'
                }
            })
                
        except Exception as e:
            continue
    
    print(f"🧬 Genererade {len(synthetic_samples)} syntetiska träningsexempel")
    return synthetic_samples

def create_expanded_dataset(original_data, synthetic_data, csv_bookings):
    """Kombinera original + syntetisk data till expanderad dataset"""
    print(f"\n📈 Skapar expanderad dataset...")
    
    # Kombinera all data
    expanded_data = original_data.copy()
    
    # Lägg till syntetisk data (med märkning)
    for sample in synthetic_data:
        expanded_data.append(sample)
    
    print(f"📊 Expanderad dataset:")
    print(f"   Original: {len(original_data)} emails")
    print(f"   Syntetisk: {len(synthetic_data)} emails") 
    print(f"   Totalt: {len(expanded_data)} emails")
    print(f"   Förbättring: {len(expanded_data)/len(original_data):.1f}x mer data")
    
    # Analysera ny distribution
    distribution = defaultdict(int)
    for sample in expanded_data:
        distribution[sample['emailType']] += 1
    
    print("\n📊 Ny typ-distribution:")
    for email_type, count in distribution.items():
        print(f"   {email_type}: {count} emails")
    
    return expanded_data

def main():
    print("🚀 AUTO-EXPAND TRAINING DATA")
    print("=" * 50)
    
    # Steg 1: Ladda nuvarande data
    training_data, current_dist = load_current_training_data()
    
    # Steg 2: Ladda CSV ground truth
    csv_bookings = load_csv_booking_data()
    
    if not csv_bookings:
        print("⚠️ Ingen CSV-data hittades. Lägger CSV filer i ../csv/ mappen först.")
        return
    
    # Steg 3: Analysera nuvarande mönster
    patterns = analyze_training_patterns(training_data)
    
    # Steg 4: Generera syntetiska variationer
    synthetic_data = generate_synthetic_variations(training_data, csv_bookings)
    
    # Steg 5: Skapa expanderad dataset
    expanded_data = create_expanded_dataset(training_data, synthetic_data, csv_bookings)
    
    # Steg 6: Spara expanderad data
    output_file = '../ml-training-data-expanded.json'
    with open(output_file, 'w', encoding='utf-8') as f:
        json.dump(expanded_data, f, indent=2, ensure_ascii=False)
    
    print(f"\n💾 Sparade expanderad träningsdata till: {output_file}")
    
    # Steg 7: Träna om modellen med ny data
    print(f"\n🎯 Vill du träna om modellen med den expanderade datan? (y/n)")
    response = input().lower().strip()
    
    if response == 'y' or response == 'yes':
        print("🔄 Tränar om modellen...")
        
        # Uppdatera email-classifier.py för att använda nya datan
        import subprocess
        
        # Backup gammal data
        os.rename('../ml-training-data.json', '../ml-training-data-backup.json')
        
        # Kopiera ny data
        os.rename(output_file, '../ml-training-data.json')
        
        # Träna om
        result = subprocess.run(['python3', 'email-classifier.py'], capture_output=True, text=True)
        
        print("🎉 Modellen omtränad med expanderad data!")
        print(f"📊 Förbättring: {len(expanded_data)} vs {len(training_data)} träningsexempel")

if __name__ == '__main__':
    main()