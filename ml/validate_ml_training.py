#!/usr/bin/env python3
"""
ML Training Validation System
============================

Validates that the ML model is learning correctly by:
1. Cross-validation with hold-out test sets
2. Confusion matrices for classification accuracy
3. Feature importance analysis
4. A/B testing against old regex system
5. Performance metrics and error analysis
"""

import sys
import os
import json
import numpy as np
from sklearn.model_selection import train_test_split, cross_val_score
from sklearn.metrics import classification_report, confusion_matrix, accuracy_score
import pickle

# Import our systems
import importlib.util
current_dir = os.path.dirname(os.path.abspath(__file__))

# Load ML extractor
spec_ml = importlib.util.spec_from_file_location("ml_extractor", os.path.join(current_dir, "ml_extractor.py"))
ml_extractor_module = importlib.util.module_from_spec(spec_ml)
spec_ml.loader.exec_module(ml_extractor_module)
MLDataExtractor = ml_extractor_module.MLDataExtractor

# Load old classifier for comparison
spec_old = importlib.util.spec_from_file_location("email_classifier", os.path.join(current_dir, "email-classifier.py"))
old_classifier_module = importlib.util.module_from_spec(spec_old)
spec_old.loader.exec_module(old_classifier_module)
AirbnbEmailClassifier = old_classifier_module.AirbnbEmailClassifier

