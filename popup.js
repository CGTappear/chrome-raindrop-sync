document.addEventListener('DOMContentLoaded', async () => {
  setupTokenToggle();
  setupEventListeners();
  setupStorageSyncListener();
  await checkAuthStatus();
});

let syncConfigs = [];
let chromeFolderMap = {};
let raindropCollectionMap = {};

const PERIODIC_PULL_ALARM_NAME = 'periodic-raindrop-pull';

/** 预设拉取间隔（分钟），须 ≥1 且与 background 中 clamp 逻辑一致 */
const PULL_INTERVAL_PRESETS = [1, 5, 10, 15, 30, 60, 120, 360, 720, 1440];

let toastTimer = null;

/**
 * MV3：Service Worker 休眠或长时间任务易导致 message port 断开。
 * portRetries：对「port closed / receiving end」类错误额外重试次数。
 */
function sendToBackground(message, options = {}) {
  const portRetries = Number.isFinite(options.portRetries) ? options.portRetries : 0;

  const attempt = retriesLeft =>
    new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(message, response => {
          const rtErr = chrome.runtime.lastError;
          if (rtErr) {
            const msg = rtErr.message || '';
            const transient =
              /message port closed before a response was received/i.test(msg) ||
              /could not establish connection/i.test(msg) ||
              /receiving end does not exist/i.test(msg);
            if (transient && retriesLeft > 0) {
              setTimeout(() => {
                attempt(retriesLeft - 1).then(resolve).catch(reject);
              }, 160);
              return;
            }
            reject(new Error(msg));
            return;
          }
          if (response === undefined) {
            reject(
              new Error(
                '扩展后台未返回结果。请打开 chrome://extensions ，在本扩展下点击「Service Worker」查看报错，或点击「重新加载」。'
              )
            );
            return;
          }
          resolve(response);
        });
      } catch (err) {
        reject(err);
      }
    });

  return attempt(portRetries);
}

/** 与后台建立短连接，延长 Worker 存活，配合长时间 manualSyncFull */
async function withSyncKeepAlivePort(fn) {
  const port = chrome.runtime.connect({ name: 'popup-sync-keepalive' });
  try {
    await new Promise(r => setTimeout(r, 40));
    return await fn();
  } finally {
    try {
      port.disconnect();
    } catch (e) {
      /* ignore */
    }
  }
}

function showToast(message) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = message;
  el.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('is-visible');
  }, 2600);
}

function setupTokenToggle() {
  const input = document.getElementById('token-input');
  const btn = document.getElementById('toggle-token-visibility');
  if (!input || !btn) return;

  btn.addEventListener('click', () => {
    const next = input.type === 'password' ? 'text' : 'password';
    input.type = next;
    btn.setAttribute('aria-pressed', next === 'text' ? 'true' : 'false');
  });
}

function setActivePanel(panelId) {
  const auth = document.getElementById('auth-section');
  const sync = document.getElementById('sync-section');
  if (!auth || !sync) return;

  const showSync = panelId === 'sync';
  auth.classList.toggle('is-active', !showSync);
  sync.classList.toggle('is-active', showSync);
}

async function checkAuthStatus() {
  const result = await chrome.storage.sync.get(['raindropToken']);

  if (result.raindropToken) {
    setActivePanel('sync');
    await loadSyncConfig();
    try {
      await loadFolderOptions();
    } catch (error) {
      addLog('加载文件夹选项失败: ' + error.message);
      showToast('加载文件夹或集合失败');
    }
    renderSyncConfigList();
    await loadPullIntervalUi();
    await loadSyncStatus();
    await refreshNextPullDisplay();
  } else {
    setActivePanel('auth');
  }
}

function showAuthSection() {
  setActivePanel('auth');
}

function showSyncSection() {
  setActivePanel('sync');
}

function setupStorageSyncListener() {
  chrome.storage.local.onChanged.addListener(changes => {
    if (!changes.lastSyncTime && !changes.syncStatus && !changes.lastError) {
      return;
    }
    void loadSyncStatus();
  });
}

