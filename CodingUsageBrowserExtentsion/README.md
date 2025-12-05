# AI IDE Usage Token Extractor

A browser extension to automatically extract session tokens from multiple AI IDEs (Cursor, Trae) for seamless integration.

## Supported Platforms

| Platform | Cookie/Token Name | Dashboard URL |
|----------|------------------|---------------|
| **Cursor** | `WorkosCursorSessionToken` | cursor.com/dashboard |
| **Trae** | `X-Cloudide-Session` | trae.ai/account-setting#usage |

## Features

- **Multi-platform support**: Extract tokens from Cursor and Trae with one extension
- **Auto-extraction**: Automatically detects and extracts session tokens when visiting dashboards
- **Auto-copy**: Tokens are automatically copied to clipboard with proper prefix
- **Toast notifications**: Visual feedback when tokens are copied
- **Quick access buttons**: Jump to platform dashboards with one click
- **Extensible design**: Easy to add support for more AI IDEs in the future

## Installation

### From Release (Recommended)
1. Go to the [Releases](../../releases) page
2. Download the latest `.crx` or `.zip` file
3. Open your browser's extension management page:
   - **Chrome**: `chrome://extensions/`
   - **Edge**: `edge://extensions/`
4. Enable "Developer mode" in the top right
5. Drag and drop the `.crx` file or click "Load unpacked" and select the extracted folder

### From Source
1. Clone this repository
2. Open your browser's extension management page
3. Enable "Developer mode"
4. Click "Load unpacked" and select the `TraeUsageWebExtentsion` folder

## Usage

### For Cursor
1. Click the extension icon
2. Click "Go to Cursor Dashboard"
3. The extension auto-extracts `WorkosCursorSessionToken` and copies it to clipboard
4. A toast notification confirms successful copying
5. Return to Cursor IDE - the extension will auto-update the session

### For Trae
1. Click the extension icon
2. Click "Go to Trae Usage Page"
3. The extension auto-extracts `X-Cloudide-Session` and copies it to clipboard
4. A toast notification confirms successful copying
5. Return to Trae IDE - the extension will auto-update the session

## Technical Details

- Uses Manifest V3 for modern browser compatibility
- Monitors cookies via `chrome.cookies` API
- Cursor: Triggers on dashboard page load
- Trae: Triggers on `ide_user_pay_status` API detection with debouncing
- Stores session data in browser's local storage
- Toast notifications with smooth CSS animations

## Files

- `manifest.json` - Extension configuration
- `background.js` - Background script for request monitoring and cookie extraction
- `content.js` - Content script for clipboard operations and toast notifications
- `popup.html` - Extension popup interface
- `popup.js` - Popup functionality
- `icon*.png` - Extension icons

## Adding New Platforms

To add support for a new AI IDE:

1. **manifest.json**: Add host permissions and content scripts for the new domain
2. **background.js**: Add extraction function and event listeners
3. **content.js**: Add platform-specific toast styling (if needed)
4. **popup.html/js**: Add new button section

## Development & Release

### Automatic Building
This project uses GitHub Actions to automatically build and release:

1. Create a new tag: `git tag v2.0.0 && git push origin v2.0.0`
2. GitHub Actions will build and create a release with CRX and ZIP files

### Manual Building
```bash
# Install crx3 globally
npm install -g crx3

# Generate a private key (first time only)
openssl genrsa -out key.pem 2048

# Build CRX file
crx3 --keyPath=key.pem --crxPath=AIIDETokenExtractor.crx .
```

## Changelog

### v2.0.0
- Merged CursorUsageTokenExtractor into this extension
- Added multi-platform support (Cursor + Trae)
- Redesigned popup UI with platform sections
- Improved toast notifications with platform-specific styling

### v1.2.5
- Initial Trae-only version
