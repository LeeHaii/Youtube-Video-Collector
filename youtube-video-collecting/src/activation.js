// Activation Window UI Handler

console.log('🔑 Activation window loaded');

const licenseKeyInput = document.getElementById('licenseKeyInput');
const activateBtn = document.getElementById('activateBtn');
const quitBtn = document.getElementById('quitBtn');
const messageEl = document.getElementById('message');

// Show message to user
function showMessage(text, type) {
  messageEl.textContent = text;
  messageEl.className = `message ${type}`;
  console.log(`[${type.toUpperCase()}] ${text}`);
}

// Clear message
function clearMessage() {
  messageEl.className = 'message';
  messageEl.textContent = '';
}

// Activate License
activateBtn.addEventListener('click', async () => {
  const key = licenseKeyInput.value.trim();

  if (!key) {
    showMessage('❌ Please enter a license key', 'error');
    return;
  }

  activateBtn.disabled = true;
  activateBtn.textContent = '⏳ Activating...';
  clearMessage();

  try {
    console.log('📤 Submitting license key for verification...');
    showMessage('<span class="spinner"></span> Verifying license...', 'loading');

    const response = await window.licensingAPI.submitLicenseKey(key);
    console.log('✅ Server response:', response);

    if (response.success) {
      showMessage('✅ License activated successfully! Launching application...', 'success');
      activateBtn.textContent = 'Activated ✓';
      
      // Wait 1 second then app will auto-close this window and load main app
      setTimeout(() => {}, 1000);
    } else {
      showMessage(`❌ Activation failed: ${response.message || 'Invalid license key'}`, 'error');
      activateBtn.disabled = false;
      activateBtn.textContent = 'Activate';
      licenseKeyInput.focus();
    }
  } catch (error) {
    console.error('❌ Activation error:', error);
    showMessage(`❌ Error: ${error.message}`, 'error');
    activateBtn.disabled = false;
    activateBtn.textContent = 'Activate';
  }
});

// Quit Button
quitBtn.addEventListener('click', () => {
  console.log('👋 User clicked Quit');
  window.close();
});

// Allow Enter key to submit
licenseKeyInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter' && !activateBtn.disabled) {
    activateBtn.click();
  }
});

console.log('✅ Activation.js fully initialized');
