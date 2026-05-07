/**
 * Chrome 书签 ↔ Raindrop 同步引擎（Manifest V3 Service Worker）
 * 契约：background.js / popup.js 依赖的公开方法与 storage 键名保持不变。
 */

const BOOKMARK_MAPPINGS_KEY = 'bookmarkMappings';

class SyncEngine {
  constructor(api) {
    this.api = api;
  }

  /* ---------- 配置读写 ---------- */

  async getSyncConfig() {
    const result = await chrome.storage.local.get(['syncConfig']);
    const fallback = {
      chromeFolderId: '',
      raindropCollectionId: '0'
    };
    return result.syncConfig && typeof result.syncConfig === 'object'
      ? { ...fallback, ...result.syncConfig }
      : fallback;
  }

  async saveSyncConfig(config) {
    await chrome.storage.local.set({ syncConfig: config });
  }

  async getSyncConfigs() {
    const result = await chrome.storage.local.get(['syncConfigs']);
    if (!Object.prototype.hasOwnProperty.call(result, 'syncConfigs')) {
      return [];
    }
    return Array.isArray(result.syncConfigs) ? result.syncConfigs : [];
  }

  async saveSyncConfigs(configs) {
    if (!configs || configs.length === 0) {
      await chrome.storage.local.remove('syncConfigs');
      return;
    }
    await chrome.storage.local.set({ syncConfigs: configs });
  }

  /**
   * 优先多条 syncConfigs；若键存在但无效则清理并回退单条 syncConfig（兼容旧数据）。
   */
  async getEffectiveSyncConfigs() {
    const result = await chrome.storage.local.get(['syncConfigs', 'syncConfig']);
    const hasMultiKey = Object.prototype.hasOwnProperty.call(result, 'syncConfigs');

    if (hasMultiKey) {
      const rawList = Array.isArray(result.syncConfigs) ? result.syncConfigs : [];
      const filtered = rawList
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

      if (filtered.length > 0) {
        return filtered;
      }
      await chrome.storage.local.remove('syncConfigs');
    }

    const singleConfig = result.syncConfig || (await this.getSyncConfig());
    if (
      singleConfig.chromeFolderId !== undefined &&
      singleConfig.chromeFolderId !== null &&
      String(singleConfig.chromeFolderId).trim() !== '' &&
      singleConfig.raindropCollectionId !== null &&
      singleConfig.raindropCollectionId !== undefined
    ) {
      return [
        {
          chromeFolderId: String(singleConfig.chromeFolderId),
          raindropCollectionId: String(singleConfig.raindropCollectionId)
        }
      ];
    }

    return [];
  }

  /* ---------- 映射表 ---------- */

