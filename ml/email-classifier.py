#!/usr/bin/env python3
"""
ML Email Classifier for Airbnb Emails
=====================================

A lightweight machine learning classifier that:
1. Classifies email type (booking_confirmation, booking_reminder, payout, cancellation)
2. Extracts specific data fields from each email type
3. Replaces expensive OpenRouter API calls with fast local processing

Uses scikit-learn for classification and regex for data extraction.
"""

import json
import re
import sys
import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.ensemble import RandomForestClassifier
from sklearn.model_selection import train_test_split
from sklearn.metrics import classification_report, confusion_matrix
from sklearn.pipeline import Pipeline
from datetime import datetime
import pickle
import os

class AirbnbEmailClassifier:
    def __init__(self):
        self.pipeline = None
        self.label_encoder = {
            'booking_confirmation': 0,
            'booking_reminder': 1, 
            'payout': 2,
            'cancellation': 3,
            'change_request': 4,
            'modification': 5
        }
        self.label_decoder = {v: k for k, v in self.label_encoder.items()}
        
        # Regex patterns for data extraction
        self.patterns = {
            'booking_code': r'HM[A-Z0-9]{8,}',
            # Enhanced Swedish amount pattern - handles both formats: "5 998,13 kr" and "5,998.13 kr"  
            'amount_sek': r'([\d]{1,3}(?:[\s\u00a0,]\d{3})*(?:[.,]\d{2})?)[\s\u00a0]*kr',
            'amount_eur': r'€\s*([\d\s,]+)',
            # More flexible guest name patterns
            'guest_name_confirmation': [
                r'Bokning bekräftad - (.+?) anländer',  # Original Swedish format
                r'bokning.*?bekräftad.*?([A-ZÅÄÖ][a-zåäöA-ZÅÄÖ\s]+?) anländer',  # Flexible word order
                r'([A-ZÅÄÖ][a-zåäöA-ZÅÄÖ\s]+?) anländer',  # Just name before "anländer"
                r'bekräftad.*?([A-ZÅÄÖ][a-zåäöA-ZÅÄÖ\s]{3,}?) anländer',  # Name after bekräftad
                # English patterns
                r'Reservation confirmed - (.+?) arrives',  # English format
                r'confirmed.*?([A-Z][a-zA-Z\s]+?) arrives',  # Flexible English
                r'([A-Z][a-zA-Z\s]+?) arrives',  # Just name before "arrives"
                # Additional flexible patterns
                r'bekräftelse.*?([A-ZÅÄÖ][a-zåäöA-ZÅÄÖ\s]{3,}?) anländer',  # "bekräftelse"
                r'(.+?) anländer.*?bekräftad',  # Name first, then "bekräftad"
                r'reservation.*?confirmed.*?([A-Z][a-zA-Z\s]{3,}?) arrives',  # "Your reservation"
            ],
            # Pattern to detect private bookings (no guest name in subject)
            'private_booking_patterns': [
                r'Bokning bekräftad för (.+)',  # "Bokning bekräftad för [Place]" - private booking
                r'Reservation confirmed for (.+)',  # English equivalent
                r'bekräftad för (.+)',  # Flexible "bekräftad för"
            ],
            'guest_name_reminder': [
                r'Bokningspåminnelse: (.+?) anländer', 
                r'påminnelse.*?([A-ZÅÄÖ][a-zåäöA-ZÅÄÖ\s]+?) anländer'
            ],
            'swedish_date': r'(\d{1,2})\s+(jan|feb|mar|apr|maj|jun|jul|aug|sep|okt|nov|dec)',
            'date_range': r'(\d{1,2})–(\d{1,2})\s+(jan|feb|mar|apr|maj|jun|jul|aug|sep|okt|nov|dec)',
            # Financial data patterns - more flexible for various formats
            'nights': r'(?:Antal nätter|nätter?):\s*(\d+)|(\d+)\s+nätter?',
            # Change request patterns
            'change_request_guest': r'^(.+?)\s+vill ändra',
            'original_dates_pattern': r'URSPRUNGLIGA DATUM\s*(\d{1,2}\s+\w+\.?\s+\d{4})\s*-\s*(\d{1,2}\s+\w+\.?\s+\d{4})',
            'requested_dates_pattern': r'EFTERFRÅGADE DATUM\s*(\d{1,2}\s+\w+\.?\s+\d{4})\s*-\s*(\d{1,2}\s+\w+\.?\s+\d{4})',
            # Modification patterns
            'modification_guest': r'(?:DIN BOKNING MED (.+?) HAR UPPDATERATS|Din bokning med (.+?) har uppdaterats)',
            'booking_code_url': r'/details/([A-Z0-9]{10})',
            'nightly_rate_eur': r'€\s*([\d\s,]+)\s*x\s*\d+\s*nätter',
            'guest_total_eur': r'(?:TOTALT\s*\([^\)]*\)|Gästens totala kostnad|Guest total|Total)\s*:?\s*€\s*([\d\s,]+)',
            'host_earnings_eur': r'(?:du tjänar|dina intäkter|your earnings|host earnings|Du tjänar|Dina intäkter)(?:\s*:?\s*\n?\s*€\s*([\d\s,.]+)|[^€]*?€\s*([\d\s,.]+)|\s*\n\s*€\s*([\d\s,.]+))',
            'host_earnings_sek': r'(?:du tjänar|dina intäkter|your earnings|host earnings|Du tjänar|Dina intäkter)(?:\s*:?\s*\n?\s*([\d\s,.]+)\s*kr|[^0-9]*?([\d\s,.]+)\s*kr|\s*\n\s*([\d\s,.]+)\s*kr)',
            # 2020-style SEK patterns for detailed breakdown (Swedish)
            'host_earnings_2020_sek': r'Utbetalning\s+([\d\s,.]+)\s*kr\s+SEK.*?Nätter\s+([\d\s,.]+)\s*kr\s+SEK',
            'guest_total_2020_sek': r'Totalt\s+([\d\s,.]+)\s*kr\s+SEK',
            'cleaning_fee_2020_sek': r'Städavgift\s+([\d\s,.]+)\s*kr\s+SEK',
            'service_fee_2020_sek': r'Serviceavgift\s+(?:−)?([\d\s,.]+)\s*kr\s+SEK',
            # 2020-style SEK patterns for detailed breakdown (English)
            'host_earnings_2020_sek_en': r'(?:Payout|Earnings)\s+([\d\s,.]+)\s*kr\s+SEK.*?(?:nights?|Nights?)\s+([\d\s,.]+)\s*kr\s+SEK',
            'guest_total_2020_sek_en': r'Total\s+([\d\s,.]+)\s*kr\s+SEK',
            'cleaning_fee_2020_sek_en': r'Cleaning fee\s+([\d\s,.]+)\s*kr\s+SEK',
            'service_fee_2020_sek_en': r'Service fee\s+(?:−)?([\d\s,.]+)\s*kr\s+SEK',
            'host_earnings_table': r'€[^\d]*?([\d\s,]+)(?:\s*\n[^\n]*?€[^\d]*?([\d\s,]+)){3,}',  # Match amounts in table, looking for host earnings pattern
            'cleaning_fee_eur': r'(?:Städavgift|Cleaning fee)\s*:?\s*€\s*([\d\s,]+)',
            'service_fee_eur': r'(?:Serviceavgift för värdar|Serviceavgift|Service fee)[^€]*€\s*([\d\s,]+)',
            'property_tax_eur': r'(?:Fastighetsskatter|Property tax)\s*:?\s*€\s*([\d\s,]+)',
            # Improved date patterns - more specific and robust
            'checkin_date': r'(?:Incheckning|Inch[eé�\ufffd]ckning)\s*:?\s*(\w{3})\s+(\d{1,2})\s+(\w+)\.?\s*(?:(\d{4}))?',
            'checkout_date': r'(?:Utcheckning)\s*:?\s*(\w{3})\s+(\d{1,2})\s+(\w+)\.?\s*(?:(\d{4}))?',
            # Combined check-in/check-out pattern for compact formats
            'checkin_checkout_combined': r'(?:Incheckning|Inch[eé�\ufffd]ckning)\s+(?:Utcheckning\s+)?(\w{3})\s+(\d{1,2})\s+(\w+)\.?\s*(?:(\d{4}))?\s+(\w{3})\s+(\d{1,2})\s+(\w+)\.?\s*(?:(\d{4}))?',
            # Alternative patterns for date ranges in different formats - restrict to actual date words
            'date_pair_pattern': r'([a-zA-ZÅÄÖåäö]{3})\s+(\d{1,2})\s+(jan|feb|mar|apr|maj|jun|jul|aug|sep|okt|nov|dec|januari|februari|mars|april|maj|juni|juli|augusti|september|oktober|november|december)\.?\s*(?:(\d{4}))?\s*(?:[-–]\s*|till\s*|to\s*)?([a-zA-ZÅÄÖåäö]{3})?\s*(\d{1,2})\s+(jan|feb|mar|apr|maj|jun|jul|aug|sep|okt|nov|dec|januari|februari|mars|april|maj|juni|juli|augusti|september|oktober|november|december)\.?\s*(?:(\d{4}))?',
            'guest_count': r'(?:Antal gäster|Number of guests|gäster):\s*(\d+)|(\d+)\s+(?:vuxna|adults|gäster)',
        }
        
        # Swedish month mapping
        self.swedish_months = {
            'jan': '01', 'januari': '01', 'feb': '02', 'februari': '02', 
            'mar': '03', 'mars': '03', 'apr': '04', 'april': '04',
            'maj': '05', 'jun': '06', 'juni': '06', 'jul': '07', 'juli': '07', 
            'aug': '08', 'augusti': '08', 'sep': '09', 'september': '09',
            'okt': '10', 'oktober': '10', 'nov': '11', 'november': '11', 
            'dec': '12', 'december': '12'
        }

    def parse_swedish_date(self, date_str):
        """Parse Swedish date format like '28 oktober 2025' to YYYY-MM-DD"""
        match = re.match(r'(\d{1,2})\s+(\w+)\.?\s+(\d{4})', date_str.strip())
        if match:
            day = match.group(1)
            month_name = match.group(2).lower()
            year = match.group(3)
            
            if month_name in self.swedish_months:
                month = self.swedish_months[month_name]
                return f"{year}-{month}-{day.zfill(2)}"
        return None

    def format_date_for_ml(self, date_str):
        """Convert YYYY-MM-DD to MM/DD/YYYY format for ML consistency"""
        try:
            parts = date_str.split('-')
            if len(parts) == 3:
                year, month, day = parts
                return f"{month}/{day}/{year}"
        except:
            pass
        return date_str

    def extract_features(self, subject, sender, body):
        """Extract hand-crafted features from email"""
        features = {
            # Sender features
            'sender_automated': 1 if 'automated@airbnb.com' in sender else 0,
            'sender_express': 1 if 'express@airbnb.com' in sender else 0,
            'sender_noreply': 1 if 'noreply@airbnb.com' in sender else 0,
            
            # Subject features
            'subject_confirmed': 1 if 'bekräftad' in subject.lower() or 'confirmed' in subject.lower() else 0,
            'subject_reminder': 1 if 'påminnelse' in subject.lower() or 'anländer snart' in subject.lower() else 0,
            'subject_payout': 1 if 'utbetalning' in subject.lower() and 'kr skickades' in subject.lower() else 0,
            'subject_cancelled': 1 if any(word in subject.lower() for word in ['avbokad', 'cancelled', 'inställd', 'avbruten', 'annullerad']) else 0,
            'subject_change_request': 1 if 'vill ändra' in subject.lower() else 0,
            'subject_modification': 1 if 'uppdaterad' in subject.lower() else 0,
            
            # Content features
            'has_booking_code': 1 if re.search(self.patterns['booking_code'], subject + ' ' + body) else 0,
            'has_amount_sek': 1 if re.search(self.patterns['amount_sek'], subject + ' ' + body) else 0,
            'has_amount_eur': 1 if re.search(self.patterns['amount_eur'], subject + ' ' + body) else 0,
            'has_original_dates': 1 if re.search(self.patterns['original_dates_pattern'], body, re.IGNORECASE) else 0,
            'has_requested_dates': 1 if re.search(self.patterns['requested_dates_pattern'], body, re.IGNORECASE) else 0,
            'has_booking_url': 1 if re.search(self.patterns['booking_code_url'], body) else 0,
            'has_cancellation_text': 1 if any(word in (subject + body).lower() for word in ['avbokad av', 'cancelled by', 'inställd av', 'avbruten av', 'bokning avbokad', 'booking cancelled', 'har avbokats', 'has been cancelled', 'annullerad', 'bokning annullerad']) else 0,
            
            # Language features
            'is_swedish': 1 if any(word in (subject + body).lower() for word in ['anländer', 'bekräftad', 'utbetalning', 'avbokad', 'inställd', 'avbruten', 'annullerad', 'vill ändra', 'uppdaterad', 'ursprungliga datum', 'efterfrågade datum']) else 0,
            
            # Length features
            'subject_length': len(subject),
            'body_length': len(body),
        }
        
        return list(features.values())

    def load_training_data(self, json_file):
        """Load training data from JSON file"""
        print(f"📖 Loading training data from {json_file}")
        
        with open(json_file, 'r', encoding='utf-8') as f:
            data = json.load(f)
        
        print(f"📊 Loaded {len(data)} training samples")
        
        # Extract features and labels
        X = []
        y = []
        emails = []
        
        for sample in data:
            # Extract features
            features = self.extract_features(
                sample['subject'], 
                sample['sender'], 
                sample['body']
            )
            
            X.append(features)
            y.append(self.label_encoder[sample['emailType']])
            emails.append(sample)
        
        return np.array(X), np.array(y), emails

    def train(self, X, y):
        """Train the classifier"""
        print("🎯 Training ML classifier...")
        
        # Split data
        X_train, X_test, y_train, y_test = train_test_split(
            X, y, test_size=0.2, random_state=42, stratify=y
        )
        
        # Train Random Forest classifier
        self.classifier = RandomForestClassifier(
            n_estimators=100,
            random_state=42,
            class_weight='balanced'
        )
        
        self.classifier.fit(X_train, y_train)
        
        # Evaluate
        y_pred = self.classifier.predict(X_test)
        
        print("\n📈 CLASSIFICATION RESULTS:")
        print("=" * 40)
        print(classification_report(y_test, y_pred, 
                                  target_names=list(self.label_encoder.keys())))
        
        print("\n📊 CONFUSION MATRIX:")
        cm = confusion_matrix(y_test, y_pred)
        print(cm)
        
        # Feature importance
        feature_names = [
            'sender_automated', 'sender_express', 'sender_noreply',
            'subject_confirmed', 'subject_reminder', 'subject_payout', 'subject_cancelled', 'subject_change_request', 'subject_modification',
            'has_booking_code', 'has_amount_sek', 'has_amount_eur', 'has_original_dates', 'has_requested_dates', 'has_booking_url', 'has_cancellation_text', 'is_swedish',
            'subject_length', 'body_length'
        ]
        
        importances = self.classifier.feature_importances_
        feature_importance = sorted(zip(feature_names, importances), key=lambda x: x[1], reverse=True)
        
        print("\n🔝 TOP FEATURES:")
        for name, importance in feature_importance[:10]:
            print(f"   {name}: {importance:.3f}")
        
        return X_test, y_test, y_pred

    def classify_email(self, subject, sender, body):
        """Classify a single email"""
        # Clean HTML content before processing
        cleaned_body = self.clean_html_content(body)
        
        features = np.array([self.extract_features(subject, sender, cleaned_body)])
        prediction = self.classifier.predict(features)[0]
        probability = self.classifier.predict_proba(features)[0]
        
        email_type = self.label_decoder[prediction]
        confidence = probability[prediction]
        
        return email_type, confidence
    
    def clean_html_content(self, body):
        """Clean HTML and noise from email body before ML processing"""
        # HTML cleaning is now done in TypeScript before calling Python
        # This method is kept for backwards compatibility but just returns the body
        return body

    def get_reference_year(self, email_date, month, day, scanning_year=None):
        """Get reference year based on email date and booking month/day"""
        if email_date:
            try:
                reference_date = datetime.strptime(email_date, '%Y-%m-%d').date()
                reference_year = reference_date.year
            except:
                reference_date = datetime.now().date()
                reference_year = reference_date.year
        else:
            # No email date provided - use scanning year context if available
            if scanning_year:
                # Use the scanning year as intelligent fallback
                # Most bookings are made within 6 months of the booking date
                reference_date = datetime(scanning_year, 6, 15).date()  # Mid-year of scanning period
                reference_year = scanning_year
                print(f"[DEBUG YEAR] No email_date provided, using scanning year {scanning_year} reference: {reference_date}", file=sys.stderr)
            else:
                # Last resort fallback - use current date instead of hardcoded year
                # This ensures we handle future years dynamically
                current_date = datetime.now().date()
                reference_date = current_date
                reference_year = current_date.year
                print(f"[DEBUG YEAR] No email_date or scanning_year provided, using current date fallback: {reference_date}", file=sys.stderr)
        
        # Create candidate date in reference year
        candidate_date = datetime(reference_year, month, day).date()
        
        print(f"[DEBUG YEAR] Comparing booking date {candidate_date} with reference {reference_date}", file=sys.stderr)
        
        # Smart cross-year logic for booking dates
        days_diff = (candidate_date - reference_date).days
        
        # Special case: Cross-year bookings around New Year
        # If email is in November/December and booking date is in January/February,
        # the booking is likely in the next year
        if (reference_date.month >= 11 and month <= 2 and days_diff < -300):
            result_year = reference_year + 1
            print(f"[DEBUG YEAR] Cross-year booking detected: email {reference_date} (month {reference_date.month}) with booking month {month}, using next year: {result_year}", file=sys.stderr)
            return result_year
        
        # If booking date would be in the past (negative days_diff), consider next year
        # This handles cases where emails are sent in advance for next year's bookings
        elif days_diff < 0:
            # Try next year and see if it makes more sense
            next_year_candidate = datetime(reference_year + 1, month, day).date()
            next_year_diff = (next_year_candidate - reference_date).days
            
            # If next year would put the booking within reasonable advance booking timeframe (1-540 days)
            if 1 <= next_year_diff <= 540:
                result_year = reference_year + 1
                print(f"[DEBUG YEAR] Booking date {candidate_date} is in past ({days_diff} days), next year {next_year_candidate} is {next_year_diff} days ahead, using next year: {result_year}", file=sys.stderr)
                return result_year
            else:
                print(f"[DEBUG YEAR] Booking date {candidate_date} is in past but next year ({next_year_diff} days) would be too far, using same year: {reference_year}", file=sys.stderr)
                return reference_year
        
        # If booking date is unreasonably far in the future (> 18 months from email), 
        # it's likely previous year. 18 months is generous for advance Airbnb bookings.
        elif days_diff > 540:  # 18 months
            result_year = reference_year - 1
            print(f"[DEBUG YEAR] Booking date {candidate_date} is {days_diff} days after email {reference_date}, using previous year: {result_year}", file=sys.stderr)
            return result_year
        
        # Default: same year as email (booking is in reasonable future timeframe)
        else:
            print(f"[DEBUG YEAR] Booking date {candidate_date} is {days_diff} days from email {reference_date}, using same year: {reference_year}", file=sys.stderr)
            return reference_year

    def extract_booking_data(self, email_type, subject, sender, body, email_date=None, scanning_year=None):
        """Extract specific booking data based on email type"""
        # Clean HTML content before data extraction
        cleaned_body = self.clean_html_content(body)
        
        data = {
            'emailType': email_type,
            'bookingCode': None,
            'guestName': None,
            'amount': None,
            'currency': None,
            'checkInDate': None,
            'checkOutDate': None,
            # Financial data - EUR
            'nights': None,
            'guestTotalEur': None,
            'hostEarningsEur': None,
            'cleaningFeeEur': None,
            'nightlyRateEur': None,
            'serviceFeeEur': None,
            'propertyTaxEur': None,
            # Financial data - SEK (for 2020-2021)
            'guestTotalSek': None,
            'hostEarningsSek': None,
            'cleaningFeeSek': None,
            'serviceFeeSek': None,
            'guestCount': None
        }
        
        full_text = subject + ' ' + body
        
        # Extract booking code (common to all types)
        booking_match = re.search(self.patterns['booking_code'], full_text)
        if booking_match:
            data['bookingCode'] = booking_match.group(0)
        
        if email_type == 'booking_confirmation':
            # Extract guest name from confirmation - try multiple patterns
            guest_name = None
            for pattern in self.patterns['guest_name_confirmation']:
                name_match = re.search(pattern, subject, re.IGNORECASE)
                if name_match:
                    guest_name = name_match.group(1).strip()
                    # Clean up name (remove extra whitespace, dots, etc.)
                    guest_name = re.sub(r'\s+', ' ', guest_name)  # Multiple spaces to single
                    guest_name = guest_name.strip(' .!,')  # Remove trailing punctuation
                    if len(guest_name) >= 3:  # Reasonable name length
                        data['guestName'] = guest_name
                        # print(f"[DEBUG] Found guest: {data['guestName']} (pattern: {pattern[:30]}...)", file=sys.stderr)
                        break
            
            if not guest_name:
                # Check if this is a private booking (no guest name in subject)
                for pattern in self.patterns['private_booking_patterns']:
                    private_match = re.search(pattern, subject, re.IGNORECASE)
                    if private_match:
                        location = private_match.group(1).strip()
                        print(f"[DEBUG] Detected private booking for location: {location}", file=sys.stderr)
                        data['guestName'] = f"Private booking ({location})"
                        break
            
            # Extract check-in date from subject (Swedish and English)
            date_match = re.search(r'anländer (\d{1,2}) ([a-zåäö]+)', subject.lower())
            if date_match:
                day, month_sv = date_match.groups()
                if month_sv in self.swedish_months:
                    parsed_month = int(self.swedish_months[month_sv])
                    parsed_day = int(day)
                    year = self.get_reference_year(email_date, parsed_month, parsed_day, scanning_year)
                    print(f"[DEBUG SUBJECT] Subject date: {day} {month_sv}, email_date={email_date}, year={year}", file=sys.stderr)
                    data['checkInDate'] = f"{year}-{self.swedish_months[month_sv]}-{day.zfill(2)}"
            else:
                # Try English format: "arrives May 30"
                date_match = re.search(r'arrives ([a-z]+) (\d{1,2})', subject.lower())
                if date_match:
                    month_en, day = date_match.groups()
                    # Add English month mapping
                    english_months = {
                        'january': '01', 'jan': '01', 'february': '02', 'feb': '02',
                        'march': '03', 'mar': '03', 'april': '04', 'apr': '04',
                        'may': '05', 'june': '06', 'jun': '06', 'july': '07', 'jul': '07',
                        'august': '08', 'aug': '08', 'september': '09', 'sep': '09',
                        'october': '10', 'oct': '10', 'november': '11', 'nov': '11',
                        'december': '12', 'dec': '12'
                    }
                    if month_en in english_months:
                        parsed_month = int(english_months[month_en])
                        parsed_day = int(day)
                        year = self.get_reference_year(email_date, parsed_month, parsed_day, scanning_year)
                        print(f"[DEBUG SUBJECT EN] Subject date: {month_en} {day}, email_date={email_date}, year={year}", file=sys.stderr)
                        data['checkInDate'] = f"{year}-{english_months[month_en]}-{day.zfill(2)}"
            
            # Extract detailed dates from email body
            # First try combined check-in/check-out pattern
            combined_match = re.search(self.patterns['checkin_checkout_combined'], cleaned_body, re.IGNORECASE)
            if combined_match:
                day_name1, day1, month1, year1, day_name2, day2, month2, year2 = combined_match.groups()
                print(f"[DEBUG] Combined match: '{combined_match.group(0)}' → checkin: {day_name1} {day1} {month1} {year1}, checkout: {day_name2} {day2} {month2} {year2}", file=sys.stderr)
                
                # Process check-in date
                if month1.lower() in self.swedish_months:
                    if not year1:
                        parsed_month = int(self.swedish_months[month1.lower()])
                        parsed_day = int(day1)
                        year1 = str(self.get_reference_year(email_date, parsed_month, parsed_day, scanning_year))
                        print(f"[DEBUG YEAR] Check-in: month={month1.lower()}, parsed_month={parsed_month}, year={year1}", file=sys.stderr)
                    print(f"[DEBUG YEAR] Final check-in date: {year1}-{self.swedish_months[month1.lower()]}-{day1.zfill(2)}", file=sys.stderr)
                    data['checkInDate'] = f"{year1}-{self.swedish_months[month1.lower()]}-{day1.zfill(2)}"
                
                # Process check-out date
                if month2.lower() in self.swedish_months:
                    if not year2:
                        parsed_month = int(self.swedish_months[month2.lower()])
                        parsed_day = int(day2)
                        year2 = str(self.get_reference_year(email_date, parsed_month, parsed_day, scanning_year))
                        
                        # Check for cross-year bookings: if checkout month is earlier than checkin month,
                        # it's likely the checkout is in the next year
                        checkin_month_num = int(self.swedish_months[month1.lower()])
                        checkout_month_num = parsed_month
                        
                        if checkout_month_num < checkin_month_num:
                            # Cross-year booking: checkout is in next year
                            year2 = str(int(year1) + 1)
                            print(f"[DEBUG COMBINED] Cross-year detected: checkin month {checkin_month_num} > checkout month {checkout_month_num}, using year {year2} for checkout", file=sys.stderr)
                        else:
                            print(f"[DEBUG COMBINED] Same year: checkin month {checkin_month_num} <= checkout month {checkout_month_num}, using year {year2} for checkout", file=sys.stderr)
                    data['checkOutDate'] = f"{year2}-{self.swedish_months[month2.lower()]}-{day2.zfill(2)}"
            
            # If combined pattern didn't work, try individual patterns
            if not data.get('checkInDate'):
                checkin_match = re.search(self.patterns['checkin_date'], cleaned_body, re.IGNORECASE)
                if checkin_match:
                    day_name, day, month, year = checkin_match.groups()
                    print(f"[DEBUG] Check-in match: '{checkin_match.group(0)}' → day_name={day_name}, day={day}, month={month}, year={year}", file=sys.stderr)
                    if month.lower() in self.swedish_months:
                        # If no year provided, use email-date based logic
                        if not year:
                            parsed_month = int(self.swedish_months[month.lower()])
                            parsed_day = int(day)
                            year = str(self.get_reference_year(email_date, parsed_month, parsed_day, scanning_year))
                        data['checkInDate'] = f"{year}-{self.swedish_months[month.lower()]}-{day.zfill(2)}"
            
            if not data.get('checkOutDate'):
                checkout_match = re.search(self.patterns['checkout_date'], cleaned_body, re.IGNORECASE)
                if checkout_match:
                    day_name, day, month, year = checkout_match.groups()
                    print(f"[DEBUG] Check-out match: '{checkout_match.group(0)}' → day_name={day_name}, day={day}, month={month}, year={year}", file=sys.stderr)
                    if month.lower() in self.swedish_months:
                        # If no year provided, use email-date based logic
                        if not year:
                            parsed_month = int(self.swedish_months[month.lower()])
                            parsed_day = int(day)
                            year = str(self.get_reference_year(email_date, parsed_month, parsed_day, scanning_year))
                            
                            # Check for cross-year bookings if we already have a check-in date
                            if data.get('checkInDate'):
                                try:
                                    checkin_date = datetime.strptime(data['checkInDate'], '%Y-%m-%d')
                                    checkout_month_num = parsed_month
                                    checkin_month_num = checkin_date.month
                                    
                                    if checkout_month_num < checkin_month_num:
                                        # Cross-year booking: checkout is in next year
                                        year = str(int(year) + 1)
                                        print(f"[DEBUG CHECKOUT] Cross-year detected: checkin month {checkin_month_num} > checkout month {checkout_month_num}, using year {year} for checkout", file=sys.stderr)
                                except ValueError:
                                    pass  # Keep original year if parsing fails
                        data['checkOutDate'] = f"{year}-{self.swedish_months[month.lower()]}-{day.zfill(2)}"
            
            # Fallback: Try date pair pattern if individual dates failed or are identical
            print(f"[DEBUG DATEPAIR] Pre-check: checkInDate={data.get('checkInDate')}, checkOutDate={data.get('checkOutDate')}", file=sys.stderr)
            if not data.get('checkInDate') or not data.get('checkOutDate') or data.get('checkInDate') == data.get('checkOutDate'):
                date_pair_match = re.search(self.patterns['date_pair_pattern'], cleaned_body, re.IGNORECASE)
                if date_pair_match:
                    groups = date_pair_match.groups()
                    # Pattern captures: (day1, date1, month1, year1, day2_opt, date2, month2, year2)
                    day1, date1, month1, year1, day2_opt, date2, month2, year2 = groups
                    print(f"[DEBUG DATEPAIR] Date pair match: '{date_pair_match.group(0)}' → groups={groups}", file=sys.stderr)
                    
                    # Validate months before processing
                    if month1.lower() not in self.swedish_months or month2.lower() not in self.swedish_months:
                        print(f"[DEBUG DATEPAIR] Invalid months '{month1}' or '{month2}', skipping date pair pattern", file=sys.stderr)
                    else:
                        # Use email-date based year logic if not provided
                        if not year1:
                            parsed_month = int(self.swedish_months[month1.lower()])
                            parsed_day = int(date1)
                            year1 = str(self.get_reference_year(email_date, parsed_month, parsed_day, scanning_year))
                            print(f"[DEBUG DATEPAIR] Email-date based year for date1: month={month1}, year={year1}", file=sys.stderr)
                        if not year2:
                            # Check for cross-year bookings: if checkout month is earlier than checkin month,
                            # it's likely the checkout is in the next year
                            checkin_month_num = int(self.swedish_months[month1.lower()])
                            checkout_month_num = int(self.swedish_months[month2.lower()])
                            
                            if checkout_month_num < checkin_month_num:
                                # Cross-year booking: checkout is in next year
                                year2 = str(int(year1) + 1)
                                print(f"[DEBUG DATEPAIR] Cross-year detected: checkin month {checkin_month_num} > checkout month {checkout_month_num}, using year {year2} for checkout", file=sys.stderr)
                            else:
                                year2 = year1  # Same year for checkout
                                print(f"[DEBUG DATEPAIR] Same year: checkin month {checkin_month_num} <= checkout month {checkout_month_num}, using year {year2} for checkout", file=sys.stderr)
                        
                        # Parse both dates to ensure chronological order
                        try:
                            date1_obj = datetime.strptime(f"{year1}-{self.swedish_months[month1.lower()]}-{date1.zfill(2)}", "%Y-%m-%d")
                            date2_obj = datetime.strptime(f"{year2}-{self.swedish_months[month2.lower()]}-{date2.zfill(2)}", "%Y-%m-%d")
                            
                            # Ensure check-in is before check-out
                            if date1_obj <= date2_obj:
                                data['checkInDate'] = f"{year1}-{self.swedish_months[month1.lower()]}-{date1.zfill(2)}"
                                data['checkOutDate'] = f"{year2}-{self.swedish_months[month2.lower()]}-{date2.zfill(2)}"
                                print(f"[DEBUG] Date pair (chronological order): {data['checkInDate']} → {data['checkOutDate']}", file=sys.stderr)
                            else:
                                # Swap dates if they're in wrong order
                                data['checkInDate'] = f"{year2}-{self.swedish_months[month2.lower()]}-{date2.zfill(2)}"
                                data['checkOutDate'] = f"{year1}-{self.swedish_months[month1.lower()]}-{date1.zfill(2)}"
                                print(f"[DEBUG] Date pair (swapped for chronological order): {data['checkInDate']} → {data['checkOutDate']}", file=sys.stderr)
                        except (ValueError, KeyError) as e:
                            print(f"[DEBUG] Error parsing date pair: {e}", file=sys.stderr)
            
            # Final fallback: Find all Swedish dates in text and pick realistic date pairs
            print(f"[DEBUG FALLBACK] checkInDate={data.get('checkInDate')}, checkOutDate={data.get('checkOutDate')}", file=sys.stderr)
            if not data.get('checkInDate') or not data.get('checkOutDate') or data.get('checkInDate') == data.get('checkOutDate'):
                print(f"[DEBUG FALLBACK] Using fallback date extraction", file=sys.stderr)
                # Enhanced pattern to better capture dates with explicit years - use non-capturing groups for better matching
                all_dates_pattern = r'(\d{1,2})\s+(jan|feb|mar|apr|maj|jun|jul|aug|sep|okt|nov|dec|januari|februari|mars|april|maj|juni|juli|augusti|september|oktober|november|december)\.?\s*(\d{4})?'
                
                # Debug: test the pattern more thoroughly
                test_match = re.search(r'(\d{1,2})\s+(juni)\s+(\d{4})', cleaned_body, re.IGNORECASE)
                if test_match:
                    print(f"[DEBUG REGEX] Direct juni match found: {test_match.groups()}", file=sys.stderr)
                
                all_dates = re.findall(all_dates_pattern, cleaned_body, re.IGNORECASE)
                print(f"[DEBUG REGEX] Raw findall result: {all_dates}", file=sys.stderr)
                
                # Also try a more specific pattern for explicit years
                year_specific_pattern = r'(\d{1,2})\s+(jan|feb|mar|apr|maj|jun|jul|aug|sep|okt|nov|dec|januari|februari|mars|april|maj|juni|juli|augusti|september|oktober|november|december)\s+(\d{4})'
                year_dates = re.findall(year_specific_pattern, cleaned_body, re.IGNORECASE)
                print(f"[DEBUG REGEX] Year-specific pattern result: {year_dates}", file=sys.stderr)
                print(f"[DEBUG DATES] Found raw dates in email: {all_dates}", file=sys.stderr)
                
                # Combine both patterns - prioritize year-specific dates when available
                combined_dates = []
                
                # Add year-specific dates first (these are more reliable)
                for day, month, year in year_dates:
                    combined_dates.append((day, month, year))
                    print(f"[DEBUG COMBINE] Added year-specific date: {day} {month} {year}", file=sys.stderr)
                
                # Add dates without years (but avoid duplicates)
                for day, month, year in all_dates:
                    # Only add if we don't already have this day/month combination with a year
                    has_year_version = any(d == day and m == month for d, m, y in year_dates)
                    if not has_year_version:
                        combined_dates.append((day, month, year))
                        print(f"[DEBUG COMBINE] Added non-year date: {day} {month} {year or 'NO_YEAR'}", file=sys.stderr)
                
                print(f"[DEBUG COMBINED] Final combined dates: {combined_dates}", file=sys.stderr)
                
                # Convert all dates to datetime objects for comparison
                parsed_dates = []
                for day, month, year in combined_dates:
                    if month.lower() in self.swedish_months:
                        if not year:
                            parsed_month = int(self.swedish_months[month.lower()])
                            parsed_day = int(day)
                            year = str(self.get_reference_year(email_date, parsed_month, parsed_day, scanning_year))
                        try:
                            date_obj = datetime.strptime(f"{year}-{self.swedish_months[month.lower()]}-{day.zfill(2)}", "%Y-%m-%d")
                            date_str = f"{year}-{self.swedish_months[month.lower()]}-{day.zfill(2)}"
                            print(f"[DEBUG PARSE] Converting {day} {month} {year or 'NO_YEAR'} → {date_str}", file=sys.stderr)
                            if date_str not in [d[1] for d in parsed_dates]:
                                parsed_dates.append((date_obj, date_str))
                        except ValueError:
                            continue  # Invalid date, skip
                
                # Sort dates chronologically
                parsed_dates.sort(key=lambda x: x[0])
                
                # Find the best date pair - prioritize different days over different years
                best_pair = None
                best_score = 0
                
                for i in range(len(parsed_dates)):
                    for j in range(i + 1, len(parsed_dates)):
                        checkin_date, checkin_str = parsed_dates[i]
                        checkout_date, checkout_str = parsed_dates[j]
                        nights = (checkout_date - checkin_date).days
                        
                        # Only consider realistic booking lengths (1-30 nights)
                        if 1 <= nights <= 30:
                            score = 0
                            
                            # NEW: Highest priority - prefer dates that came from explicit year patterns
                            # Extract month from checkin_str and checkout_str for comparison
                            checkin_month = None
                            checkout_month = None
                            try:
                                checkin_month = int(checkin_str.split('-')[1])
                                checkout_month = int(checkout_str.split('-')[1])
                            except:
                                pass
                            
                            checkin_has_explicit_year = any(
                                d == str(checkin_date.day) and 
                                (m.lower() in self.swedish_months and int(self.swedish_months[m.lower()]) == checkin_month)
                                for d, m, y in year_dates if y
                            )
                            checkout_has_explicit_year = any(
                                d == str(checkout_date.day) and 
                                (m.lower() in self.swedish_months and int(self.swedish_months[m.lower()]) == checkout_month)
                                for d, m, y in year_dates if y
                            )
                            
                            if checkin_has_explicit_year and checkout_has_explicit_year:
                                score += 20  # Highest priority for explicit years
                                print(f"[DEBUG SCORE] Explicit year bonus: +20 for {checkin_str} → {checkout_str}", file=sys.stderr)
                            
                            # Prefer different days (higher score)
                            if checkin_date.day != checkout_date.day:
                                score += 10
                                
                            # Prefer realistic bookings over same year preference
                            # For short bookings (1-30 nights), cross-year is totally normal around New Year
                            if checkin_date.year == checkout_date.year:
                                score += 3  # Reduced from 5 to 3
                            elif abs(checkin_date.year - checkout_date.year) == 1 and nights <= 14:
                                # Cross-year bookings are common around New Year for short stays
                                score += 4  # Slightly favor cross-year for short bookings
                                
                            # Prefer shorter stays (2-7 nights get bonus)
                            if 2 <= nights <= 7:
                                score += 3
                            elif 8 <= nights <= 14:
                                score += 2
                                
                            print(f"[DEBUG] Date pair candidate: {checkin_str} → {checkout_str} ({nights} nights, score: {score})", file=sys.stderr)
                            
                            # Use score with tiebreaker: prefer later years when score is equal
                            if score > best_score or (score == best_score and checkin_date.year > int(best_pair[0].split('-')[0]) if best_pair else 0):
                                best_pair = (checkin_str, checkout_str)
                                best_score = score
                                print(f"[DEBUG] New best pair: {checkin_str} → {checkout_str} (score: {score})", file=sys.stderr)
                
                if best_pair:
                    data['checkInDate'], data['checkOutDate'] = best_pair
                elif len(parsed_dates) >= 2:
                    # Fallback to first two dates if no realistic pair found
                    data['checkInDate'] = parsed_dates[0][1]
                    data['checkOutDate'] = parsed_dates[1][1]
                    print(f"[DEBUG] Fallback date pair: {parsed_dates[0][1]} → {parsed_dates[1][1]}", file=sys.stderr)
            
            # Calculate nights if we have both check-in and check-out dates
            if data.get('checkInDate') and data.get('checkOutDate'):
                try:
                    checkin = datetime.strptime(data['checkInDate'], '%Y-%m-%d')
                    checkout = datetime.strptime(data['checkOutDate'], '%Y-%m-%d')
                    nights = (checkout - checkin).days
                    if nights > 0:
                        data['nights'] = nights
                        print(f"[DEBUG] Calculated nights: {data['checkInDate']} to {data['checkOutDate']} = {nights} nights", file=sys.stderr)
                except (ValueError, TypeError) as e:
                    print(f"[DEBUG] Error calculating nights: {e}", file=sys.stderr)
            
            # Extract financial data from body - try to find nights from text if not calculated
            if not data.get('nights'):
                nights_match = re.search(self.patterns['nights'], cleaned_body)
                if nights_match:
                    try:
                        # Handle both capturing groups from the regex
                        nights_num = nights_match.group(1) or nights_match.group(2)
                        data['nights'] = int(nights_num)
                        print(f"[DEBUG] Found nights from text: {nights_num}", file=sys.stderr)
                    except (ValueError, TypeError):
                        pass
            
            # Extract guest total
            guest_total_match = re.search(self.patterns['guest_total_eur'], cleaned_body, re.IGNORECASE)
            if guest_total_match:
                # Handle Swedish format: "1 234,56" -> "1234.56"
                amount_str = guest_total_match.group(1)
                amount_str = re.sub(r'[\s\u00a0]+', '', amount_str).replace(',', '.')
                try:
                    data['guestTotalEur'] = float(amount_str)
                except ValueError:
                    pass
            
            # Extract host earnings
            host_earnings_match = re.search(self.patterns['host_earnings_eur'], cleaned_body, re.IGNORECASE)
            if host_earnings_match:
                # Handle both Swedish format: "1 234,56" and US format: "1,234.56"
                # Check all three capture groups (direct match, HTML table match, and newline separated)
                amount_str = host_earnings_match.group(1) or host_earnings_match.group(2) or host_earnings_match.group(3)
                amount_str = re.sub(r'[\s\u00a0]+', '', amount_str)
                
                # Smart format detection
                if ',' in amount_str and '.' in amount_str:
                    # US format: "1,234.56" -> remove comma, keep dot
                    amount_str = amount_str.replace(',', '')
                elif ',' in amount_str and '.' not in amount_str:
                    # Swedish format: "1234,56" -> replace comma with dot
                    amount_str = amount_str.replace(',', '.')
                # If only dot, keep as-is (already correct format)
                
                try:
                    data['hostEarningsEur'] = float(amount_str)
                    data['currency'] = 'EUR'
                    print(f"[DEBUG] Host earnings EUR match found: {amount_str} -> {data['hostEarningsEur']}", file=sys.stderr)
                except ValueError:
                    pass
            
            # If no EUR found, try SEK parsing (for 2020-2021 emails)
            if not data.get('hostEarningsEur'):
                host_earnings_sek_match = re.search(self.patterns['host_earnings_sek'], cleaned_body, re.IGNORECASE)
                if host_earnings_sek_match:
                    # Check all three capture groups (direct match, HTML table match, and newline separated)
                    amount_str = host_earnings_sek_match.group(1) or host_earnings_sek_match.group(2) or host_earnings_sek_match.group(3)
                    amount_str = re.sub(r'[\s\u00a0]+', '', amount_str).replace(',', '.')
                    
                    try:
                        sek_amount = float(amount_str)
                        # Store in SEK fields (don't convert to EUR)
                        data['hostEarningsSek'] = sek_amount
                        data['currency'] = 'SEK'
                        print(f"[DEBUG] Host earnings SEK match found: {amount_str} kr -> {sek_amount} SEK (native)", file=sys.stderr)
                    except ValueError:
                        pass
            
            # Try 2020-style SEK patterns (detailed breakdown format)
            if not data.get('hostEarningsEur') and not data.get('hostEarningsSek'):
                # Try host earnings from 2020 "Utbetalning/Payout" pattern (Swedish and English)
                host_earnings_2020_match = re.search(self.patterns['host_earnings_2020_sek'], cleaned_body, re.IGNORECASE)
                if not host_earnings_2020_match:
                    host_earnings_2020_match = re.search(self.patterns['host_earnings_2020_sek_en'], cleaned_body, re.IGNORECASE)
                
                if host_earnings_2020_match:
                    total_amount_str = host_earnings_2020_match.group(2)  # Second capture group is the total amount
                    total_amount_str = re.sub(r'[\s\u00a0]+', '', total_amount_str).replace(',', '.')
                    
                    try:
                        sek_amount = float(total_amount_str)
                        data['hostEarningsSek'] = sek_amount
                        data['currency'] = 'SEK'
                        print(f"[DEBUG] Host earnings from 2020 format: {total_amount_str} -> {sek_amount} SEK", file=sys.stderr)
                    except ValueError:
                        pass
                
                # Try guest total from 2020 format (Swedish and English)
                if not data.get('guestTotalSek'):
                    guest_total_2020_match = re.search(self.patterns['guest_total_2020_sek'], cleaned_body, re.IGNORECASE)
                    if not guest_total_2020_match:
                        guest_total_2020_match = re.search(self.patterns['guest_total_2020_sek_en'], cleaned_body, re.IGNORECASE)
                    
                    if guest_total_2020_match:
                        amount_str = guest_total_2020_match.group(1)
                        amount_str = re.sub(r'[\s\u00a0]+', '', amount_str).replace(',', '.')
                        
                        try:
                            data['guestTotalSek'] = float(amount_str)
                            print(f"[DEBUG] Guest total from 2020 format: {amount_str} -> {data['guestTotalSek']} SEK", file=sys.stderr)
                        except ValueError:
                            pass
                
                # Try cleaning fee from 2020 format (Swedish and English)
                if not data.get('cleaningFeeSek'):
                    cleaning_fee_2020_match = re.search(self.patterns['cleaning_fee_2020_sek'], cleaned_body, re.IGNORECASE)
                    if not cleaning_fee_2020_match:
                        cleaning_fee_2020_match = re.search(self.patterns['cleaning_fee_2020_sek_en'], cleaned_body, re.IGNORECASE)
                    
                    if cleaning_fee_2020_match:
                        amount_str = cleaning_fee_2020_match.group(1)
                        amount_str = re.sub(r'[\s\u00a0]+', '', amount_str).replace(',', '.')
                        
                        try:
                            data['cleaningFeeSek'] = float(amount_str)
                            print(f"[DEBUG] Cleaning fee from 2020 format: {amount_str} -> {data['cleaningFeeSek']} SEK", file=sys.stderr)
                        except ValueError:
                            pass
                
                # Try service fee from 2020 format (may be negative, Swedish and English)
                if not data.get('serviceFeeSek'):
                    service_fee_2020_match = re.search(self.patterns['service_fee_2020_sek'], cleaned_body, re.IGNORECASE)
                    if not service_fee_2020_match:
                        service_fee_2020_match = re.search(self.patterns['service_fee_2020_sek_en'], cleaned_body, re.IGNORECASE)
                    
                    if service_fee_2020_match:
                        amount_str = service_fee_2020_match.group(1)
                        amount_str = re.sub(r'[\s\u00a0]+', '', amount_str).replace(',', '.')
                        
                        # Check if the original match had a minus sign
                        if '−' in service_fee_2020_match.group(0) or '-' in service_fee_2020_match.group(0):
                            amount_str = '-' + amount_str
                        
                        try:
                            data['serviceFeeSek'] = float(amount_str)
                            print(f"[DEBUG] Service fee from 2020 format: {amount_str} -> {data['serviceFeeSek']} SEK", file=sys.stderr)
                        except ValueError:
                            pass
            
            # If still no earnings found (neither EUR nor SEK), try fallback patterns
            if not data.get('hostEarningsEur') and not data.get('hostEarningsSek'):
                # Fallback: Extract host earnings from Gmail two-table format
                # Look for the "Värds utbetalning" / "Du tjänar" pattern first
                # Handle character encoding issues (Ä → �, etc.)
                du_tjanar_pattern = r'(?:Du tj[äå�\ufffd][nr][ar]+|DU TJ[ÄÅ�\ufffd][NR][AR]+)[^\d]*€[^\d]*?([\d\s,]+)'
                du_tjanar_match = re.search(du_tjanar_pattern, cleaned_body, re.IGNORECASE)
                
                if du_tjanar_match:
                    amount_str = du_tjanar_match.group(1)
                    amount_str = re.sub(r'[\s\u00a0]+', '', amount_str).replace(',', '.')
                    try:
                        data['hostEarningsEur'] = float(amount_str)
                        data['currency'] = 'EUR'
                        print(f"[DEBUG] Host earnings from 'Du tjänar' EUR: {amount_str} -> {data['hostEarningsEur']}", file=sys.stderr)
                    except ValueError:
                        pass
                else:
                    # Try SEK version of "Du tjänar"
                    du_tjanar_sek_pattern = r'(?:Du tj[äå�\ufffd][nr][ar]+|DU TJ[ÄÅ�\ufffd][NR][AR]+)[^\d]*?([\d\s,.]+)\s*kr'
                    du_tjanar_sek_match = re.search(du_tjanar_sek_pattern, cleaned_body, re.IGNORECASE)
                    
                    if du_tjanar_sek_match:
                        amount_str = du_tjanar_sek_match.group(1)
                        amount_str = re.sub(r'[\s\u00a0]+', '', amount_str).replace(',', '.')
                        try:
                            sek_amount = float(amount_str)
                            # Store in SEK fields (don't convert to EUR)
                            data['hostEarningsSek'] = sek_amount
                            data['currency'] = 'SEK'
                            print(f"[DEBUG] Host earnings from 'Du tjänar' SEK: {amount_str} kr -> {sek_amount} SEK (native)", file=sys.stderr)
                        except ValueError:
                            pass
                
                if not data.get('hostEarningsEur') and not data.get('hostEarningsSek'):
                    # Final fallback to generic table format
                    euro_amounts = re.findall(r'€[^\d]*?([\d\s,]+)', body)
                    print(f"[DEBUG] Found {len(euro_amounts)} Euro amounts: {euro_amounts}", file=sys.stderr)
                    
                    if len(euro_amounts) >= 8:
                        # Two-table structure: Look for the largest reasonable amount (host earnings)
                        # Usually the second-largest amount after guest total
                        amounts_parsed = []
                        for amount_str in euro_amounts:
                            clean_str = re.sub(r'[\s\u00a0]+', '', amount_str).replace(',', '.')
                            try:
                                val = float(clean_str)
                                if 1 <= val <= 1000:  # Host earnings range (lowered minimum from 50 to 1)
                                    amounts_parsed.append(val)
                            except ValueError:
                                continue
                        
                        if amounts_parsed:
                            # Prefer smaller amounts for host earnings (more likely to be correct)
                            # Sort by amount and prefer the smallest reasonable one
                            amounts_parsed.sort()
                            potential_earnings = amounts_parsed[0] if amounts_parsed[0] <= 100 else max(amounts_parsed)
                            data['hostEarningsEur'] = potential_earnings
                            print(f"[DEBUG] Host earnings from two-table (preferring smaller): {potential_earnings} from {amounts_parsed}", file=sys.stderr)
                    elif len(euro_amounts) >= 4:
                        # Single table fallback (original logic)
                        potential_earnings = None
                        for i in range(max(0, len(euro_amounts) - 3), len(euro_amounts) - 1):
                            amount_str = euro_amounts[i]
                            amount_str = re.sub(r'[\s\u00a0]+', '', amount_str).replace(',', '.')
                            try:
                                amount_val = float(amount_str)
                                if 20 <= amount_val <= 500:  # Reasonable range for host earnings
                                    potential_earnings = amount_val
                                    print(f"[DEBUG] Potential host earnings from position {i}: {amount_str} -> {amount_val}", file=sys.stderr)
                            except ValueError:
                                continue
                        
                        if potential_earnings:
                            data['hostEarningsEur'] = potential_earnings
                            print(f"[DEBUG] Host earnings from single table: {potential_earnings}", file=sys.stderr)
                
                # Debug: Show why host earnings wasn't found for confirmation emails
                if not data.get('hostEarningsEur') and data.get('emailType') == 'booking_confirmation':
                    has_du_tjanar = 'du tjänar' in body.lower()
                    has_dina_intakter = 'dina intäkter' in body.lower()
                    print(f"[DEBUG] Confirmation email: has_du_tjanar={has_du_tjanar}, has_dina_intakter={has_dina_intakter}", file=sys.stderr)
                    if has_du_tjanar or has_dina_intakter:
                        print(f"[DEBUG] Body snippet around 'Du tjänar': {body[body.lower().find('du tjänar')-50:body.lower().find('du tjänar')+100] if has_du_tjanar else body[body.lower().find('dina intäkter')-50:body.lower().find('dina intäkter')+100]}", file=sys.stderr)
                    else:
                        print(f"[DEBUG] No 'Du tjänar' or 'Dina intäkter' found. Body contains 'tjänar': {'tjänar' in body.lower()}", file=sys.stderr)
                    
                    # Show Euro amounts found in body for debugging
                    euro_amounts = re.findall(r'€[^\d]*?([\d\s,]+)', body)
                    print(f"[DEBUG] Found {len(euro_amounts)} Euro amounts: {euro_amounts[:5]}", file=sys.stderr)
                    print(f"[DEBUG] Body type: {type(body)}, length: {len(body)}", file=sys.stderr)
            
            # Extract cleaning fee
            cleaning_fee_match = re.search(self.patterns['cleaning_fee_eur'], cleaned_body)
            if cleaning_fee_match:
                # Handle Swedish format: "1 234,56" -> "1234.56"
                amount_str = cleaning_fee_match.group(1)
                amount_str = re.sub(r'[\s\u00a0]+', '', amount_str).replace(',', '.')
                try:
                    data['cleaningFeeEur'] = float(amount_str)
                except ValueError:
                    pass
            
            # Extract nightly rate
            nightly_rate_match = re.search(self.patterns['nightly_rate_eur'], cleaned_body)
            if nightly_rate_match:
                # Handle Swedish format: "1 234,56" -> "1234.56"
                amount_str = nightly_rate_match.group(1)
                amount_str = re.sub(r'[\s\u00a0]+', '', amount_str).replace(',', '.')
                try:
                    data['nightlyRateEur'] = float(amount_str)
                except ValueError:
                    pass
            
            # Extract service fee
            service_fee_match = re.search(self.patterns['service_fee_eur'], cleaned_body)
            if service_fee_match:
                # Handle Swedish format: "1 234,56" -> "1234.56"
                amount_str = service_fee_match.group(1)
                amount_str = re.sub(r'[\s\u00a0]+', '', amount_str).replace(',', '.')
                try:
                    data['serviceFeeEur'] = float(amount_str)
                except ValueError:
                    pass
            
            # Extract property tax
            property_tax_match = re.search(self.patterns['property_tax_eur'], cleaned_body)
            if property_tax_match:
                # Handle Swedish format: "1 234,56" -> "1234.56"
                amount_str = property_tax_match.group(1)
                amount_str = re.sub(r'[\s\u00a0]+', '', amount_str).replace(',', '.')
                try:
                    data['propertyTaxEur'] = float(amount_str)
                except ValueError:
                    pass
            
            # Extract guest count
            guest_count_match = re.search(self.patterns['guest_count'], cleaned_body)
            if guest_count_match:
                try:
                    # Handle both capturing groups from the regex
                    guest_num = guest_count_match.group(1) or guest_count_match.group(2)
                    data['guestCount'] = int(guest_num)
                except (ValueError, TypeError):
                    pass
        
        elif email_type == 'booking_reminder':
            # Extract guest name from reminder - try multiple patterns
            guest_name = None
            for pattern in self.patterns['guest_name_reminder']:
                name_match = re.search(pattern, subject, re.IGNORECASE)
                if name_match:
                    guest_name = name_match.group(1).strip()
                    # Clean up name
                    guest_name = re.sub(r'\s+', ' ', guest_name)
                    guest_name = guest_name.strip(' .!,')
                    if len(guest_name) >= 3:
                        data['guestName'] = guest_name
                        break
            
            if not guest_name:
                pass  # No guest name found
        
        elif email_type == 'payout':
            # Extract amount in SEK - search in both subject and body
            full_text = subject + ' ' + body
            amount_match = re.search(self.patterns['amount_sek'], full_text)
            if amount_match:
                # Handle both Swedish formats: "5 998,13" and "5,998.13"
                amount_str = amount_match.group(1)
                
                # Determine format and convert to float
                if ',' in amount_str and '.' in amount_str:
                    # Format: "5,998.13" - comma is thousands, dot is decimal
                    amount_str = amount_str.replace(',', '')
                elif ',' in amount_str and '.' not in amount_str:
                    # Format: "5 998,13" - comma is decimal separator
                    amount_str = re.sub(r'[\s\u00a0]+', '', amount_str).replace(',', '.')
                else:
                    # Remove any spaces (thousand separators)
                    amount_str = re.sub(r'[\s\u00a0]+', '', amount_str)
                
                try:
                    data['amount'] = float(amount_str)
                    data['currency'] = 'SEK'
                    print(f"[DEBUG PAYOUT] Parsed SEK amount: '{amount_match.group(1)}' -> {data['amount']}", file=sys.stderr)
                except ValueError:
                    print(f"[DEBUG PAYOUT] Failed to parse SEK amount: '{amount_match.group(1)}'", file=sys.stderr)
                    pass
            
            # Extract dates from payout email body (more authoritative than confirmation emails)
            # Payout emails often contain the actual booking dates
            
            # Look for date patterns like "6 september - 8 september" or "6 SEP - 8 SEP"
            date_range_patterns = [
                r'(\d{1,2})\s+([a-zåäö]+)\s*-\s*(\d{1,2})\s+([a-zåäö]+)',  # "6 september - 8 september"
                r'(\d{1,2})\s+([A-ZÅÄÖa-zåäö]{3})\s*-\s*(\d{1,2})\s+([A-ZÅÄÖa-zåäö]{3})',  # "6 SEP - 8 SEP"
                r'(\d{1,2})\s+([a-zåäö]+)\s*–\s*(\d{1,2})\s+([a-zåäö]+)',  # Em dash variant
            ]
            
            for pattern in date_range_patterns:
                date_match = re.search(pattern, full_text.lower())
                if date_match:
                    start_day, start_month, end_day, end_month = date_match.groups()
                    
                    # Convert month names to numbers
                    start_month_num = None
                    end_month_num = None
                    
                    if start_month.lower() in self.swedish_months:
                        start_month_num = self.swedish_months[start_month.lower()]
                    elif start_month.lower()[:3] in ['jan', 'feb', 'mar', 'apr', 'maj', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec']:
                        month_abbrev_map = {
                            'jan': '01', 'feb': '02', 'mar': '03', 'apr': '04', 
                            'maj': '05', 'jun': '06', 'jul': '07', 'aug': '08',
                            'sep': '09', 'okt': '10', 'nov': '11', 'dec': '12'
                        }
                        start_month_num = month_abbrev_map.get(start_month.lower()[:3])
                    
                    if end_month.lower() in self.swedish_months:
                        end_month_num = self.swedish_months[end_month.lower()]
                    elif end_month.lower()[:3] in ['jan', 'feb', 'mar', 'apr', 'maj', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec']:
                        month_abbrev_map = {
                            'jan': '01', 'feb': '02', 'mar': '03', 'apr': '04', 
                            'maj': '05', 'jun': '06', 'jul': '07', 'aug': '08',
                            'sep': '09', 'okt': '10', 'nov': '11', 'dec': '12'
                        }
                        end_month_num = month_abbrev_map.get(end_month.lower()[:3])
                    
                    if start_month_num and end_month_num:
                        # Use smart year logic (same as confirmation emails)
                        parsed_month = int(start_month_num)
                        parsed_day = int(start_day)
                        year = self.get_reference_year(email_date, parsed_month, parsed_day, scanning_year)
                        
                        data['checkInDate'] = f"{year}-{start_month_num}-{start_day.zfill(2)}"
                        data['checkOutDate'] = f"{year}-{end_month_num}-{end_day.zfill(2)}"
                        
                        print(f"[DEBUG PAYOUT] Extracted date range: {data['checkInDate']} → {data['checkOutDate']}", file=sys.stderr)
                        break
        
        elif email_type == 'cancellation':
            # Extract date range from cancellation
            date_match = re.search(self.patterns['date_range'], subject)
            if date_match:
                start_day, end_day, month_sv = date_match.groups()
                if month_sv in self.swedish_months:
                    data['checkInDate'] = f"2025-{self.swedish_months[month_sv]}-{start_day.zfill(2)}"
                    data['checkOutDate'] = f"2025-{self.swedish_months[month_sv]}-{end_day.zfill(2)}"
        
        elif email_type == 'change_request':
            # Extract guest name from change request subject
            guest_match = re.search(self.patterns['change_request_guest'], subject, re.IGNORECASE)
            if guest_match:
                data['guestName'] = guest_match.group(1).strip()
            
            # Extract original dates
            original_match = re.search(self.patterns['original_dates_pattern'], body, re.IGNORECASE)
            if original_match:
                original_checkin_str = original_match.group(1)
                original_checkout_str = original_match.group(2)
                
                original_checkin = self.parse_swedish_date(original_checkin_str)
                original_checkout = self.parse_swedish_date(original_checkout_str)
                
                if original_checkin and original_checkout:
                    data['originalCheckInDate'] = self.format_date_for_ml(original_checkin)
                    data['originalCheckOutDate'] = self.format_date_for_ml(original_checkout)
            
            # Extract requested dates (these become the new check-in/out dates)
            requested_match = re.search(self.patterns['requested_dates_pattern'], body, re.IGNORECASE)
            if requested_match:
                new_checkin_str = requested_match.group(1)
                new_checkout_str = requested_match.group(2)
                
                new_checkin = self.parse_swedish_date(new_checkin_str)
                new_checkout = self.parse_swedish_date(new_checkout_str)
                
                if new_checkin and new_checkout:
                    data['checkInDate'] = self.format_date_for_ml(new_checkin)
                    data['checkOutDate'] = self.format_date_for_ml(new_checkout)
        
        elif email_type == 'modification':
            # Extract guest name from modification body
            guest_match = re.search(self.patterns['modification_guest'], body, re.IGNORECASE)
            if guest_match:
                guest_name = (guest_match.group(1) or guest_match.group(2)).strip()
                data['guestName'] = guest_name
            
            # Extract booking code from URL
            booking_code_match = re.search(self.patterns['booking_code_url'], body)
            if booking_code_match:
                data['bookingCode'] = booking_code_match.group(1)
        
        return data

    def save_model(self, filename):
        """Save trained model"""
        model_data = {
            'classifier': self.classifier,
            'label_encoder': self.label_encoder,
            'label_decoder': self.label_decoder,
            'patterns': self.patterns,
            'swedish_months': self.swedish_months
        }
        
        with open(filename, 'wb') as f:
            pickle.dump(model_data, f)
        
        print(f"💾 Model saved to {filename}")

    def load_model(self, filename):
        """Load trained model"""
        with open(filename, 'rb') as f:
            model_data = pickle.load(f)
        
        self.classifier = model_data['classifier']
        self.label_encoder = model_data['label_encoder']
        self.label_decoder = model_data['label_decoder']
        self.patterns = model_data['patterns']
        self.swedish_months = model_data['swedish_months']
        
        # Add new English 2020 SEK patterns (not in original trained model)
        self.patterns.update({
            'host_earnings_2020_sek_en': r'(?:Payout|Earnings)\s+([\d\s,.]+)\s*kr\s+SEK.*?(?:nights?|Nights?)\s+([\d\s,.]+)\s*kr\s+SEK',
            'guest_total_2020_sek_en': r'Total\s+([\d\s,.]+)\s*kr\s+SEK',
            'cleaning_fee_2020_sek_en': r'Cleaning fee\s+([\d\s,.]+)\s*kr\s+SEK',
            'service_fee_2020_sek_en': r'Service fee\s+(?:−)?([\d\s,.]+)\s*kr\s+SEK'
        })
        
        # Model loaded silently for production use
        pass

def main():
    print("🤖 AIRBNB EMAIL ML CLASSIFIER")
    print("=" * 50)
    
    classifier = AirbnbEmailClassifier()
    
    # Load training data
    training_file = '../ml-training-data-complete.json'
    if not os.path.exists(training_file):
        print(f"❌ Training data file not found: {training_file}")
        return
    
    X, y, emails = classifier.load_training_data(training_file)
    
    # Train model
    X_test, y_test, y_pred = classifier.train(X, y)
    
    # Save model
    model_file = 'airbnb_email_classifier.pkl'
    classifier.save_model(model_file)
    
    print(f"\n🎉 Training complete! Model accuracy: {np.mean(y_pred == y_test):.3f}")
    
    # Test on some examples
    print(f"\n🧪 TESTING ON EXAMPLES:")
    print("=" * 30)
    
    test_cases = [
        {
            'subject': 'Bokning bekräftad - Anna Andersson anländer 15 juli',
            'sender': 'Airbnb <automated@airbnb.com>',
            'body': 'Din bokning HM123ABC456 är bekräftad.'
        },
        {
            'subject': 'Bokningspåminnelse: Johan anländer snart!',
            'sender': 'Airbnb <automated@airbnb.com>', 
            'body': 'Påminnelse om din gäst Johan som anländer imorgon. HM789XYZ123'
        },
        {
            'subject': 'En utbetalning på 15 234,56 kr skickades',
            'sender': 'Airbnb <express@airbnb.com>',
            'body': 'Utbetalning för bokning HM456DEF789 har skickats.'
        }
    ]
    
    for i, test in enumerate(test_cases):
        email_type, confidence = classifier.classify_email(
            test['subject'], test['sender'], test['body']
        )
        
        extracted_data = classifier.extract_booking_data(
            email_type, test['subject'], test['sender'], test['body']
        )
        
        print(f"\n📧 Test {i+1}:")
        print(f"   Subject: {test['subject'][:50]}...")
        print(f"   Predicted: {email_type} (confidence: {confidence:.3f})")
        print(f"   Booking Code: {extracted_data['bookingCode']}")
        print(f"   Guest Name: {extracted_data['guestName']}")
        print(f"   Amount: {extracted_data['amount']} {extracted_data['currency']}")

if __name__ == '__main__':
    main()