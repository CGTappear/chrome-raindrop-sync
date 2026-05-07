importScripts('config.js', 'raindrop-api.js', 'sync-engine.js');

console.log('Background script loaded!');

const raindropAPI = new RaindropAPI();
const syncEngine = new SyncEngine(raindropAPI);

const PERIODIC_PULL_ALARM = 'periodic-raindrop-pull';
/** 默认 Raindrop → Chrome 拉取间隔（分钟）。Chrome alarms 最小周期为 1 分钟。 */
const DEFAULT_PULL_INTERVAL_MINUTES = 5;
const MIN_PULL_INTERVAL_MINUTES = 1;
const MAX_PULL_INTERVAL_MINUTES = 24 * 60;

async function ensureInitialized() {
  const initialized = await raindropAPI.init();
  if (!initialized) {
    throw new Error('未设置 Raindrop Token');
  }
}

async function runSync() {
  await ensureInitialized();
  await syncEngine.initSync();
}

/** 与 popup / setSyncConfigs 使用相同的映射校验规则 */
function normalizeSyncConfigsList(configs) {
  const list = Array.isArray(configs) ? configs : [];
  return list
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

/** 保存多条映射并写入第一条作为单条兼容配置（与 popup 手动同步一致） */
async function persistSyncMappingsForManualSync(rawConfigs) {
  const configs = Array.isArray(rawConfigs) ? rawConfigs : [];
  const normalized = normalizeSyncConfigsList(configs);
  if (configs.length > 0 && normalized.length === 0) {
    throw new Error('映射数据格式无效，未保存任何条目');
  }
  if (normalized.length > 0) {
    await syncEngine.saveSyncConfigs(normalized);
    await syncEngine.saveSyncConfig({
      chromeFolderId: normalized[0].chromeFolderId,
      raindropCollectionId: normalized[0].raindropCollectionId
    });
  }
}

/**
 * MV3：popup 在长时间同步期间保持 connect，可降低 Service Worker 过早休眠导致
 * 「The message port closed before a response was received」的概率。
 */
chrome.runtime.onConnect.addListener(port => {
  if (port.name === 'popup-sync-keepalive') {
    port.onMessage.addListener(() => {});
  }
});

function clampPullIntervalMinutes(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    return DEFAULT_PULL_INTERVAL_MINUTES;
  }
  return Math.min(MAX_PULL_INTERVAL_MINUTES, Math.max(MIN_PULL_INTERVAL_MINUTES, Math.round(n)));
}

async function schedulePeriodicPullAlarm() {
  const stored = await chrome.storage.local.get(['pullIntervalMinutes']);
  const periodInMinutes = clampPullIntervalMinutes(stored.pullIntervalMinutes);

  await new Promise(resolve => {
    chrome.alarms.clear(PERIODIC_PULL_ALARM, () => {
      if (chrome.runtime.lastError) {
        console.warn('清除定时同步 alarm:', chrome.runtime.lastError.message);
      }
      resolve();
    });
  });

  chrome.alarms.create(PERIODIC_PULL_ALARM, { periodInMinutes });
}

chrome.storage.local.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !changes.pullIntervalMinutes) {
    return;
  }
  void schedulePeriodicPullAlarm().catch(error =>
    console.warn('根据新间隔重设定时同步失败:', error && error.message ? error.message : error)
  );
});

chrome.runtime.onInstalled.addListener(details => {
  void (async () => {
    if (details.reason === 'install') {
      const existing = await chrome.storage.local.get(['pullIntervalMinutes']);
      if (existing.pullIntervalMinutes === undefined) {
        await chrome.storage.local.set({ pullIntervalMinutes: DEFAULT_PULL_INTERVAL_MINUTES });
      }
    }
    await schedulePeriodicPullAlarm();
    if (details.reason === 'install') {
      raindropAPI.init().then(hasToken => {
        if (hasToken) {
          runSync().catch(error => console.warn('首次安装后自动同步失败:', error.message));
        }
      });
    }
  })();
});

chrome.runtime.onStartup.addListener(() => {
  void schedulePeriodicPullAlarm();
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name !== PERIODIC_PULL_ALARM) {
    return;
  }

  (async () => {
    try {
      await ensureInitialized();
      await syncEngine.periodicRaindropPull();
    } catch (error) {
      console.error('定时 Raindrop 拉取失败:', error);
    }
  })();
});

const bookmarkWorkQueue = [];
let bookmarkQueueProcessing = false;

function enqueueBookmarkWork(task) {
  bookmarkWorkQueue.push(task);
  void processBookmarkQueue();
}

async function processBookmarkQueue() {
  if (bookmarkQueueProcessing) {
    return;
  }
  bookmarkQueueProcessing = true;
  try {
    while (bookmarkWorkQueue.length > 0) {
      const task = bookmarkWorkQueue.shift();
      try {
        await task();
      } catch (error) {
        console.error('书签队列任务失败:', error);
      }
    }
  } finally {
    bookmarkQueueProcessing = false;
  }
}