function setupEventListeners() {
  document.getElementById('oauth-login-btn').addEventListener('click', oauthLogin);
  document.getElementById('save-token-btn').addEventListener('click', saveToken);
  document.getElementById('manual-sync-btn').addEventListener('click', manualSync);
  document.getElementById('logout-btn').addEventListener('click', logout);
  document.getElementById('add-config-btn').addEventListener('click', addSyncConfig);
  document.getElementById('save-config-btn').addEventListener('click', saveSyncConfig);
  document.getElementById('save-interval-btn').addEventListener('click', savePullInterval);
}

async function oauthLogin() {
  showLoading(true);
  addLog('开始 OAuth 认证...');

  try {
    const raindropAPI = new RaindropAPI();
    const token = await raindropAPI.authenticate();

    if (token) {
      const response = await sendToBackground({
        action: 'setToken',
        token: token
      });

      if (response && response.success) {
        showSyncSection();
        addLog('OAuth 认证成功');
        showToast('登录成功');
        await loadFolderOptions();
        await loadSyncConfig();
        await manualSync();
      } else {
        const err = response ? response.error : '未知错误';
        alert('认证失败: ' + err);
        addLog('认证失败: ' + err);
      }
    }
  } catch (error) {
    console.error('OAuth error:', error);
    alert('OAuth 认证失败: ' + error.message);
    addLog('OAuth 认证失败: ' + error.message);
  } finally {
    showLoading(false);
  }
}

async function saveToken() {
  const token = document.getElementById('token-input').value.trim();

  if (!token) {
    alert('请输入有效的 API Token');
    return;
  }

  showLoading(true);

  try {
    const response = await sendToBackground({
      action: 'setToken',
      token: token
    });

    if (response.success) {
      showSyncSection();
      addLog('Token 保存成功');
      showToast('Token 已保存');
      document.getElementById('token-input').value = '';
      await loadFolderOptions();
      await loadSyncConfig();
      await manualSync();
    } else {
      alert('保存失败: ' + response.error);
    }
  } catch (error) {
    alert('保存失败: ' + error.message);
  } finally {
    showLoading(false);
  }
}

async function manualSync() {
  showLoading(true);
  addLog('开始手动同步...');

  try {
    await withSyncKeepAlivePort(async () => {
      const response = await sendToBackground(
        {
          action: 'manualSyncFull',
          configs: syncConfigs
        },
        { portRetries: 3 }
      );

      if (response.success) {
        addLog('同步完成');
        showToast('同步完成');
        await loadSyncStatus();
        await refreshNextPullDisplay();
      } else {
        addLog('同步失败: ' + response.error);
        showToast('同步失败');
        await loadSyncStatus();
      }
    });
  } catch (error) {
    const hint =
      error && error.message && /message port closed/i.test(error.message)
        ? '（若反复出现请在 chrome://extensions 中重新加载扩展）'
        : '';
    addLog('同步失败: ' + error.message + hint);
    showToast('同步失败');
    await loadSyncStatus();
  } finally {
    showLoading(false);
  }
}

async function saveSyncConfig() {
  if (syncConfigs.length === 0) {
    alert('请至少添加一条映射');
    return;
  }

  showLoading(true);
  try {
    const response = await sendToBackground({
      action: 'setSyncConfigs',
      configs: syncConfigs
    });

    if (response.success) {
      const first = syncConfigs[0];
      const saveSingle = await sendToBackground({
        action: 'setSyncConfig',
        chromeFolderId: first.chromeFolderId,
        raindropCollectionId: first.raindropCollectionId
      });
      if (!saveSingle.success) {
        addLog('保存单条兼容配置失败: ' + saveSingle.error);
        showToast('兼容配置写入失败');
        return;
      }
      addLog(`已保存 ${syncConfigs.length} 条独立同步映射`);
      showToast(`已保存 ${syncConfigs.length} 条映射`);
    } else {
      addLog('保存同步配置失败: ' + response.error);
      showToast('保存失败');
    }
  } catch (error) {
    addLog('保存同步配置失败: ' + error.message);
    showToast('保存失败');
  } finally {
    showLoading(false);
  }
}

