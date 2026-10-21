const statusEl = document.getElementById('status');
const inputEl = document.getElementById('serverUrl');
const deviceEl = document.getElementById('deviceName');
const deviceLabel = document.getElementById('deviceLabel');

function render(s) {
  statusEl.textContent = s.connected
    ? `Connected${s.deviceName ? ' as "' + s.deviceName + '"' : ''} (${s.tabs} tab session(s))`
    : 'Disconnected — start relay server';
  statusEl.className = s.connected ? 'on' : 'off';
  if (s.deviceName && !deviceEl.value) deviceEl.value = s.deviceName;
}

chrome.storage.local.get(['serverUrl', 'deviceName']).then(({ serverUrl, deviceName }) => {
  inputEl.value = serverUrl || 'ws://127.0.0.1:8765';
  if (deviceName) {
    deviceEl.value = deviceName;
    deviceLabel.textContent = '';
  } else {
    deviceLabel.textContent = '未设置时自动使用系统默认名';
  }
});

chrome.runtime.sendMessage({ type: 'getStatus' }, render);

document.getElementById('save').addEventListener('click', async () => {
  const name = deviceEl.value.trim();
  await chrome.storage.local.set({
    serverUrl: inputEl.value.trim(),
    deviceName: name
  });
  deviceLabel.textContent = name ? '' : '未设置时自动使用系统默认名';
  chrome.runtime.sendMessage({ type: 'setName', name });
});

document.getElementById('reconnect').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'reconnect' });
  setTimeout(() => chrome.runtime.sendMessage({ type: 'getStatus' }, render), 800);
});