// 立即注册消息监听器
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'exchangeToken') {
    console.log('Exchanging token for code:', request.code);

    // OAuth Step 3: 使用授权码换取 access_token
    fetch(OAUTH_CONFIG.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code: request.code,
        client_id: OAUTH_CONFIG.clientId,
        client_secret: OAUTH_CONFIG.clientSecret,
        redirect_uri: request.redirectUri
      })
    })
      .then(async (response) => {
        let data = {};
        try {
          data = await response.json();
        } catch (error) {
          data = {};
        }

        if (!response.ok) {
          throw new Error(data.error || data.message || `Token 交换失败 (${response.status})`);
        }

        if (!data.access_token) {
          throw new Error('Token 交换失败: 响应中缺少 access_token');
        }

        if (data.refresh_token && data.expires_in) {
          await chrome.storage.sync.set({
            raindropRefreshToken: data.refresh_token,
            tokenExpiresAt: Date.now() + (Number(data.expires_in) * 1000)
          });
        }

        sendResponse({ success: true, token: data.access_token });
      })
      .catch(error => {
        console.error('Error:', error);
        sendResponse({ success: false, error: error.message });
      });

    return true; // 保持消息通道开放
  }

  if (request.action === 'setToken') {
    chrome.storage.sync.set({ raindropToken: request.token })
      .then(async () => {
        await raindropAPI.init();
        sendResponse({ success: true });
      })
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (request.action === 'initSync') {
    runSync()
      .then(() => sendResponse({ success: true }))
      .catch(error => {
        console.error('手动同步失败:', error);
        sendResponse({ success: false, error: error.message });
      });
    return true;
  }

  /** 单次消息完成：写映射 + 全量同步，避免 popup 连发多条消息时 Worker 休眠断连 */
  if (request.action === 'manualSyncFull') {
    void (async () => {
      try {
        await persistSyncMappingsForManualSync(request.configs);
        await runSync();
        sendResponse({ success: true });
      } catch (error) {
        console.error('manualSyncFull 失败:', error);
        sendResponse({
          success: false,
          error: error && error.message ? error.message : String(error)
        });
      }
    })();
    return true;
  }

  if (request.action === 'getSyncConfig') {
    Promise.all([syncEngine.getSyncConfig(), syncEngine.getSyncConfigs()])
      .then(([config, configs]) => sendResponse({ success: true, config, configs }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (request.action === 'setSyncConfig') {
    const collectionId = request.raindropCollectionId;
    if (collectionId === null || collectionId === undefined || String(collectionId).trim() === '') {
      sendResponse({ success: false, error: '无效的 Raindrop 集合 ID' });
      return true;
    }

    const config = {
      chromeFolderId: request.chromeFolderId || '',
      raindropCollectionId: String(collectionId)
    };
    syncEngine.saveSyncConfig(config)
      .then(() => sendResponse({ success: true }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (request.action === 'setSyncConfigs') {
    const configs = Array.isArray(request.configs) ? request.configs : [];
    const normalized = normalizeSyncConfigsList(configs);

    if (configs.length > 0 && normalized.length === 0) {
      sendResponse({ success: false, error: '映射数据格式无效，未保存任何条目' });
      return true;
    }

    syncEngine
      .saveSyncConfigs(normalized)
      .then(() => sendResponse({ success: true, savedCount: normalized.length }))
      .catch(error => {
        console.error('setSyncConfigs 失败:', error);
        sendResponse({ success: false, error: error.message || String(error) });
      });
    return true;
  }

  if (request.action === 'setPullIntervalMinutes') {
    const minutes = clampPullIntervalMinutes(request.minutes);
    chrome.storage.local
      .set({ pullIntervalMinutes: minutes })
      .then(async () => {
        await schedulePeriodicPullAlarm();
        sendResponse({ success: true, pullIntervalMinutes: minutes });
      })
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (request.action === 'getPullIntervalMinutes') {
    chrome.storage.local
      .get(['pullIntervalMinutes'])
      .then(result => {
        const pullIntervalMinutes = clampPullIntervalMinutes(result.pullIntervalMinutes);
        sendResponse({
          success: true,
          pullIntervalMinutes,
          minMinutes: MIN_PULL_INTERVAL_MINUTES,
          maxMinutes: MAX_PULL_INTERVAL_MINUTES,
          defaultMinutes: DEFAULT_PULL_INTERVAL_MINUTES
        });
      })
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  console.warn('background: 未识别的 message.action', request && request.action);
  sendResponse({
    success: false,
    error: `未知操作: ${request && request.action ? request.action : '(无 action)'}`
  });
  return false;
});

console.log('Message listener registered!');

chrome.bookmarks.onCreated.addListener((id, bookmark) => {
  enqueueBookmarkWork(async () => {
    try {
      await ensureInitialized();
      await syncEngine.syncChromeToRaindrop(bookmark);
    } catch (error) {
      console.error('onCreated 同步失败:', error);
    }
  });
});

chrome.bookmarks.onChanged.addListener((id, changeInfo) => {
  enqueueBookmarkWork(async () => {
    try {
      await ensureInitialized();
      const nodes = await chrome.bookmarks.get(id);
      if (nodes && nodes[0] && nodes[0].url) {
        await syncEngine.syncChromeToRaindrop(nodes[0]);
      }
    } catch (error) {
      console.error('onChanged 同步失败:', error);
    }
  });
});

chrome.bookmarks.onRemoved.addListener(id => {
  enqueueBookmarkWork(async () => {
    try {
      await ensureInitialized();
      await syncEngine.deleteFromRaindrop(id);
    } catch (error) {
      console.error('onRemoved 同步失败:', error);
    }
  });
});
