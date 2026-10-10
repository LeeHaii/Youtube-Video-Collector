importScripts('collector-link.js', 'navigation.js');
const router = CollectorRouter.createRouter(chrome);
chrome.webNavigation.onCreatedNavigationTarget.addListener((event) => { void router.created(event); });
chrome.webNavigation.onBeforeNavigate.addListener((event) => { void router.before(event); });
chrome.webNavigation.onCommitted.addListener((event) => { void router.committed(event); });
chrome.tabs.onRemoved.addListener((tabId) => { void router.removed(tabId); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.enabled) void router.setEnabled(changes.enabled.newValue);
});
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || sender.tab) return;
  if (message?.type === 'check-connection') {
    router.checkConnection().then(reply);
    return true;
  }
});
void router.resume();