async function loadSyncConfig() {
  try {
    syncConfigs = [];
    const response = await sendToBackground({ action: 'getSyncConfig' });
    if (!response.success) return;

    const rawMulti = response.configs;
    const multiList =
      rawMulti !== undefined && rawMulti !== null && Array.isArray(rawMulti) ? rawMulti : [];

    if (multiList.length > 0) {
      syncConfigs = multiList
        .filter(
          config =>
            config &&
            config.chromeFolderId !== undefined &&
            config.chromeFolderId !== null &&
            String(config.chromeFolderId).trim() !== '' &&
            config.raindropCollectionId !== null &&
            config.raindropCollectionId !== undefined &&
            String(config.raindropCollectionId).trim() !== ''
        )
        .map(config => ({
          chromeFolderId: String(config.chromeFolderId),
          raindropCollectionId: String(config.raindropCollectionId)
        }));
    }

    if (
      syncConfigs.length === 0 &&
      response.config &&
      response.config.chromeFolderId !== undefined &&
      response.config.chromeFolderId !== null &&
      String(response.config.chromeFolderId).trim() !== ''
    ) {
      syncConfigs = [{
        chromeFolderId: String(response.config.chromeFolderId),
        raindropCollectionId: String(response.config.raindropCollectionId)
      }];
    }

    renderSyncConfigList();
  } catch (error) {
    addLog('加载同步配置失败: ' + error.message);
  }
}

async function loadFolderOptions() {
  const chromeFolderSelect = document.getElementById('chrome-folder-select');
  const raindropCollectionSelect = document.getElementById('raindrop-collection-select');
  chromeFolderMap = {};
  raindropCollectionMap = {};

  chromeFolderSelect.innerHTML = '<option value="">请选择 Chrome 文件夹</option>';
  raindropCollectionSelect.innerHTML = '<option value="">请选择 Raindrop 集合</option>';

  const bookmarkTree = await chrome.bookmarks.getTree();
  const folders = [];
  extractFolders(bookmarkTree[0], '', folders);

  for (const folder of folders) {
    chromeFolderMap[folder.id] = folder.path;
    const option = document.createElement('option');
    option.value = folder.id;
    option.textContent = folder.path;
    chromeFolderSelect.appendChild(option);
  }

  const api = new RaindropAPI();
  await api.init();
  const collections = await api.getCollectionsNested();

  const allOption = document.createElement('option');
  allOption.value = '0';
  allOption.textContent = '全部书签（不含回收站）';
  raindropCollectionMap['0'] = allOption.textContent;
  raindropCollectionSelect.appendChild(allOption);

  const unsortedOption = document.createElement('option');
  unsortedOption.value = '-1';
  unsortedOption.textContent = '未分类（Unsorted）';
  raindropCollectionMap['-1'] = unsortedOption.textContent;
  raindropCollectionSelect.appendChild(unsortedOption);

  const flattenedCollections = flattenRaindropCollections(collections);
  for (const collection of flattenedCollections) {
    raindropCollectionMap[collection.id] = collection.path;
    const option = document.createElement('option');
    option.value = String(collection.id);
    option.textContent = collection.path;
    raindropCollectionSelect.appendChild(option);
  }
}

function addSyncConfig() {
  const chromeFolderId = document.getElementById('chrome-folder-select').value;
  const raindropCollectionId = document.getElementById('raindrop-collection-select').value;

  if (!chromeFolderId) {
    showToast('请选择 Chrome 文件夹');
    return;
  }
  if (raindropCollectionId === '') {
    showToast('请选择 Raindrop 集合');
    return;
  }

  const exists = syncConfigs.some(
    config =>
      config.chromeFolderId === chromeFolderId &&
      String(config.raindropCollectionId) === String(raindropCollectionId)
  );
  if (exists) {
    showToast('该映射已存在');
    addLog('该映射已存在，已跳过');
    return;
  }

  syncConfigs.push({
    chromeFolderId,
    raindropCollectionId: String(raindropCollectionId)
  });
  renderSyncConfigList();
  addLog('已添加同步映射');
  showToast('已添加映射');
}

function removeSyncConfig(index) {
  syncConfigs.splice(index, 1);
  renderSyncConfigList();
  showToast('已移除映射');
}

