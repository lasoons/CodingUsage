// Popup script for handling UI interactions
document.addEventListener('DOMContentLoaded', function() {
  const toast = document.getElementById('toast');
  const cursorBtn = document.getElementById('cursorBtn');
  const traeBtn = document.getElementById('traeBtn');
  const helpHeader = document.getElementById('helpHeader');
  const helpContent = document.getElementById('helpContent');
  
  // Help toggle handler
  helpHeader.addEventListener('click', function() {
    helpContent.classList.toggle('show');
  });
  
  // Cursor button click handler - Go to Cursor dashboard
  cursorBtn.addEventListener('click', function() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      let targetUrl = 'https://cursor.com/dashboard?tab=usage';
      const tab = tabs && tabs[0];
      
      // Handle localized Cursor URLs (e.g., /en/dashboard, /zh-CN/dashboard)
      if (tab && tab.url && tab.url.includes('cursor.com')) {
        try {
          const u = new URL(tab.url);
          const segments = u.pathname.split('/').filter(Boolean);
          const first = segments[0] || '';
          // Check if first segment is a locale code (e.g., en, zh-CN)
          if (/^[a-z]{2}(?:-[A-Za-z]{2})?$/.test(first)) {
            targetUrl = `https://cursor.com/${first}/dashboard?tab=usage`;
          }
        } catch (e) {
          console.error('Error parsing URL:', e);
        }
      }
      
      chrome.tabs.create({ url: targetUrl });
    });
  });
  
  // Trae button click handler - Go to Trae usage page
  traeBtn.addEventListener('click', function() {
    chrome.tabs.create({ url: 'https://www.trae.ai/account-setting#usage' });
  });
});
