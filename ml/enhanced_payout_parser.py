#!/usr/bin/env python3

"""
Enhanced Payout Parser
Extracts EUR amounts, SEK amounts, and calculates exchange rates from payout emails
"""

import re
import json
from typing import Dict, Optional, Tuple


class EnhancedPayoutParser:
    def __init__(self):
        # Patterns for extracting EUR amounts from email body
        self.eur_patterns = [
            # Pattern: €368,60 + €45,60 = 4 612,87 kr
            r'€\s*(\d+(?:[\s,]\d{3})*(?:[.,]\d{2})?)\s*\+\s*€\s*(\d+(?:[\s,]\d{3})*(?:[.,]\d{2})?)\s*=\s*(\d+(?:[\s,]\d{3})*(?:[.,]\d{2})?)\s*kr',
            
            # Pattern: €2394,73 = 27 528,94 kr  
            r'€\s*(\d+(?:[\s,]\d{3})*(?:[.,]\d{2})?)\s*=\s*(\d+(?:[\s,]\d{3})*(?:[.,]\d{2})?)\s*kr',
            
            # Pattern: €368.60 + €45.60 = 4612.87 kr (dot variations)
            r'€\s*(\d+(?:\.\d{3})*(?:,\d{2})?)\s*\+\s*€\s*(\d+(?:\.\d{3})*(?:,\d{2})?)\s*=\s*(\d+(?:\.\d{3})*(?:,\d{2})?)\s*kr',
            
            # Generic EUR amounts 
            r'€\s*(\d+(?:[\s,]\d{3})*(?:[.,]\d{2})?)',
            r'(\d+(?:[\s,]\d{3})*(?:[.,]\d{2})?)\s*€',
            r'(\d+(?:[\s,]\d{3})*(?:[.,]\d{2})?)\s*EUR'
        ]
        
        # Pattern for SEK from subject
        self.sek_subject_pattern = r'En utbetalning på ([\d\s,]+(?:\.\d{2})?) *kr|A ([\d\s,]+(?:\.\d{2})?) *kr payout was sent'
    
    def normalize_amount(self, amount_str: str) -> float:
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
            if len(cleaned.split(',')[-1]) == 2:
                # Likely decimal: 123,45
                cleaned = cleaned.replace(',', '.')
            # else: thousand separator, keep as is after removing commas
            # Actually, let's be safe and assume decimal if only one comma
            parts = cleaned.split(',')
            if len(parts) == 2 and len(parts[1]) == 2:
                cleaned = parts[0] + '.' + parts[1]
        
        try:
            return float(cleaned)
        except ValueError:
            return 0.0
    
    def extract_sek_from_subject(self, subject: str) -> Optional[float]:
        """Extract SEK amount from email subject"""
        match = re.search(self.sek_subject_pattern, subject, re.IGNORECASE)
        if match:
            sek_str = match.group(1) or match.group(2)
            return self.normalize_amount(sek_str)
        return None
    
    def extract_eur_breakdown(self, body: str) -> Dict[str, float]:
        """Extract EUR amounts and breakdown from email body"""
        results = {
            'hostEarningsEur': 0.0,
            'cleaningFeeEur': 0.0, 
            'totalEur': 0.0,
            'payoutSek': 0.0
        }
        
        # Try calculation patterns first (most reliable)
        for pattern in self.eur_patterns[:3]:  # First 3 are calculation patterns
            match = re.search(pattern, body, re.IGNORECASE)
            if match:
                if len(match.groups()) == 3:
                    if '+' in pattern:
                        # Pattern: €X + €Y = Z kr
                        eur1 = self.normalize_amount(match.group(1))
                        eur2 = self.normalize_amount(match.group(2))
                        sek = self.normalize_amount(match.group(3))
                        
                        results['hostEarningsEur'] = eur1
                        results['cleaningFeeEur'] = eur2
                        results['totalEur'] = eur1 + eur2
                        results['payoutSek'] = sek
                        return results
                    else:
                        # Pattern: €X = Y kr
                        eur = self.normalize_amount(match.group(1))
                        sek = self.normalize_amount(match.group(2))
                        
                        results['hostEarningsEur'] = eur
                        results['totalEur'] = eur
                        results['payoutSek'] = sek
                        return results
        
        # Fallback: look for any EUR amounts
        eur_amounts = []
        for pattern in self.eur_patterns[3:]:  # Generic patterns
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
    
    def parse_payout_email(self, subject: str, body: str) -> Dict[str, any]:
        """Main parsing function"""
        result = {
            'emailType': 'payout',
            'hostEarningsEur': 0.0,
            'cleaningFeeEur': 0.0,
            'totalEur': 0.0,
            'payoutSek': 0.0,
            'exchangeRate': None
        }
        
        # Extract SEK from subject
        sek_amount = self.extract_sek_from_subject(subject)
        if sek_amount:
            result['payoutSek'] = sek_amount
        
        # Extract EUR breakdown from body
        eur_data = self.extract_eur_breakdown(body)
        result.update(eur_data)
        
        # Use SEK from body if found, otherwise use subject
        if eur_data['payoutSek'] > 0:
            result['payoutSek'] = eur_data['payoutSek']
        elif not result['payoutSek'] and sek_amount:
            result['payoutSek'] = sek_amount
        
        # Calculate exchange rate if we have both EUR and SEK
        if result['totalEur'] > 0 and result['payoutSek'] > 0:
            result['exchangeRate'] = round(result['payoutSek'] / result['totalEur'], 4)
        
        return result


def test_enhanced_parser():
    """Test the enhanced parser with known examples"""
    parser = EnhancedPayoutParser()
    
    # Test case 1: HMWAWTBYX9
    subject1 = "En utbetalning på 4 612,87 kr skickades"
    body1 = "Hej! Vi har skickat en utbetalning till dig. €368,60 + €45,60 = 4 612,87 kr. Din utbetalning kommer att synas på ditt konto inom 1-2 arbetsdagar."
    
    result1 = parser.parse_payout_email(subject1, body1)
    print("Test 1 (HMWAWTBYX9):")
    print(f"  Host earnings: €{result1['hostEarningsEur']}")
    print(f"  Cleaning fee: €{result1['cleaningFeeEur']}")
    print(f"  Total EUR: €{result1['totalEur']}")
    print(f"  Payout SEK: {result1['payoutSek']} kr")
    print(f"  Exchange rate: {result1['exchangeRate']} SEK/EUR")
    print(f"  Expected: €414.20 total, actual: €{result1['totalEur']}")
    print()
    
    # Test case 2: Simple format
    subject2 = "En utbetalning på 2 475,08 kr skickades"
    body2 = "Hej! Vi har skickat en utbetalning till dig. €211,94 = 2 475,08 kr. Din utbetalning kommer att synas på ditt konto."
    
    result2 = parser.parse_payout_email(subject2, body2)
    print("Test 2 (HMNF2A5ZJE):")
    print(f"  Total EUR: €{result2['totalEur']}")
    print(f"  Payout SEK: {result2['payoutSek']} kr")
    print(f"  Exchange rate: {result2['exchangeRate']} SEK/EUR")
    print()


if __name__ == '__main__':
    test_enhanced_parser()