  async loadBookmarkMappings() {
    const result = await chrome.storage.local.get([BOOKMARK_MAPPINGS_KEY]);
    const raw = result[BOOKMARK_MAPPINGS_KEY];
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw } : {};
  }

  async saveBookmarkMappings(map) {
    await chrome.storage.local.set({ [BOOKMARK_MAPPINGS_KEY]: map });
  }

  async setChromeRaindropPair(chromeBookmarkId, raindropId) {
    const map = await this.loadBookmarkMappings();
    map[String(chromeBookmarkId)] = String(raindropId);
    await this.saveBookmarkMappings(map);
  }

  async removeChromeMapping(chromeBookmarkId) {
    const map = await this.loadBookmarkMappings();
    const key = String(chromeBookmarkId);
    if (!Object.prototype.hasOwnProperty.call(map, key)) {
      return null;
    }
    const rd = map[key];
    delete map[key];
    await this.saveBookmarkMappings(map);
    return rd;
  }

  async pruneStaleMappings() {
    const map = await this.loadBookmarkMappings();
    let changed = false;
    for (const chromeId of Object.keys(map)) {
      const node = await this.getBookmarkNode(chromeId);
      if (!node) {
        delete map[chromeId];
        changed = true;
      }
    }
    if (changed) {
      await this.saveBookmarkMappings(map);
    }
  }

  /* ---------- 同步状态（popup 读取） ---------- */

  async touchSyncSuccess() {
    await chrome.storage.local.set({
      lastSyncTime: Date.now(),
      syncStatus: 'success',
      lastError: ''
    });
  }

  async touchSyncError(message) {
    await chrome.storage.local.set({
      lastSyncTime: Date.now(),
      syncStatus: 'error',
      lastError: String(message || '未知错误')
    });
  }

  /* ---------- 初始化与定时拉取 ---------- */

  async initSync() {
    let hadError = false;
    let lastMessage = '';

    try {
      await this.pruneStaleMappings();
      const syncConfigs = await this.getEffectiveSyncConfigs();

      if (syncConfigs.length === 0) {
        console.warn('SyncEngine: 未配置有效的 Chrome 文件夹与 Raindrop 集合映射，跳过同步');
        await this.touchSyncError('未配置同步映射');
        return;
      }

      console.log(
        'SyncEngine: 开始全量同步，映射:',
        syncConfigs.map(c => `${c.chromeFolderId}→${c.raindropCollectionId}`).join(', ')
      );

      for (const syncConfig of syncConfigs) {
        try {
          const folderNodes = await chrome.bookmarks.getSubTree(syncConfig.chromeFolderId);
          if (!folderNodes || !folderNodes[0]) {
            console.warn('SyncEngine: 跳过不存在的 Chrome 文件夹:', syncConfig.chromeFolderId);
            continue;
          }
          await this.syncBookmarkTree(folderNodes[0], syncConfig);
          await this.syncRaindropToChrome(syncConfig);
        } catch (configError) {
          hadError = true;
          lastMessage = configError && configError.message ? configError.message : String(configError);
          console.error('SyncEngine: 单条映射同步失败，继续下一条:', syncConfig, configError);
        }
      }

      if (hadError) {
        await this.touchSyncError(lastMessage || '部分映射同步失败');
      } else {
        await this.touchSyncSuccess();
      }
    } catch (error) {
      const msg = error && error.message ? error.message : String(error);
      console.error('SyncEngine: initSync 失败:', error);
      await this.touchSyncError(msg);
    }
  }

  async periodicRaindropPull() {
    const syncConfigs = await this.getEffectiveSyncConfigs();
    if (syncConfigs.length === 0) {
      return;
    }

    let hadError = false;
    let lastMessage = '';

    for (const syncConfig of syncConfigs) {
      try {
        await this.syncRaindropToChrome(syncConfig);
      } catch (error) {
        hadError = true;
        lastMessage = error && error.message ? error.message : String(error);
        console.error('SyncEngine: 定时拉取单条映射失败:', syncConfig, error);
      }
    }

    if (hadError) {
      await this.touchSyncError(lastMessage || '定时拉取失败');
    } else {
      await this.touchSyncSuccess();
    }
  }

  /* ---------- Chrome → Raindrop（整棵树） ---------- */

  async syncBookmarkTree(node, syncConfig, raindropsByNormalizedUrl = null) {
    const index =
      raindropsByNormalizedUrl ||
      (await this.buildRaindropsUrlIndex(syncConfig.raindropCollectionId));

    if (node.url) {
      await this.syncChromeNodeToRaindrop(node, syncConfig, index);
    }

    const children = node.children || [];
    for (const child of children) {
      await this.syncBookmarkTree(child, syncConfig, index);
    }
  }

  /**
   * background 书签事件入口：单节点，自动解析所属映射。
   */
  async syncChromeToRaindrop(bookmark, forcedSyncConfig = null) {
    if (!bookmark || !bookmark.url) {
      return;
    }

    const syncConfig = forcedSyncConfig || (await this.getSyncConfigForBookmark(bookmark));
    if (!syncConfig) {
      return;
    }

    if (
      forcedSyncConfig &&
      !(
        this.normalizeFolderId(syncConfig.chromeFolderId) ===
          this.normalizeFolderId(forcedSyncConfig.chromeFolderId) &&
        String(syncConfig.raindropCollectionId) === String(forcedSyncConfig.raindropCollectionId)
      )
    ) {
      return;
    }

    if (!(await this.shouldSyncBookmark(bookmark, syncConfig))) {
      return;
    }

    const index = await this.buildRaindropsUrlIndex(syncConfig.raindropCollectionId);
    await this.syncChromeNodeToRaindrop(bookmark, syncConfig, index);
  }

  async syncChromeNodeToRaindrop(bookmark, syncConfig, urlIndex) {
    const collectionId = String(syncConfig.raindropCollectionId);
    const mappings = await this.loadBookmarkMappings();
    const chromeId = String(bookmark.id);
    const normUrl = this.normalizeUrl(bookmark.url);
    const title = bookmark.title || '';

    let raindropId = mappings[chromeId] ? String(mappings[chromeId]) : null;

    if (!raindropId) {
      const byUrl = urlIndex.get(normUrl);
      if (byUrl && byUrl._id != null) {
        raindropId = String(byUrl._id);
      }
    }

    const collectionRef = this.collectionRef(collectionId);

    try {
      if (raindropId) {
        await this.api.updateRaindrop(Number(raindropId), {
          title,
          link: bookmark.url,
          collection: collectionRef
        });
        await this.setChromeRaindropPair(chromeId, raindropId);
        urlIndex.set(normUrl, { _id: Number(raindropId), link: bookmark.url, title });
        return;
      }

      const created = await this.api.createRaindrop({
        title,
        link: bookmark.url,
        collection: collectionRef
      });

      const newId = this.extractRaindropId(created);
      if (newId == null) {
        throw new Error('创建 Raindrop 书签后无法解析 _id');
      }
      await this.setChromeRaindropPair(chromeId, String(newId));
      urlIndex.set(normUrl, { _id: Number(newId), link: bookmark.url, title });
    } catch (error) {
      console.error('SyncEngine: Chrome→Raindrop 同步失败:', bookmark && bookmark.url, error);
      throw error;
    }
  }

  async deleteFromRaindrop(chromeBookmarkId) {
    const raindropId = await this.removeChromeMapping(chromeBookmarkId);
    if (!raindropId) {
      return;
    }
    try {
      await this.api.deleteRaindrop(Number(raindropId));
    } catch (error) {
      console.warn('SyncEngine: 删除 Raindrop 书签失败（可能已不存在）:', raindropId, error.message);
    }
  }

  /* ---------- Raindrop → Chrome ---------- */

  async syncRaindropToChrome(syncConfig) {
    const folderId = syncConfig.chromeFolderId;
    const collectionId = syncConfig.raindropCollectionId;

    const folderRoot = await this.getBookmarkNode(folderId);
    if (!folderRoot) {
      console.warn('SyncEngine: Raindrop→Chrome 跳过，文件夹不存在:', folderId);
      return;
    }

    const raindrops = await this.api.getAllRaindrops(collectionId);
    const mappings = await this.loadBookmarkMappings();
    const { raindropToChrome, urlToChrome } = await this.buildSubtreeLookup(folderId, mappings);

    for (const rd of raindrops) {
      if (!rd || rd.link == null || String(rd.link).trim() === '') {
        continue;
      }

      const rdKey = String(rd._id);
      const norm = this.normalizeUrl(rd.link);
      let chromeNode = raindropToChrome.get(rdKey);

      if (!chromeNode) {
        const candidate = urlToChrome.get(norm);
        if (candidate) {
          await this.setChromeRaindropPair(candidate.id, rdKey);
          chromeNode = candidate;
          raindropToChrome.set(rdKey, candidate);
        }
      }

      if (chromeNode) {
        const needsTitle = (chromeNode.title || '') !== (rd.title || '');
        const needsUrl = (chromeNode.url || '') !== rd.link;
        if (needsTitle || needsUrl) {
          await new Promise((resolve, reject) => {
            chrome.bookmarks.update(
              chromeNode.id,
              {
                ...(needsTitle ? { title: rd.title || '' } : {}),
                ...(needsUrl ? { url: rd.link } : {})
              },
              () => {
                if (chrome.runtime.lastError) {
                  reject(new Error(chrome.runtime.lastError.message));
                  return;
                }
                resolve();
              }
            );
          });
        }
        continue;
      }

      const created = await new Promise((resolve, reject) => {
        chrome.bookmarks.create(
          {
            parentId: folderId,
            title: rd.title || '',
            url: rd.link
          },
          node => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
              return;
            }
            resolve(node);
          }
        );
      });

      await this.setChromeRaindropPair(created.id, rdKey);
      raindropToChrome.set(rdKey, created);
      urlToChrome.set(norm, created);
    }
  }

  /* ---------- 规则与索引 ---------- */

  async shouldSyncBookmark(bookmark, syncConfig = null) {
    const target = syncConfig || (await this.getSyncConfigForBookmark(bookmark));
    if (!target || !bookmark || !bookmark.url) {
      return false;
    }
    const parentId = bookmark.parentId;
    if (!parentId) {
      return false;
    }
    const depth = await this.depthFromParentToFolder(parentId, target.chromeFolderId);
    return depth >= 0;
  }

  async getSyncConfigForBookmark(bookmark) {
    if (!bookmark || !bookmark.parentId) {
      return null;
    }
    const configs = await this.getEffectiveSyncConfigs();
    if (configs.length === 0) {
      return null;
    }

    let best = null;
    let bestDepth = Infinity;

    for (const config of configs) {
      const depth = await this.depthFromParentToFolder(bookmark.parentId, config.chromeFolderId);
      if (depth >= 0 && depth < bestDepth) {
        bestDepth = depth;
        best = config;
      }
    }

    return best;
  }

  async getCollectionForBookmark(bookmark, syncConfig = null) {
    const target = syncConfig || (await this.getSyncConfigForBookmark(bookmark));
    if (!target) {
      return null;
    }
    if (target.raindropCollectionId !== null && target.raindropCollectionId !== undefined) {
      return String(target.raindropCollectionId);
    }
    return null;
  }

  async buildRaindropsUrlIndex(collectionId) {
    const items = await this.api.getAllRaindrops(collectionId);
    const map = new Map();
    for (const item of items) {
      if (!item || item.link == null) {
        continue;
      }
      const key = this.normalizeUrl(item.link);
      if (!map.has(key)) {
        map.set(key, item);
      }
    }
    return map;
  }

  normalizeFolderId(id) {
    if (id === undefined || id === null) {
      return '';
    }
    return String(id).trim();
  }

  normalizeUrl(url) {
    if (!url || typeof url !== 'string') {
      return '';
    }
    try {
      const u = new URL(url.trim());
      u.hash = '';
      let href = u.href;
      if (href.length > 1 && href.endsWith('/')) {
        href = href.slice(0, -1);
      }
      return href;
    } catch {
      return url.trim();
    }
  }

  collectionRef(collectionIdStr) {
    const n = Number(collectionIdStr);
    const id = Number.isFinite(n) ? n : 0;
    return { $id: id };
  }

  extractRaindropId(createResponse) {
    if (!createResponse || typeof createResponse !== 'object') {
      return null;
    }
    if (createResponse.item && createResponse.item._id != null) {
      return createResponse.item._id;
    }
    if (createResponse._id != null) {
      return createResponse._id;
    }
    return null;
  }

  /* ---------- Chrome API 封装 ---------- */

  getBookmarkNode(id) {
    return new Promise(resolve => {
      chrome.bookmarks.get(String(id), nodes => {
        if (chrome.runtime.lastError || !nodes || !nodes[0]) {
          resolve(null);
          return;
        }
        resolve(nodes[0]);
      });
    });
  }

  async depthFromParentToFolder(startParentId, targetFolderId) {
    const target = this.normalizeFolderId(targetFolderId);
    let current = this.normalizeFolderId(startParentId);
    let depth = 0;

    while (current) {
      if (current === target) {
        return depth;
      }
      const node = await this.getBookmarkNode(current);
      if (!node || !node.parentId) {
        break;
      }
      current = this.normalizeFolderId(node.parentId);
      depth++;
    }

    return -1;
  }

  async buildSubtreeLookup(folderId, mappings) {
    const raindropToChrome = new Map();
    const urlToChrome = new Map();

    const tree = await chrome.bookmarks.getSubTree(String(folderId));
    if (!tree || !tree[0]) {
      return { raindropToChrome, urlToChrome };
    }

    const walk = node => {
      if (node.url) {
        const norm = this.normalizeUrl(node.url);
        if (!urlToChrome.has(norm)) {
          urlToChrome.set(norm, node);
        }
        const rd = mappings[String(node.id)];
        if (rd) {
          raindropToChrome.set(String(rd), node);
        }
      }
      for (const child of node.children || []) {
        walk(child);
      }
    };

    walk(tree[0]);
    return { raindropToChrome, urlToChrome };
  }
}
