// Background script to monitor network requests for multiple AI IDEs
let extractedTraeSession = null;
let extractedCursorSession = null;
let extractionTimeout = null;

// ==================== Trae Functions ====================

// Function to extract Trae session from cookies and auto-copy to clipboard
async function extractTraeSessionFromCookies() {
  try {
    console.log('Attempting to read X-Cloudide-Session cookie from trae.ai domain');
    
    const cookie = await chrome.cookies.get({
      url: 'https://www.trae.ai',
      name: 'X-Cloudide-Session'
    });
    
    if (cookie && cookie.value) {
      extractedTraeSession = cookie.value;
      console.log('X-Cloudide-Session found:', extractedTraeSession);
      
      // Auto-copy to clipboard with prefix
      const sessionWithPrefix = `X-Cloudide-Session=${extractedTraeSession}`;
      await copyToClipboard(sessionWithPrefix);
      
      // Notify content script to show toast
      notifyPageSessionCopied('trae');
      
      console.log('Trae session auto-copied to clipboard');
      
      // Store the session
      chrome.storage.local.set({
        traeSession: extractedTraeSession,
        traeSessionFound: true
      });
      
      // Update badge
      chrome.action.setBadgeText({text: '✓'});
      chrome.action.setBadgeBackgroundColor({color: '#4CAF50'});
      
      return true;
    } else {
      console.log('X-Cloudide-Session cookie not found');
      return false;
    }
  } catch (error) {
    console.error('Error reading Trae cookies:', error);
    return false;
  }
}

// ==================== Cursor Functions ====================

// Function to check if URL is Cursor dashboard
function isCursorDashboard(url) {
  try {
    const u = new URL(url);
    if (!u.hostname.endsWith('cursor.com')) return false;
    const path = u.pathname.toLowerCase();
    return path.endsWith('/dashboard') || /\/dashboard\/?$/.test(path);
  } catch {
    return false;
  }
}

// Function to extract Cursor session from cookies and auto-copy to clipboard
async function extractCursorSessionFromCookies() {
  try {
    console.log('Attempting to read WorkosCursorSessionToken cookie from cursor.com domain');
    
    const cookie = await chrome.cookies.get({
      url: 'https://cursor.com',
      name: 'WorkosCursorSessionToken'
    });
    
    if (cookie && cookie.value) {
      extractedCursorSession = cookie.value;
      console.log('WorkosCursorSessionToken found:', extractedCursorSession);
      
      // Auto-copy to clipboard with prefix
      const sessionWithPrefix = `WorkosCursorSessionToken=${extractedCursorSession}`;
      await copyToClipboard(sessionWithPrefix);
      
      // Notify content script to show toast
      notifyPageSessionCopied('cursor');
      
      console.log('Cursor session auto-copied to clipboard');
      
      // Store the session
      chrome.storage.local.set({
        cursorSession: extractedCursorSession,
        cursorSessionFound: true
      });
      
      // Update badge
      chrome.action.setBadgeText({text: '✓'});
      chrome.action.setBadgeBackgroundColor({color: '#000000'});
      
      return true;
    } else {
      console.log('WorkosCursorSessionToken cookie not found');
      chrome.storage.local.set({ cursorSessionFound: false });
      chrome.action.setBadgeText({ text: '' });
      return false;
    }
  } catch (error) {
    console.error('Error reading Cursor cookies:', error);
    return false;
  }
}

// ==================== Common Functions ====================

// Function to copy text to clipboard via content script
async function copyToClipboard(text) {
  try {
    const tabs = await chrome.tabs.query({active: true, currentWindow: true});
    if (tabs.length > 0) {
      await chrome.tabs.sendMessage(tabs[0].id, {
        action: 'copyToClipboard',
        text: text
      });
      console.log('Text copied to clipboard successfully');
    }
  } catch (error) {
    console.error('Failed to copy to clipboard:', error);
  }
}

// Function to notify content script to show toast
function notifyPageSessionCopied(platform) {
  let urlPattern;
  if (platform === 'trae') {
    urlPattern = '*://*.trae.ai/*';
  } else if (platform === 'cursor') {
    urlPattern = '*://*.cursor.com/*';
  }
  
  chrome.tabs.query({active: true, url: urlPattern}, (tabs) => {
    if (tabs.length > 0) {
      chrome.tabs.sendMessage(tabs[0].id, {
        action: 'showSessionCopiedToast',
        platform: platform
      }).catch(error => {
        console.log('Could not send message to content script:', error);
      });
    }
  });
}

// ==================== Event Listeners ====================

// Listen for Trae ide_user_pay_status API requests
chrome.webRequest.onBeforeSendHeaders.addListener(
  function(details) {
    console.log('Request URL:', details.url);
    
    // Check if this is the Trae ide_user_pay_status API
    if (details.url.includes('/ide_user_pay_status')) {
      console.log('Trae ide_user_pay_status API detected!');
      
      // Clear previous timeout for debouncing
      if (extractionTimeout) {
        clearTimeout(extractionTimeout);
        console.log('Previous extraction cancelled, waiting for the last request...');
      }
      
      // Set new timeout to handle last request
      extractionTimeout = setTimeout(() => {
        console.log('Processing the last ide_user_pay_status request, extracting Trae session...');
        extractTraeSessionFromCookies();
        extractionTimeout = null;
      }, 1000);
    }
  },
  {urls: ["*://*.trae.ai/*"]},
  ["requestHeaders"]
);

// Listen for Cursor dashboard tab updates
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url) {
    // Handle Cursor dashboard
    if (isCursorDashboard(tab.url)) {
      console.log('Cursor dashboard detected, extracting session...');
      extractCursorSessionFromCookies();
    }
    
    // Reset badge when navigating away from both platforms
    if (!tab.url.includes('trae.ai') && !tab.url.includes('cursor.com')) {
      chrome.storage.local.set({ 
        traeSessionFound: false,
        cursorSessionFound: false
      });
      chrome.action.setBadgeText({ text: '' });
    }
  }
});

// Handle extension installation
chrome.runtime.onInstalled.addListener(() => {
  console.log('AI IDE Usage Token Extractor installed');
});
