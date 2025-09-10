#!/usr/bin/env python3
"""
ML-Based Data Extractor for Airbnb Emails
=========================================

Uses machine learning to automatically discover and extract data patterns
from emails, replacing hardcoded regex patterns with learned features.

Approach:
1. NER (Named Entity Recognition) for finding amounts, dates, names
2. Context-aware field mapping using surrounding text features  
3. Continuous learning from new examples
4. Pattern generalization across email formats
"""

import re
import json
import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.ensemble import RandomForestClassifier
from sklearn.model_selection import train_test_split
from datetime import datetime
import pickle
import sys
import os

class MLDataExtractor:
    def __init__(self):
        self.amount_classifier = None
        self.date_classifier = None
        self.name_classifier = None
        self.context_vectorizer = TfidfVectorizer(
            ngram_range=(1, 3), 
            max_features=1000,
            strip_accents='unicode'
        )
        
        # Training data storage
        self.training_examples = []
        
    def extract_candidate_entities(self, text):
        """Extract all potential entities (amounts, dates, names) from text"""
        
        # Find all potential amounts (EUR and SEK)
        amount_patterns = [
            r'€\s*([\d\s,]+(?:\.\d{2})?)',  # EUR: € 389,13 or € 1 234.56
            r'([\d\s,]+(?:\.\d{2})?)\s*kr', # SEK with decimal: 1,350.96 kr
            r'([\d\s,]+(?:,\d{2})?)\s*kr', # SEK Swedish format: 1,350,96 kr (only if no decimal already matched)
        ]
        
        amounts = []
        matched_positions = set()  # Track already matched positions to avoid overlaps
        
        for pattern in amount_patterns:
            for match in re.finditer(pattern, text, re.IGNORECASE):
                start, end = match.span()
                
                # Skip if this position is already covered by a previous match
                if any(s <= start < e or s < end <= e for s, e in matched_positions):
                    continue
                
                amount_str = match.group(1) if match.groups() else match.group(0)
                
                # Get context around the amount (50 chars before/after)
                context_start = max(0, start - 50)
                context_end = min(len(text), end + 50)
                context = text[context_start:context_end]
                
                amounts.append({
                    'value': amount_str,
                    'start': start,
                    'end': end,
                    'context': context,
                    'full_match': match.group(0)
                })
                
                matched_positions.add((start, end))
        
        # Find all potential dates
        date_patterns = [
            r'\d{1,2}\s+(?:jan|feb|mar|apr|maj|jun|jul|aug|sep|okt|nov|dec)\w*\.?\s*\d{4}',
            r'\d{4}-\d{2}-\d{2}',
            r'\d{1,2}/\d{1,2}/\d{4}',
        ]
        
        dates = []
        for pattern in date_patterns:
            for match in re.finditer(pattern, text, re.IGNORECASE):
                start, end = match.span()
                context_start = max(0, start - 30)
                context_end = min(len(text), end + 30)
                context = text[context_start:context_end]
                
                dates.append({
                    'value': match.group(0),
                    'start': start,
                    'end': end,
                    'context': context
                })
        
        # Find potential guest names (capitalized words near booking keywords)
        # Improved patterns that avoid capturing currency symbols and extra whitespace
        name_patterns = [
            # Pattern 1: Only allow single spaces between words, no newlines or currency
            r'([A-ZÅÄÖ][a-zåäöA-ZÅÄÖ]+(?:\s[A-ZÅÄÖ][a-zåäöA-ZÅÄÖ]+)*)\s+(?:anländer|arrives)',
            # Pattern 2: Pattern with word boundary to avoid currency capture
            r'(?:^|(?<=[.!?\n]))\s*([A-ZÅÄÖ][a-zåäö]+(?:\s+[A-ZÅÄÖ][a-zåäö]+)*)\s+anländer',
            # Pattern 3: Pattern that ensures we don't capture from after numbers/currency
            r'(?<![\d,.])\s+([A-ZÅÄÖ][a-zåäö]+(?:\s+[A-ZÅÄÖ][a-zåäö]+)*)\s+anländer',
        ]
        
        names = []
        for pattern in name_patterns:
            for match in re.finditer(pattern, text, re.IGNORECASE):
                name = match.group(1).strip()
                
                # Clean the name to remove currency symbols and normalize whitespace
                cleaned_name = self.clean_guest_name(name)
                
                if cleaned_name and 2 < len(cleaned_name) < 50:  # Reasonable name length
                    start, end = match.span(1)
                    context_start = max(0, start - 30)
                    context_end = min(len(text), end + 30)
                    context = text[context_start:context_end]
                    
                    names.append({
                        'value': cleaned_name,
                        'start': start,
                        'end': end,
                        'context': context
                    })
        
        return {
            'amounts': amounts,
            'dates': dates,
            'names': names
        }
    
    def clean_guest_name(self, name):
        """Clean up captured guest name - remove currency symbols, numbers, and extra whitespace, format to title case"""
        if not name or not name.strip():
            return None
        
        # Remove currency symbols and numbers from start and end
        cleaned = re.sub(r'^[kr\s\d.,€$]+', '', name)
        cleaned = re.sub(r'[kr\s\d.,€$]+$', '', cleaned)
        
        # Normalize whitespace - replace multiple spaces/newlines with single space
        cleaned = re.sub(r'\s+', ' ', cleaned.strip())
        
        # Convert to proper title case (handles Swedish characters åäö correctly)
        if cleaned:
            # Split by spaces and handle hyphenated names
            words = cleaned.split()
            title_cased_words = []
            
            for word in words:
                if word:  # Skip empty words
                    # Handle hyphenated names by splitting on hyphens
                    if '-' in word:
                        hyphen_parts = word.split('-')
                        title_hyphen_parts = []
                        for part in hyphen_parts:
                            if part:
                                title_part = part[0].upper() + part[1:].lower() if len(part) > 1 else part.upper()
                                title_hyphen_parts.append(title_part)
                        title_word = '-'.join(title_hyphen_parts)
                    else:
                        # Convert to title case: first letter upper, rest lower
                        title_word = word[0].upper() + word[1:].lower() if len(word) > 1 else word.upper()
                    
                    title_cased_words.append(title_word)
            
            cleaned = ' '.join(title_cased_words)
        
        # Ensure it's a reasonable name (at least 2 characters, starts with letter)
        if len(cleaned) >= 2 and cleaned[0].isalpha():
            return cleaned
        
        return None
    
    def extract_context_features(self, entity, text, email_type):
        """Extract features from context around an entity"""
        context = entity['context'].lower()
        
        features = {
            # Position features
            'position_ratio': entity['start'] / len(text),  # Where in email (0.0 = start, 1.0 = end)
            
            # Context keyword features  
            'has_totalt': 'totalt' in context,
            'has_du_tjanar': 'du tjänar' in context or 'tjänar' in context,
            'has_earnings': 'earnings' in context,
            'has_payout': 'utbetalning' in context or 'payout' in context,
            'has_guest_total': 'gästens' in context or 'guest total' in context,
            'has_cleaning': 'städ' in context or 'cleaning' in context,
            'has_service': 'service' in context or 'avgift' in context,
            'has_nightly': 'natt' in context or 'nightly' in context,
            'has_eur_currency': 'eur' in context or '€' in context,
            'has_sek_currency': 'kr' in context or 'sek' in context,
            
            # Email type
            'is_confirmation': email_type == 'booking_confirmation',
            'is_payout': email_type == 'payout',
            'is_reminder': email_type == 'booking_reminder',
            
            # Surrounding text patterns
            'near_total': 'totalt' in context or 'total' in context,
            'near_host': 'värd' in context or 'host' in context,
            'near_guest': 'gäst' in context or 'guest' in context,
        }
        
        return features
    
    def add_training_example(self, email_text, email_type, labeled_data):
        """Add a training example with human-labeled correct extractions"""
        
        # Extract all candidate entities
        candidates = self.extract_candidate_entities(email_text)
        
        # Create training examples for each field
        example = {
            'email_text': email_text,
            'email_type': email_type,
            'candidates': candidates,
            'labels': labeled_data  # e.g. {'hostEarningsEur': 389.13, 'guestName': 'Henri'}
        }
        
        self.training_examples.append(example)
        print(f"[TRAINING] Added example: {email_type}, labels: {list(labeled_data.keys())}", file=sys.stderr)
    
    def train_classifiers(self):
        """Train ML models to classify which entities belong to which fields"""
        
        if len(self.training_examples) < 2:
            print("[WARNING] Need more training examples to train classifiers")
            return
        
        # Prepare training data for amount classification
        amount_features = []
        amount_labels = []
        
        for example in self.training_examples:
            email_text = example['email_text']
            email_type = example['email_type']
            labels = example['labels']
            
            # For each amount candidate, determine what field it represents
            for amount in example['candidates']['amounts']:
                features = self.extract_context_features(amount, email_text, email_type)
                feature_vector = list(features.values())
                amount_features.append(feature_vector)
                
                # Determine label based on actual value
                amount_value = self.parse_amount(amount['value'])
                
                if 'hostEarningsEur' in labels and abs(amount_value - labels['hostEarningsEur']) < 1:
                    amount_labels.append('hostEarningsEur')
                elif 'hostEarningsSek' in labels and abs(amount_value - labels['hostEarningsSek']) < 1:
                    amount_labels.append('hostEarningsSek')
                elif 'guestTotalEur' in labels and abs(amount_value - labels['guestTotalEur']) < 1:
                    amount_labels.append('guestTotalEur')
                elif 'cleaningFeeEur' in labels and abs(amount_value - labels['cleaningFeeEur']) < 1:
                    amount_labels.append('cleaningFeeEur')
                else:
                    amount_labels.append('other')  # Not a target field
        
        if len(amount_features) > 1:
            self.amount_classifier = RandomForestClassifier(n_estimators=50, random_state=42)
            self.amount_classifier.fit(amount_features, amount_labels)
            print(f"[TRAINING] Trained amount classifier with {len(amount_features)} examples", file=sys.stderr)
        
        # Could add similar training for dates and names
        # For now, focus on amounts as that's the main challenge
        
    def parse_amount(self, amount_str):
        """Parse amount string to float, handling Swedish/English formats"""
        try:
            # Remove spaces and handle comma vs dot
            clean = re.sub(r'[\s\u00a0]+', '', str(amount_str))
            
            if ',' in clean and '.' in clean:
                # US format: 1,234.56
                clean = clean.replace(',', '')
            elif ',' in clean:
                # Swedish format: 1234,56
                clean = clean.replace(',', '.')
            
            return float(clean)
        except:
            return 0.0
    
    def extract_data(self, email_text, email_type):
        """Use trained ML models to extract data from email"""
        
        if not self.amount_classifier:
            # Fallback to basic extraction if no training
            return self.basic_extraction(email_text, email_type)
        
        # Extract candidate entities
        candidates = self.extract_candidate_entities(email_text)
        
        results = {}
        
        # Classify each amount using ML
        for amount in candidates['amounts']:
            features = self.extract_context_features(amount, email_text, email_type)
            feature_vector = [list(features.values())]
            
            predicted_field = self.amount_classifier.predict(feature_vector)[0]
            confidence = max(self.amount_classifier.predict_proba(feature_vector)[0])
            
            if confidence > 0.5 and predicted_field != 'other':
                amount_value = self.parse_amount(amount['value'])
                if amount_value > 0:
                    results[predicted_field] = amount_value
                    print(f"[ML EXTRACT] {predicted_field}: {amount_value} (confidence: {confidence:.2f})", file=sys.stderr)
        
        # Extract guest names (simple for now)
        for name in candidates['names']:
            if not results.get('guestName'):
                results['guestName'] = name['value']
                print(f"[ML EXTRACT] guestName: {name['value']}", file=sys.stderr)
        
        return results
    
    def basic_extraction(self, email_text, email_type):
        """Fallback extraction when no ML model is trained"""
        
        candidates = self.extract_candidate_entities(email_text)
        results = {}
        
        # Priority-based heuristics for fallback
        # Higher priority patterns override lower ones
        priorities = []
        
        for amount in candidates['amounts']:
            context = amount['context'].lower()
            full_match = amount['full_match'].lower()
            amount_value = self.parse_amount(amount['value'])
            
            if amount_value <= 0:
                continue
                
            # Check the actual currency symbol in the matched amount, not just context
            has_eur_symbol = '€' in full_match
            has_sek_symbol = 'kr' in full_match
                
            # Priority-based classification (higher number = higher priority)
            if 'totalt (eur)' in context or ('totalt' in context and 'eur' in context):
                priorities.append(('hostEarningsEur', amount_value, 100, 'TOTALT EUR pattern'))
            elif ('gäst' in context or 'totalt' in context) and has_eur_symbol:
                priorities.append(('guestTotalEur', amount_value, 90, 'Guest total EUR pattern'))
            elif ('du tjänar' in context or 'tjänar' in context) and has_eur_symbol:
                priorities.append(('hostEarningsEur', amount_value, 80, 'Du tjänar EUR pattern'))
            elif ('du tjänar' in context or 'tjänar' in context) and has_sek_symbol:
                priorities.append(('hostEarningsSek', amount_value, 85, 'Du tjänar SEK pattern'))
            elif 'utbetalning' in context and has_sek_symbol:
                # Special handling for "kr SEK x N Nätter" pattern - prioritize total amount over per-night rate
                if re.search(r'kr\s+sek\s+x\s*\d+\s*nätter', context, re.IGNORECASE):
                    # Check if this amount comes AFTER "kr SEK x N Nätter" in the context
                    natter_match = re.search(r'kr\s+sek\s+x\s*\d+\s*nätter.*?' + re.escape(amount['value']), context, re.IGNORECASE)
                    if natter_match:
                        # This is the total amount AFTER "kr SEK x N Nätter" - give it higher priority
                        priorities.append(('hostEarningsSek', amount_value, 95, 'Utbetalning total after kr SEK x nätter'))
                    else:
                        # This is the per-night rate BEFORE "kr SEK x N Nätter" - give it lower priority
                        priorities.append(('hostEarningsSek', amount_value, 75, 'Utbetalning per-night rate before kr SEK x nätter'))
                else:
                    priorities.append(('hostEarningsSek', amount_value, 90, 'Utbetalning SEK pattern'))
            elif 'städ' in context and has_eur_symbol:
                priorities.append(('cleaningFeeEur', amount_value, 60, 'Cleaning fee EUR pattern'))
        
        # Sort by priority and take highest for each field
        priorities.sort(key=lambda x: x[2], reverse=True)
        
        seen_fields = set()
        for field, value, priority, pattern in priorities:
            if field not in seen_fields:
                results[field] = value
                seen_fields.add(field)
                print(f"[FALLBACK] {field}: {value} ({pattern}, priority: {priority})", file=sys.stderr)
        
        # Extract names
        for name in candidates['names']:
            if not results.get('guestName'):
                results['guestName'] = name['value']
        
        return results
    
    def save_model(self, filepath):
        """Save trained model and training data"""
        model_data = {
            'amount_classifier': self.amount_classifier,
            'context_vectorizer': self.context_vectorizer,
            'training_examples': self.training_examples
        }
        
        with open(filepath, 'wb') as f:
            pickle.dump(model_data, f)
        print(f"[SAVE] Model saved to {filepath}")
    
    def load_model(self, filepath):
        """Load trained model"""
        if os.path.exists(filepath):
            with open(filepath, 'rb') as f:
                model_data = pickle.load(f)
                
            self.amount_classifier = model_data.get('amount_classifier')
            self.context_vectorizer = model_data.get('context_vectorizer')
            self.training_examples = model_data.get('training_examples', [])
            print(f"[LOAD] Model loaded from {filepath}, {len(self.training_examples)} training examples", file=sys.stderr)
        else:
            print(f"[LOAD] No model found at {filepath}, using fallback extraction", file=sys.stderr)

if __name__ == '__main__':
    # Test with Henri's example
    extractor = MLDataExtractor()
    
    test_email = """
    SOME TEXT BEFORE
    TOTALT (EUR)   € 389,13
    MORE TEXT
    Du tjänar: € 128,50
    Bokning bekräftad - Henri Conradsen anländer 5 apr.
    """
    
    # Add as training example
    extractor.add_training_example(
        test_email, 
        'booking_confirmation',
        {'hostEarningsEur': 389.13, 'guestName': 'Henri Conradsen'}
    )
    
    # Train with this example
    extractor.train_classifiers()
    
    # Test extraction
    results = extractor.extract_data(test_email, 'booking_confirmation')
    print(f"\nExtraction results: {results}")