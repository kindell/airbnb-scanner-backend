#!/usr/bin/env python3
"""
Search for a specific booking code in Gmail to see the actual email subjects
"""

import json
import sys
import os
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

def search_gmail_for_booking(booking_code="HM3RY99SBR"):
    """Search for emails containing a specific booking code"""
    
    # Gmail API credentials (you'll need to get these from the main app)
    print(f"🔍 Searching Gmail for booking code: {booking_code}")
    
    # For now, let's create a curl command to search via the main app's API
    print("\n💡 To search Gmail via the main app:")
    print(f"curl -X GET 'https://gmail.googleapis.com/gmail/v1/users/me/messages?q={booking_code}' \\")
    print("  -H 'Authorization: Bearer [ACCESS_TOKEN]'")
    
    print(f"\n📋 Or search Gmail directly for: '{booking_code}'")
    print("Look for emails from:")
    print("- automated@airbnb.com") 
    print("- noreply@airbnb.com")
    print("- express@airbnb.com")
    
    return None

if __name__ == "__main__":
    booking_code = sys.argv[1] if len(sys.argv) > 1 else "HM3RY99SBR"
    search_gmail_for_booking(booking_code)