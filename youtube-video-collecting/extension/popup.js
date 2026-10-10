const toggle = document.querySelector('#enabled');
const connection = document.querySelector('#connection');
const check = document.querySelector('#check');
const last = document.querySelector('#last');

async function refresh() {
  const values = await chrome.storage.local.get(['enabled', 'lastStatus']);
  toggle.checked = values.enabled !== false;
  const status = values.lastStatus;
  if (!status) return;
  connection.textContent = status.message;
  connection.dataset.error = String(status.state === 'error');
  if (status.url) {
    const url = new URL(status.url);
    last.textContent = `${url.searchParams.get('v')} at ${url.searchParams.get('t')}`;
  }
}
toggle.addEventListener('change', () => chrome.storage.local.set({ enabled: toggle.checked }));
check.addEventListener('click', async () => {
  check.disabled = true;
  connection.textContent = 'Checking connection';
  try { await chrome.runtime.sendMessage({ type: 'check-connection' }); }
  catch (error) { connection.textContent = error.message; connection.dataset.error = 'true'; }
  finally { check.disabled = false; await refresh(); }
});
chrome.storage.onChanged.addListener(() => { void refresh(); });
void refresh();
