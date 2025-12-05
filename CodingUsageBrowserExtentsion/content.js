// Content script for Trae and Cursor pages
// This script runs in the context of both trae.ai and cursor.com web pages

// Detect current platform
function getCurrentPlatform() {
  const hostname = window.location.hostname;
  if (hostname.includes('trae.ai')) return 'trae';
  if (hostname.includes('cursor.com')) return 'cursor';
  return null;
}

// Listen for messages from background script
chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
  if (request.action === 'tokenExtracted') {
    console.log('Token has been extracted by the extension');
  } else if (request.action === 'showSessionCopiedToast') {
    const platform = request.platform || getCurrentPlatform();
    showSessionCopiedToast(platform);
  } else if (request.action === 'copyToClipboard') {
    // Handle clipboard copy request from background script
    copyTextToClipboard(request.text).then((success) => {
      if (success) {
        console.log('Text copied to clipboard successfully from content script');
        sendResponse({success: true});
      } else {
        console.error('Failed to copy to clipboard from content script');
        sendResponse({success: false, error: 'Clipboard access failed'});
      }
    });
    return true; // Keep the message channel open for async response
  }
});

// Robust clipboard copy function with fallback methods
async function copyTextToClipboard(text) {
  // Method 1: Try modern Clipboard API first
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (error) {
      console.log('Modern clipboard API failed, trying fallback method:', error);
    }
  }
  
  // Method 2: Fallback to document.execCommand
  try {
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.style.position = 'fixed';
    textArea.style.left = '-999999px';
    textArea.style.top = '-999999px';
    document.body.appendChild(textArea);
    
    textArea.focus();
    textArea.select();
    const successful = document.execCommand('copy');
    
    document.body.removeChild(textArea);
    
    if (successful) {
      return true;
    }
  } catch (error) {
    console.log('Fallback clipboard method also failed:', error);
  }
  
  return false;
}

// Show toast notification when session is copied
function showSessionCopiedToast(platform) {
  // Get platform-specific styling
  let bgColor, platformName, subMessage;
  if (platform === 'cursor') {
    bgColor = '#000000';
    platformName = 'Cursor';
    subMessage = 'Return to Cursor, the extension will auto-update SessionID';
  } else {
    bgColor = '#007bff';
    platformName = 'Trae';
    subMessage = 'Return to Trae, the extension will auto-update SessionID';
  }
  
  // Create a toast notification element
  const toast = document.createElement('div');
  toast.style.cssText = `
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    background-color: ${bgColor};
    color: white;
    padding: 15px 20px;
    border-radius: 8px;
    z-index: 10000;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: 14px;
    font-weight: 500;
    box-shadow: 0 4px 20px rgba(0,0,0,0.15);
    max-width: 350px;
    line-height: 1.4;
    animation: fadeIn 0.3s ease-out;
  `;
  
  // Add CSS animation
  const style = document.createElement('style');
  style.textContent = `
    @keyframes fadeIn {
      from {
        opacity: 0;
        transform: translate(-50%, -50%) scale(0.9);
      }
      to {
        opacity: 1;
        transform: translate(-50%, -50%) scale(1);
      }
    }
    @keyframes fadeOut {
      from {
        opacity: 1;
        transform: translate(-50%, -50%) scale(1);
      }
      to {
        opacity: 0;
        transform: translate(-50%, -50%) scale(0.9);
      }
    }
  `;
  document.head.appendChild(style);
  
  toast.innerHTML = `
    <div style="display: flex; align-items: center; gap: 10px;">
      <div style="font-size: 18px;">✓</div>
      <div>
        <div style="font-weight: 600; margin-bottom: 2px;">${platformName} session token copied to clipboard</div>
        <div style="font-size: 12px; opacity: 0.9;">${subMessage}</div>
      </div>
    </div>
  `;
  
  document.body.appendChild(toast);
  
  // Remove toast after 3 seconds with fade out animation
  setTimeout(() => {
    toast.style.animation = 'fadeOut 0.3s ease-in';
    setTimeout(() => {
      if (toast.parentNode) {
        toast.parentNode.removeChild(toast);
      }
      if (style.parentNode) {
        style.parentNode.removeChild(style);
      }
    }, 300);
  }, 3000);
}

// Optional: Add visual indicator on the page when token is extracted
function showPageNotification(message) {
  const notification = document.createElement('div');
  notification.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    background-color: #4CAF50;
    color: white;
    padding: 10px 15px;
    border-radius: 5px;
    z-index: 10000;
    font-family: Arial, sans-serif;
    font-size: 14px;
    box-shadow: 0 2px 10px rgba(0,0,0,0.2);
  `;
  notification.textContent = message;
  
  document.body.appendChild(notification);
  
  // Remove notification after 3 seconds
  setTimeout(() => {
    if (notification.parentNode) {
      notification.parentNode.removeChild(notification);
    }
  }, 3000);
}

// Monitor for Trae API calls (as backup to background script)
if (getCurrentPlatform() === 'trae') {
  const originalFetch = window.fetch;
  window.fetch = function(...args) {
    const url = args[0];
    if (typeof url === 'string' && url.includes('/trae/api/v1/pay/ide_user_pay_status')) {
      console.log('Detected Trae API call:', url);
    }
    return originalFetch.apply(this, args);
  };

  const originalXHROpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...args) {
    if (typeof url === 'string' && url.includes('/trae/api/v1/pay/ide_user_pay_status')) {
      console.log('Detected Trae XHR call:', url);
    }
    return originalXHROpen.call(this, method, url, ...args);
  };
}

console.log(`AI IDE Token Extractor content script loaded (${getCurrentPlatform() || 'unknown'} platform)`);
