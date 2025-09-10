#!/usr/bin/env python3

"""
Integration script to add enhanced payout parsing to the main email classifier
"""

import sys
import os
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from enhanced_payout_parser import EnhancedPayoutParser
import json

def integrate_payout_parsing():
    """
    Add the enhanced payout parsing functionality to classify_email.py
    """
    
    # Read the existing classifier
    classifier_path = 'ml/classify_email.py'
    
    if not os.path.exists(classifier_path):
        print("❌ classify_email.py not found")
        return
    
    with open(classifier_path, 'r') as f:
        content = f.read()
    
    # Check if already integrated
    if 'EnhancedPayoutParser' in content:
        print("✅ Enhanced payout parser already integrated")
        return
    
    # Add import for enhanced parser
    import_line = "from enhanced_payout_parser import EnhancedPayoutParser"
    
    # Find where to add the import (after other imports)
    lines = content.split('\n')
    insert_idx = 0
    for i, line in enumerate(lines):
        if line.startswith('import ') or line.startswith('from '):
            insert_idx = i + 1
    
    lines.insert(insert_idx, import_line)
    
    # Find the main parsing function and enhance it for payout emails
    enhanced_content = '\n'.join(lines)
    
    # Look for the main classification function and add payout enhancement
    payout_enhancement = '''
    # Enhanced payout parsing
    if email_type == "payout":
        payout_parser = EnhancedPayoutParser()
        enhanced_data = payout_parser.parse_payout_email(subject, body)
        
        # Merge enhanced data with existing result
        for key, value in enhanced_data.items():
            if key != 'emailType' and value is not None:
                result[key] = value
        
        # Override with precise EUR amounts if found
        if enhanced_data.get('totalEur', 0) > 0:
            result['hostEarningsEur'] = enhanced_data['totalEur']
        if enhanced_data.get('hostEarningsEur', 0) > 0 and enhanced_data.get('cleaningFeeEur', 0) > 0:
            result['hostEarningsEur'] = enhanced_data['hostEarningsEur'] 
            result['cleaningFeeEur'] = enhanced_data['cleaningFeeEur']
        
        print(f"📈 Enhanced payout parsing: €{enhanced_data.get('totalEur', 0)} from email body")
'''
    
    # Find where to insert the enhancement (before the return statement)
    if 'return result' in enhanced_content:
        enhanced_content = enhanced_content.replace('    return result', f'    {payout_enhancement}\n    return result')
    
    # Write the enhanced version
    backup_path = classifier_path + '.backup'
    os.rename(classifier_path, backup_path)
    
    with open(classifier_path, 'w') as f:
        f.write(enhanced_content)
    
    print(f"✅ Enhanced classify_email.py")
    print(f"📁 Backup saved as {backup_path}")
    print(f"🎯 Enhanced payout parsing now active")

if __name__ == '__main__':
    integrate_payout_parsing()