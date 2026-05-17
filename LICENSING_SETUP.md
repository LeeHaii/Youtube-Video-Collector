# Licensing System Setup Guide

This guide explains how to set up the Google Apps Script backend for license verification in your Electron app.

## Architecture Overview

- **Frontend (Renderer)**: Activation window where users enter license keys (cannot be tampered with - it's in the Renderer which can be debugged)
- **Backend (Main Process)**: License verification, hardware ID generation, and secure key storage (protected from user tampering)
- **Google Apps Script**: Your Google Sheets-based authorization server

## Step 1: Create a Google Apps Script Web App

### 1.1 Go to Google Apps Script

1. Visit [script.google.com](https://script.google.com)
2. Create a new project
3. Name it something like "YouTube Tool License Server"

### 1.2 Write the License Verification Script

Replace the default `Code.gs` with this script:

```javascript
// License verification function
function doPost(e) {
  try {
    // Parse request
    const data = JSON.parse(e.postData.contents);
    const { key, deviceId } = data;

    if (!key || !deviceId) {
      return ContentService.createTextOutput(
        JSON.stringify({
          success: false,
          message: 'Missing key or device ID'
        })
      ).setMimeType(ContentService.MimeType.JSON);
    }

    // Get the license sheet
    const sheet = SpreadsheetApp.openById('YOUR_SPREADSHEET_ID').getSheetByName('Licenses');
    
    if (!sheet) {
      return ContentService.createTextOutput(
        JSON.stringify({
          success: false,
          message: 'Server configuration error'
        })
      ).setMimeType(ContentService.MimeType.JSON);
    }

    // Get all data
    const data_range = sheet.getDataRange();
    const values = data_range.getValues();
    
    // Find matching license (assumes columns: License Key, Device ID, Status, Expiry Date)
    // Example: ["ABC123DEF456", "device-hash-here", "active", "2026-12-31"]
    let found = false;
    let licenseStatus = null;

    for (let i = 1; i < values.length; i++) { // Start from row 2 (skip header)
      const licenseKey = values[i][0];
      const allowedDeviceId = values[i][1];
      const status = values[i][2];
      const expiryDate = values[i][3];

      // Check if license key matches
      if (licenseKey === key) {
        found = true;
        licenseStatus = {
          key: licenseKey,
          deviceId: allowedDeviceId,
          status: status,
          expiryDate: expiryDate
        };
        break;
      }
    }

    if (!found) {
      return ContentService.createTextOutput(
        JSON.stringify({
          success: false,
          message: 'License key not found'
        })
      ).setMimeType(ContentService.MimeType.JSON);
    }

    // Validate status
    if (licenseStatus.status !== 'active') {
      return ContentService.createTextOutput(
        JSON.stringify({
          success: false,
          message: `License status: ${licenseStatus.status}`
        })
      ).setMimeType(ContentService.MimeType.JSON);
    }

    // Check expiry date
    if (licenseStatus.expiryDate && new Date(licenseStatus.expiryDate) < new Date()) {
      return ContentService.createTextOutput(
        JSON.stringify({
          success: false,
          message: `License expired on ${licenseStatus.expiryDate}`
        })
      ).setMimeType(ContentService.MimeType.JSON);
    }

    // Validate device ID - if it's set, it must match
    // If it's empty, allow any device (single-device licensing optional)
    if (licenseStatus.deviceId && licenseStatus.deviceId !== deviceId) {
      // Device ID mismatch - license tied to different device
      // You can either:
      // A) Reject: return { success: false, message: 'License tied to different device' }
      // B) Allow: proceed anyway
      
      // For now, we'll reject mismatches
      return ContentService.createTextOutput(
        JSON.stringify({
          success: false,
          message: 'License is tied to a different device'
        })
      ).setMimeType(ContentService.MimeType.JSON);
    }

    // License valid!
    return ContentService.createTextOutput(
      JSON.stringify({
        success: true,
        message: 'License verified successfully'
      })
    ).setMimeType(ContentService.MimeType.JSON);

  } catch (error) {
    Logger.log('Error: ' + error.toString());
    return ContentService.createTextOutput(
      JSON.stringify({
        success: false,
        message: 'Server error: ' + error.toString()
      })
    ).setMimeType(ContentService.MimeType.JSON);
  }
}
```

### 1.3 Create a Google Sheet

1. Go to [Google Sheets](https://sheets.google.com)
2. Create a new spreadsheet named something like "YouTube Tool Licenses"
3. Copy the Spreadsheet ID from the URL: `https://docs.google.com/spreadsheets/d/YOUR_SPREADSHEET_ID/edit`
4. Create a sheet named "Licenses"
5. Set up columns:
   - Column A: License Key
   - Column B: Device ID (optional - leave empty for multi-device licenses)
   - Column C: Status (active/suspended/revoked)
   - Column D: Expiry Date (format: YYYY-MM-DD, or leave empty for no expiry)

Example data:
```
License Key        | Device ID              | Status  | Expiry Date
ABC123DEF456       | abc123def456          | active  | 2026-12-31
XYZ789GHI012       |                       | active  | 2025-12-31
TEST001            | test-device-id        | revoked | 2026-06-30
```

### 1.4 Deploy as Web App

1. In the Apps Script editor, click **"Deploy"**
2. Click **"New Deployment"**
3. Select type: **"Web app"**
4. Set "Execute as" to your account
5. Set "Who has access" to **"Anyone"** (important for external requests)
6. Click **"Deploy"**
7. Copy the deployment URL, which looks like:
   ```
   https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/usercopy
   ```

## Step 2: Update the Electron App

### 2.1 Update GAS_WEBAPP_URL

In `src/index.js`, find this line:

```javascript
const GAS_WEBAPP_URL = 'https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec';
```

Replace `YOUR_DEPLOYMENT_ID` with your actual deployment ID from the Google Apps Script deployment.

Example:
```javascript
const GAS_WEBAPP_URL = 'https://script.google.com/macros/s/AKfycbxX-Z1a2b3c4d5e6f7g8h9i0j1k2l/exec';
```

### 2.2 Update Google Sheet ID in Apps Script

In your Google Apps Script `Code.gs`, find this line:

```javascript
const sheet = SpreadsheetApp.openById('YOUR_SPREADSHEET_ID').getSheetByName('Licenses');
```

Replace `YOUR_SPREADSHEET_ID` with your actual Google Sheet ID.

## Step 3: How It Works (Security)

1. **User launches app** → Main Process checks for stored license
2. **No license?** → Activation window appears (can't bypass - it's required in Main Process)
3. **User enters key** → Sent to Main Process via IPC (secure context isolation)
4. **Main Process verifies**:
   - Sends to Google Apps Script with device fingerprint
   - Server checks Google Sheet for matching key
   - Returns success/failure (server-side logic, user can't modify)
5. **If valid**:
   - Key encrypted using Electron's `safeStorage` (OS-level encryption)
   - Stored in `~/.config/YouTube Tool/license.dat` (Windows: `AppData`)
   - Main window opens
6. **Next launch**:
   - Stored key is decrypted
   - Silent verification with server
   - App launches if valid

## Step 4: Adding Licenses

To add a license for a user:

1. Open your Google Sheet (Licenses tab)
2. Add a new row:
   ```
   UNIQUE_KEY_HERE | device-fingerprint-or-leave-empty | active | 2026-12-31
   ```
3. Save the sheet
4. Give the user the UNIQUE_KEY_HERE

### Example Keys (use a password generator):
- `ABC123DEF456GHI789JKL012MNO345PQR`
- `XYZ789ABC123DEF456GHI789JKL012MNO`

## Step 5: Testing

### Test with a valid license:

1. Add a test row to your Google Sheet with status "active"
2. Launch the app
3. Enter the test license key
4. Should activate successfully

### Test with invalid license:

1. Try entering a fake key
2. Should show "License key not found"

### Test device ID binding:

1. Add a license with a specific device ID
2. Try on that device → should work
3. Try on different device → should fail with "License tied to different device"

## Troubleshooting

### "Network connection error"
- Check internet connection
- Verify GAS_WEBAPP_URL is correct in index.js
- Check that Google Apps Script deployment is public

### "Server configuration error"
- Make sure spreadsheet ID is correct in Apps Script
- Make sure sheet named "Licenses" exists
- Check Apps Script logs for errors

### "License key not found"
- Verify key exists in Google Sheet
- Check for extra spaces in the key
- Make sure you're using the exact key, case-sensitive

### "License tied to different device"
- Device ID in sheet must match the hardware fingerprint
- Leave device ID column empty for multi-device licenses
- Or update the sheet with the user's actual device ID

## Advanced: Revoking Licenses

To revoke a license:

1. Open your Google Sheet
2. Change the "Status" column to "revoked" or "suspended"
3. App will fail to activate on next launch
4. User sees "License status: revoked"

## Advanced: Expiry Dates

Licenses automatically expire based on the "Expiry Date" column:

- Format: `YYYY-MM-DD` (e.g., `2026-12-31`)
- Leave empty for no expiry
- App checks on each verification

## Security Notes

✅ **Secure:**
- License keys never visible in app code
- Device fingerprinting ties license to hardware
- OS-level encryption for stored keys
- Server-side verification (Google Sheets)
- Main Process handles all auth logic

❌ **Not Secure:**
- User can still copy license to backup/cloud
- Device fingerprint can be spoofed on some systems
- User could move license.dat file to another machine if not tied to device
- User can still examine network requests with Wireshark

**This is designed for casual piracy prevention, not serious DRM.**

## Next Steps

1. Set up your Google Sheet with the Licenses sheet
2. Create and deploy the Apps Script Web App
3. Update the GAS_WEBAPP_URL in index.js
4. Update the SPREADSHEET_ID in Apps Script
5. Test with a sample license
6. Build and distribute!

## Notes for Development

Since you mentioned you're still developing:
- You can disable the license check temporarily by commenting out the licensing logic in `app.whenReady()`
- Or add a `--skip-license` command-line flag for dev builds
- Just remember to re-enable before production release

Example for dev flag:
```javascript
const skipLicense = process.argv.includes('--skip-license');

app.whenReady().then(async () => {
  await initializeAdblocker();
  
  if (skipLicense) {
    console.log('⚠️ License check skipped (dev mode)');
    mainWindow = createWindow();
  } else {
    // ... normal licensing logic
  }
});
```

Then run: `npm start -- --skip-license`