function updateMappingBadge() {
  const badge = document.getElementById('mapping-count-badge');
  if (!badge) return;
  const n = syncConfigs.length;
  badge.textContent = String(n);
  badge.setAttribute('aria-label', `当前 ${n} 条映射`);
}

function renderSyncConfigList() {
  const list = document.getElementById('sync-config-list');
  if (!list) return;

  updateMappingBadge();

  if (syncConfigs.length === 0) {
    list.innerHTML = '';
    const empty = document.createElement('div');
    empty.className = 'mapping-empty';
    empty.textContent = '暂无映射，请选择文件夹与集合后点击「添加映射」';
    list.appendChild(empty);
    return;
  }

  list.innerHTML = '';
  syncConfigs.forEach((config, index) => {
    const item = document.createElement('div');
    item.className = 'mapping-row';

    const chromeName = chromeFolderMap[config.chromeFolderId] || `Chrome #${config.chromeFolderId}`;
    const rainName =
      raindropCollectionMap[config.raindropCollectionId] || `Raindrop #${config.raindropCollectionId}`;

    const text = document.createElement('div');
    text.className = 'mapping-text';

    const chromeSpan = document.createElement('span');
    chromeSpan.textContent = chromeName;

    const arrow = document.createElement('span');
    arrow.className = 'mapping-arrow';
    arrow.textContent = '↔';

    const rainSpan = document.createElement('span');
    rainSpan.textContent = rainName;

    text.appendChild(chromeSpan);
    text.appendChild(arrow);
    text.appendChild(rainSpan);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mapping-remove-btn';
    btn.textContent = '移除';
    btn.addEventListener('click', () => removeSyncConfig(index));

    item.appendChild(text);
    item.appendChild(btn);
    list.appendChild(item);
  });
}

function flattenRaindropCollections(nodes, parentPath = '') {
  const output = [];
  if (!Array.isArray(nodes)) {
    return output;
  }

  for (const node of nodes) {
    if (!node || node._id === null || node._id === undefined) {
      continue;
    }

    const title = node.title || '未命名';
    const currentPath = parentPath ? `${parentPath} / ${title}` : title;
    output.push({
      id: node._id,
      path: currentPath
    });

    if (Array.isArray(node.children) && node.children.length > 0) {
      output.push(...flattenRaindropCollections(node.children, currentPath));
    }
  }

  return output;
}

function extractFolders(node, parentPath, output) {
  if (!node) return;
  const title = node.title || '根目录';
  const currentPath = parentPath ? `${parentPath} / ${title}` : title;

  if (!node.url && node.id && node.id !== '0') {
    output.push({ id: node.id, path: currentPath });
  }

  if (node.children) {
    for (const child of node.children) {
      extractFolders(child, currentPath, output);
    }
  }
}

async function logout() {
  if (
    confirm(
      '确定要退出登录吗？将清除本机的 Token、映射与同步缓存（Raindrop 云端数据不受影响）。'
    )
  ) {
    await chrome.storage.sync.remove(['raindropToken', 'raindropRefreshToken', 'tokenExpiresAt']);
    await chrome.storage.local.clear();
    syncConfigs = [];
    const logContent = document.getElementById('log-content');
    if (logContent) {
      logContent.innerHTML = '';
    }
    renderSyncConfigList();
    showAuthSection();
    showToast('已退出登录');
  }
}

async function loadPullIntervalUi() {
  const select = document.getElementById('pull-interval-select');
  if (!select) return;

  try {
    const response = await sendToBackground({ action: 'getPullIntervalMinutes' });
    if (!response.success) {
      addLog('读取拉取间隔失败: ' + response.error);
      return;
    }

    const current = response.pullIntervalMinutes;
    const choices = new Set(PULL_INTERVAL_PRESETS);
    choices.add(current);

    const sorted = Array.from(choices).sort((a, b) => a - b);
    select.innerHTML = '';
    for (const minutes of sorted) {
      const opt = document.createElement('option');
      opt.value = String(minutes);
      opt.textContent = formatIntervalLabel(minutes);
      select.appendChild(opt);
    }
    select.value = String(current);
  } catch (error) {
    addLog('读取拉取间隔失败: ' + error.message);
  }
}