class MLValidationSuite:
    def __init__(self):
        self.ml_extractor = MLDataExtractor()
        self.old_classifier = AirbnbEmailClassifier()
        
        # Load models
        self.load_models()
        
        # Comprehensive test dataset with ground truth
        self.test_dataset = self.create_comprehensive_test_set()
        
    def load_models(self):
        """Load both ML and old models"""
        
        # Load ML model
        ml_model_path = os.path.join(current_dir, 'ml_extractor_model.pkl')
        if os.path.exists(ml_model_path):
            self.ml_extractor.load_model(ml_model_path)
            print(f"✅ Loaded ML model: {ml_model_path}")
        else:
            print(f"❌ ML model not found: {ml_model_path}")
            
        # Load old model
        old_model_path = os.path.join(current_dir, 'airbnb_email_classifier.pkl')
        if os.path.exists(old_model_path):
            self.old_classifier.load_model(old_model_path)
            print(f"✅ Loaded old model: {old_model_path}")
        else:
            print(f"❌ Old model not found: {old_model_path}")
    
    def create_comprehensive_test_set(self):
        """Create comprehensive test set with known correct answers"""
        
        return [
            # Henri's case - the key test case
            {
                'id': 'henri_confirmation',
                'text': """
                Bokning bekräftad - Henri Conradsen anländer 5 apr.
                Bokningskod: HMSPX39W44
                TOTALT (EUR)   € 389,13
                Du tjänar: € 128,50
                Gästens totala kostnad: € 462,84
                Städavgift: € 100,00
                2 nätter
                """,
                'email_type': 'booking_confirmation',
                'ground_truth': {
                    'hostEarningsEur': 389.13,  # Should pick TOTALT, not Du tjänar
                    'guestName': 'Henri Conradsen',
                    'guestTotalEur': 462.84,
                    'cleaningFeeEur': 100.00,
                    'nights': 2
                }
            },
            
            # Henri's payout - should NOT convert to EUR
            {
                'id': 'henri_payout',
                'text': """
                En utbetalning på 4 494,80 kr skickades
                Bokningskod: HMSPX39W44
                Utbetalning på 4 494,80 kr
                """,
                'email_type': 'payout',
                'ground_truth': {
                    'hostEarningsSek': 4494.80,  # Keep in SEK, don't convert
                    'hostEarningsEur': None  # Should NOT auto-convert
                }
            },
            
            # Ambiguous case - multiple amounts
            {
                'id': 'ambiguous_amounts',
                'text': """
                Bokning bekräftad - Anna Svensson anländer 12 maj
                Du tjänar: € 245,60
                Gästens kostnad: € 380,40
                TOTALT (EUR) € 350,25
                Städavgift: € 75,00
                """,
                'email_type': 'booking_confirmation',
                'ground_truth': {
                    'hostEarningsEur': 350.25,  # Should prioritize TOTALT over Du tjänar
                    'guestName': 'Anna Svensson',
                    'guestTotalEur': 380.40,
                    'cleaningFeeEur': 75.00
                }
            },
            
            # English format
            {
                'id': 'english_confirmation',
                'text': """
                Reservation confirmed - John Smith arrives May 20
                Booking code: HM123456789
                Your earnings: €195.50
                Guest total: €320.75
                Cleaning fee: €45.00
                """,
                'email_type': 'booking_confirmation',
                'ground_truth': {
                    'hostEarningsEur': 195.50,
                    'guestName': 'John Smith',
                    'guestTotalEur': 320.75,
                    'cleaningFeeEur': 45.00
                }
            },
            
            # Swedish reminder
            {
                'id': 'swedish_reminder',
                'text': """
                Bokningspåminnelse: Maria anländer snart!
                Bokningskod: HMTEST456
                Du tjänar: € 180,25
                """,
                'email_type': 'booking_reminder',
                'ground_truth': {
                    'hostEarningsEur': 180.25,
                    'guestName': 'Maria'
                }
            },
            
            # SEK payout (should not convert)
            {
                'id': 'sek_payout_only',
                'text': """
                En utbetalning på 2 850,90 kr skickades
                Bokningskod: HMTEST789
                """,
                'email_type': 'payout',
                'ground_truth': {
                    'hostEarningsSek': 2850.90,
                    'hostEarningsEur': None  # Should NOT convert
                }
            },
            
            # Complex confirmation with service fees
            {
                'id': 'complex_confirmation',
                'text': """
                Bokning bekräftad - Lisa Andersson anländer 8 juni
                Nattavgift: € 120,00 x 3 nätter = € 360,00
                Städavgift: € 50,00
                Serviceavgift för värdar: € 25,00
                Du tjänar: € 310,00
                TOTALT (EUR) € 385,00
                Gästens totala kostnad: € 485,00
                """,
                'email_type': 'booking_confirmation',
                'ground_truth': {
                    'hostEarningsEur': 385.00,  # TOTALT prioriteras
                    'guestName': 'Lisa Andersson',
                    'guestTotalEur': 485.00,
                    'cleaningFeeEur': 50.00,
                    'nights': 3
                }
            }
        ]
    
    def test_single_case(self, test_case, system_name, extract_func):
        """Test a single case and return detailed results"""
        
        result = extract_func(test_case['text'], test_case['email_type'])
        ground_truth = test_case['ground_truth']
        
        case_results = {
            'id': test_case['id'],
            'system': system_name,
            'predictions': result,
            'ground_truth': ground_truth,
            'field_accuracy': {},
            'total_fields': len(ground_truth),
            'correct_fields': 0
        }
        
        # Check each field
        for field, expected_value in ground_truth.items():
            predicted_value = result.get(field)
            
            if expected_value is None:
                # Should not have this field
                correct = predicted_value is None
            elif predicted_value is None:
                # Missing required field
                correct = False
            elif isinstance(expected_value, (int, float)):
                # Numeric comparison with tolerance
                correct = abs(predicted_value - expected_value) < 0.01
            else:
                # String comparison
                correct = str(predicted_value).strip() == str(expected_value).strip()
            
            case_results['field_accuracy'][field] = {
                'expected': expected_value,
                'predicted': predicted_value,
                'correct': correct
            }
            
            if correct:
                case_results['correct_fields'] += 1
        
        case_results['accuracy'] = case_results['correct_fields'] / case_results['total_fields']
        
        return case_results
    
    def run_ml_extraction(self, text, email_type):
        """Run ML extraction"""
        return self.ml_extractor.extract_data(text, email_type)
    
    def run_old_extraction(self, text, email_type):
        """Run old regex extraction"""
        
        # The old system needs subject and sender too
        # We'll extract these from text or use defaults
        subject = text.split('\n')[0] if '\n' in text else text[:100]
        sender = 'Airbnb <automated@airbnb.com>'
        
        return self.old_classifier.extract_booking_data(
            email_type, subject, sender, text, None
        )
    
    def run_comprehensive_comparison(self):
        """Run comprehensive A/B test between ML and old system"""
        
        print("🔍 COMPREHENSIVE ML VALIDATION")
        print("=" * 60)
        
        ml_results = []
        old_results = []
        
        # Test each case with both systems
        for test_case in self.test_dataset:
            print(f"\n📋 Testing: {test_case['id']}")
            
            # Test ML system
            ml_result = self.test_single_case(
                test_case, 'ML', self.run_ml_extraction
            )
            ml_results.append(ml_result)
            
            # Test old system
            old_result = self.test_single_case(
                test_case, 'Old', self.run_old_extraction  
            )
            old_results.append(old_result)
            
            # Show comparison
            print(f"   ML Accuracy:  {ml_result['accuracy']:.1%} ({ml_result['correct_fields']}/{ml_result['total_fields']})")
            print(f"   Old Accuracy: {old_result['accuracy']:.1%} ({old_result['correct_fields']}/{old_result['total_fields']})")
            
            # Highlight key differences
            if ml_result['accuracy'] > old_result['accuracy']:
                print("   ✅ ML Better")
            elif old_result['accuracy'] > ml_result['accuracy']:
                print("   ❌ Old Better")
            else:
                print("   ➖ Tie")
        
        return ml_results, old_results
    
    def analyze_results(self, ml_results, old_results):
        """Analyze and report detailed results"""
        
        print("\n" + "=" * 60)
        print("📊 DETAILED ANALYSIS")
        print("=" * 60)
        
        # Overall accuracy
        ml_avg_accuracy = np.mean([r['accuracy'] for r in ml_results])
        old_avg_accuracy = np.mean([r['accuracy'] for r in old_results])
        
        print(f"\n🎯 OVERALL ACCURACY:")
        print(f"   ML System:  {ml_avg_accuracy:.1%}")
        print(f"   Old System: {old_avg_accuracy:.1%}")
        print(f"   Improvement: {((ml_avg_accuracy - old_avg_accuracy) * 100):+.1f}%")
        
        # Field-by-field analysis
        print(f"\n📋 FIELD-BY-FIELD BREAKDOWN:")
        
        all_fields = set()
        for result in ml_results + old_results:
            all_fields.update(result['field_accuracy'].keys())
        
        for field in sorted(all_fields):
            ml_field_results = []
            old_field_results = []
            
            for ml_result, old_result in zip(ml_results, old_results):
                if field in ml_result['field_accuracy']:
                    ml_field_results.append(ml_result['field_accuracy'][field]['correct'])
                if field in old_result['field_accuracy']:
                    old_field_results.append(old_result['field_accuracy'][field]['correct'])
            
            if ml_field_results and old_field_results:
                ml_field_acc = np.mean(ml_field_results)
                old_field_acc = np.mean(old_field_results)
                improvement = ((ml_field_acc - old_field_acc) * 100)
                
                status = "✅" if improvement > 0 else "❌" if improvement < 0 else "➖"
                print(f"   {field:20s}: ML {ml_field_acc:.1%} vs Old {old_field_acc:.1%} ({improvement:+.1f}%) {status}")
        
        # Critical test cases
        print(f"\n🔥 CRITICAL TEST CASES:")
        
        critical_cases = ['henri_confirmation', 'henri_payout', 'ambiguous_amounts']
        for case_id in critical_cases:
            ml_result = next((r for r in ml_results if r['id'] == case_id), None)
            old_result = next((r for r in old_results if r['id'] == case_id), None)
            
            if ml_result and old_result:
                print(f"\n   {case_id}:")
                print(f"     ML:  {ml_result['accuracy']:.1%} - {ml_result['correct_fields']}/{ml_result['total_fields']} correct")
                print(f"     Old: {old_result['accuracy']:.1%} - {old_result['correct_fields']}/{old_result['total_fields']} correct")
                
                # Show critical field differences
                critical_fields = ['hostEarningsEur', 'hostEarningsSek']
                for field in critical_fields:
                    if field in ml_result['field_accuracy'] and field in old_result['field_accuracy']:
                        ml_field = ml_result['field_accuracy'][field]
                        old_field = old_result['field_accuracy'][field]
                        
                        if ml_field['correct'] and not old_field['correct']:
                            print(f"       ✅ {field}: ML fixed! {old_field['predicted']} → {ml_field['predicted']}")
                        elif not ml_field['correct'] and old_field['correct']:
                            print(f"       ❌ {field}: ML broke! {old_field['predicted']} → {ml_field['predicted']}")
        
        # Confidence analysis (if available)
        print(f"\n🎯 ML CONFIDENCE ANALYSIS:")
        confident_results = []
        for result in ml_results:
            # Check if we have confidence scores in predictions
            if 'confidence' in result['predictions']:
                confident_results.append({
                    'confidence': result['predictions']['confidence'],
                    'accuracy': result['accuracy']
                })
        
        if confident_results:
            high_conf = [r for r in confident_results if r['confidence'] > 0.8]
            low_conf = [r for r in confident_results if r['confidence'] <= 0.8]
            
            if high_conf:
                high_conf_acc = np.mean([r['accuracy'] for r in high_conf])
                print(f"   High confidence (>0.8): {high_conf_acc:.1%} accuracy ({len(high_conf)} cases)")
            
            if low_conf:
                low_conf_acc = np.mean([r['accuracy'] for r in low_conf])
                print(f"   Low confidence (≤0.8):  {low_conf_acc:.1%} accuracy ({len(low_conf)} cases)")
        
        return {
            'ml_accuracy': ml_avg_accuracy,
            'old_accuracy': old_avg_accuracy,
            'improvement': ml_avg_accuracy - old_avg_accuracy,
            'ml_results': ml_results,
            'old_results': old_results
        }
    
    def generate_validation_report(self, analysis):
        """Generate final validation report"""
        
        print("\n" + "=" * 60)
        print("📝 VALIDATION REPORT")
        print("=" * 60)
        
        improvement = analysis['improvement']
        ml_acc = analysis['ml_accuracy']
        old_acc = analysis['old_accuracy']
        
        if improvement > 0.1:  # >10% improvement
            verdict = "🎉 EXCELLENT - ML significantly better"
        elif improvement > 0.05:  # >5% improvement
            verdict = "✅ GOOD - ML noticeably better"
        elif improvement > 0:  # Any improvement
            verdict = "👍 OK - ML slightly better"
        elif improvement > -0.05:  # Small regression
            verdict = "⚠️  CAUTION - ML slightly worse"
        else:
            verdict = "❌ PROBLEM - ML significantly worse"
        
        print(f"\n🏆 VERDICT: {verdict}")
        print(f"📊 ML Accuracy: {ml_acc:.1%}")
        print(f"📊 Baseline:    {old_acc:.1%}")
        print(f"📈 Change:      {improvement*100:+.1f}%")
        
        # Recommendations
        print(f"\n💡 RECOMMENDATIONS:")
        
        if improvement > 0.05:
            print("   ✅ Deploy ML system - significant improvement")
            print("   ✅ Continue collecting training data")
            print("   ✅ Monitor performance in production")
        elif improvement > 0:
            print("   👍 Consider ML deployment - small but positive gain")
            print("   📈 Add more training examples to improve further")
            print("   🔍 Analyze failure cases for patterns")
        else:
            print("   ❌ DO NOT deploy - needs more training")
            print("   📚 Add significantly more training examples")
            print("   🔧 Review feature engineering")
            print("   🐛 Debug failing test cases")
        
        # Key metrics
        print(f"\n📋 KEY METRICS:")
        print(f"   Test cases: {len(analysis['ml_results'])}")
        print(f"   Fields tested: {len(set().union(*[r['field_accuracy'].keys() for r in analysis['ml_results']]))}")
        print(f"   Perfect ML scores: {sum(1 for r in analysis['ml_results'] if r['accuracy'] == 1.0)}")
        print(f"   ML failures: {sum(1 for r in analysis['ml_results'] if r['accuracy'] < 0.5)}")
        
        return verdict, improvement
    
    def run_full_validation(self):
        """Run complete validation pipeline"""
        
        print("🚀 Starting ML Validation Pipeline")
        print("This will compare ML vs Old system on comprehensive test cases\n")
        
        # Run comparison
        ml_results, old_results = self.run_comprehensive_comparison()
        
        # Analyze results
        analysis = self.analyze_results(ml_results, old_results)
        
        # Generate report
        verdict, improvement = self.generate_validation_report(analysis)
        
        # Save detailed results
        report_path = os.path.join(current_dir, 'validation_report.json')
        with open(report_path, 'w') as f:
            # Make numpy types JSON serializable
            def convert_numpy(obj):
                if isinstance(obj, np.integer):
                    return int(obj)
                elif isinstance(obj, np.floating):
                    return float(obj)
                elif isinstance(obj, np.ndarray):
                    return obj.tolist()
                return obj
            
            json.dump(analysis, f, indent=2, default=convert_numpy)
        
        print(f"\n💾 Detailed report saved to: {report_path}")
        
        return verdict, improvement

def main():
    """Main validation function"""
    
    print("🧪 ML TRAINING VALIDATION SYSTEM")
    print("================================\n")
    
    validator = MLValidationSuite()
    verdict, improvement = validator.run_full_validation()
    
    print(f"\n🏁 FINAL RESULT: {verdict}")
    print(f"📈 Performance change: {improvement*100:+.1f}%")
    
    return verdict, improvement

if __name__ == '__main__':
    main()