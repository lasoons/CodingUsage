# Cursor Usage Monitor

No need to manually obtain or set cookies, the entire process is automated. Monitor your Cursor AI usage statistics directly in Cursor. This extension displays your current billing period usage information in the status bar. Updated sync behavior: the extension checks the local database every 5 seconds and only requests the Cursor API when a conversation change is detected, eliminating unnecessary polling.

![Cursor Usage Monitor Demo](CursorUsage/img/cursorusage.gif)

## Features

- Real-time monitoring of Cursor AI usage
- Display of current billing period and usage statistics
- Easy configuration through VS Code settings

## Requirements

You need to have a Cursor account and extract your session token from Cursor.com cookies.

## Extension Settings

This extension contributes the following settings:

* `cursorUsage.sessionToken`: The WorkosCursorSessionToken value from Cursor.com cookies
* `cursorUsage.refreshInterval`: Interval in seconds to refresh usage data automatically (default: 300)

## How to Get Your Session Token

1. Install the Cursor Session Token Extractor Browser Extension:
   - [Chrome Web Store](https://chromewebstore.google.com/detail/cursor-session-token-extr/pchppfhkjloedakahedjknknjppjpple)
   - [Microsoft Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/hgabfbdfbpplaoakjkclmijoegfgcdli)
2. Visit cursor.com and log in to your account
3. The browser extension will automatically extract your session token
4. Return to Cursor, and the CursorUsage will automatically read your clipboard and update the configuration.


## Usage

Once configured, the extension will display your Cursor usage in the status bar. Click on the status bar item to refresh the data manually.

## License

MIT