function formatIntervalLabel(minutes) {
  if (minutes < 60) {
    return `${minutes} 分钟`;
  }
  if (minutes % 1440 === 0) {
    const d = minutes / 1440;
    return d === 1 ? '24 小时（1 天）' : `${d} 天`;
  }
  if (minutes % 60 === 0) {
    const h = minutes / 60;
    return h === 1 ? '1 小时' : `${h} 小时`;
  }
  return `${minutes} 分钟`;
}

async function savePullInterval() {
  const select = document.getElementById('pull-interval-select');
  const minutes = Number(select && select.value);
  if (!Number.isFinite(minutes)) {
    showToast('无效的拉取间隔');
    return;
  }

  showLoading(true);
  try {
    const response = await sendToBackground({
      action: 'setPullIntervalMinutes',
      minutes
    });
    if (response.success) {
      addLog(`已保存拉取间隔：${formatIntervalLabel(response.pullIntervalMinutes)}`);
      showToast('间隔已保存');
      await refreshNextPullDisplay();
    } else {
      addLog('保存拉取间隔失败: ' + response.error);
      showToast('保存间隔失败');
    }
  } catch (error) {
    addLog('保存拉取间隔失败: ' + error.message);
    showToast('保存间隔失败');
  } finally {
    showLoading(false);
  }
}

async function refreshNextPullDisplay() {
  const el = document.getElementById('next-pull-time');
  if (!el) return;

  try {
    const alarm = await chrome.alarms.get(PERIODIC_PULL_ALARM_NAME);
    if (!alarm || !alarm.scheduledTime) {
      el.textContent = '—';
      return;
    }
    el.textContent = new Date(alarm.scheduledTime).toLocaleString('zh-CN');
  } catch (error) {
    el.textContent = '—';
  }
}

async function loadSyncStatus() {
  const result = await chrome.storage.local.get(['lastSyncTime', 'syncStatus', 'lastError']);

  const pill = document.getElementById('sync-status-pill');
  const statusEl = document.getElementById('sync-status');
  const timeEl = document.getElementById('last-sync-time');

  if (pill) {
    pill.classList.remove('is-ok', 'is-err');
  }

  if (statusEl) {
    if (result.syncStatus === 'success') {
      statusEl.textContent = '同步成功';
      if (pill) pill.classList.add('is-ok');
    } else if (result.syncStatus === 'error') {
      statusEl.textContent = '同步失败';
      if (pill) pill.classList.add('is-err');
    } else {
      statusEl.textContent = '未同步';
    }
  }

  if (timeEl) {
    if (result.lastSyncTime) {
      const date = new Date(result.lastSyncTime);
      timeEl.textContent = date.toLocaleString('zh-CN');
      timeEl.setAttribute('datetime', date.toISOString());
    } else {
      timeEl.textContent = '从未';
      timeEl.removeAttribute('datetime');
    }
  }

  const errRow = document.getElementById('last-error-row');
  const errText = document.getElementById('last-error-text');
  if (errRow && errText) {
    const msg = (result.lastError && String(result.lastError).trim()) || '';
    if (msg && result.syncStatus === 'error') {
      errText.textContent = msg;
      errRow.hidden = false;
    } else {
      errText.textContent = '';
      errRow.hidden = true;
    }
  }
}

function addLog(message) {
  const logContent = document.getElementById('log-content');
  if (!logContent) return;

  const logEntry = document.createElement('div');
  logEntry.className = 'log-entry';
  logEntry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  logContent.insertBefore(logEntry, logContent.firstChild);

  const max = 12;
  while (logContent.children.length > max) {
    logContent.removeChild(logContent.lastChild);
  }
}

function showLoading(show) {
  const loading = document.getElementById('loading');
  if (!loading) return;

  loading.style.display = show ? 'flex' : 'none';
  loading.setAttribute('aria-hidden', show ? 'false' : 'true');
  loading.setAttribute('aria-busy', show ? 'true' : 'false');
}
