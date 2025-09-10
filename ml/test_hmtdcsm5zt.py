#!/usr/bin/env python3
"""
Test the problematic HMTDCSM5ZT booking content to verify phone number fix
"""
import json
import sys
import os

# Import the classifier
import importlib.util
spec = importlib.util.spec_from_file_location("email_classifier", "email-classifier.py")
email_classifier_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(email_classifier_module)
AirbnbEmailClassifier = email_classifier_module.AirbnbEmailClassifier

def test_hmtdcsm5zt():
    # Load the problematic content
    content = """Bokningskod: HMTDCSM5ZT
Datum: den 3 dec. , den 4 dec. , den 3 dec. , den 4 dec. 
Belopp: 
                3 976,48 kr, 
                3 976,48 kr

Din bokning är bekräftad Du ska till Tyresö Strand! Stockholm Bed & breakfast Eget rum hos värden Hilding fredag, 4 december 2020 - söndag, 6 december 2020 Visa fullständig resplan Adress Tjärnstigen 80B, 135 62 Tyresö, Sweden Få vägbeskrivning Gäster 2 Bjud in gäster Betalningar Bokningskod HMTDCSM5ZT Avbokningspolicy Avboka före 3:00 PM den 3 dec. och få en full återbetalning. Därefter, avboka före 3:00 PM den 4 dec. och få en fullständig återbetalning, minus den första natten och serviceavgiften. Mer information Ändra bokning Hilding är din värd Kontakta Hilding för att koordinera ankomsttid och nyckelöverlämning. Skicka meddelande till värd +46 76 836 73 59 Vet vad du kan förvänta dig"""
    
    classifier = AirbnbEmailClassifier()
    model_file = 'airbnb_email_classifier.pkl'
    
    if not os.path.exists(model_file):
        print("❌ Model file not found!")
        return False
    
    classifier.load_model(model_file)
    
    try:
        # Test classification
        email_type, confidence = classifier.classify_email("Bokning bekräftad för Tyresö Strand", "Airbnb <automated@airbnb.com>", content)
        print(f"✅ Classification successful: {email_type} (confidence: {confidence:.3f})")
        
        # Test extraction
        extracted_data = classifier.extract_booking_data(email_type, "Bokning bekräftad för Tyresö Strand", "Airbnb <automated@airbnb.com>", content, "2020-12-04")
        print(f"✅ Data extraction successful: {json.dumps(extracted_data, indent=2)}")
        
        return True
        
    except Exception as e:
        print(f"❌ Error: {e}")
        return False

if __name__ == '__main__':
    success = test_hmtdcsm5zt()
    sys.exit(0 if success else 1)