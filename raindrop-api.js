const API_BASE = 'https://api.raindrop.io/rest/v1';

class RaindropAPI {
  constructor() {
    this.token = null;
  }

  async init() {
    const result = await chrome.storage.sync.get(['raindropToken']);
    this.token = result.raindropToken;
    return !!this.token;
  }

  async authenticate() {
    return new Promise((resolve, reject) => {
      const redirectUri = chrome.identity.getRedirectURL('oauth2');
      console.log('Redirect URI:', redirectUri);

      // OAuth Step 1: 跳转授权页
      const authUrl = `${OAUTH_CONFIG.authUrl}?` +
        `response_type=code&` +
        `client_id=${encodeURIComponent(OAUTH_CONFIG.clientId)}&` +
        `redirect_uri=${encodeURIComponent(redirectUri)}`;

      console.log('Auth URL:', authUrl);

      chrome.identity.launchWebAuthFlow(
        {
          url: authUrl,
          interactive: true
        },
        async (redirectUrl) => {
          if (chrome.runtime.lastError) {
            console.error('OAuth error:', chrome.runtime.lastError);
            const msg = chrome.runtime.lastError.message || '';
            if (msg.includes('did not approve access')) {
              reject(new Error('用户取消或未授权应用。请在授权页点击 Allow，并确认 Raindrop 应用中已配置该 redirect_uri。'));
              return;
            }
            reject(new Error(msg));
            return;
          }

          if (!redirectUrl) {
            reject(new Error('未获取到授权码'));
            return;
          }

          console.log('Redirect URL:', redirectUrl);

          try {
            const url = new URL(redirectUrl);
            const oauthError = url.searchParams.get('error');
            if (oauthError) {
              reject(new Error(`OAuth 授权失败: ${oauthError}`));
              return;
            }

            const code = url.searchParams.get('code');

            if (!code) {
              reject(new Error('授权码不存在，请检查 redirect_uri 配置是否与 Raindrop 应用设置完全一致'));
              return;
            }

            console.log('Authorization code:', code);

            // 通过后台服务交换 token（避免 CORS）
            console.log('Sending message to background...');

            try {
              const response = await chrome.runtime.sendMessage({
                action: 'exchangeToken',
                code: code,
                redirectUri: redirectUri
              });

              console.log('Response from background:', response);

              if (response && response.success) {
                await this.setToken(response.token);
                resolve(response.token);
              } else {
                reject(new Error(response ? response.error : '未收到响应'));
              }
            } catch (error) {
              console.error('Message sending error:', error);
              reject(error);
            }
          } catch (error) {
            console.error('Token exchange error:', error);
            reject(error);
          }
        }
      );
    });
  }

  async setToken(token) {
    this.token = token;
    await chrome.storage.sync.set({ raindropToken: token });
  }

  async refreshAccessTokenIfNeeded() {
    const { raindropRefreshToken, tokenExpiresAt } = await chrome.storage.sync.get([
      'raindropRefreshToken',
      'tokenExpiresAt'
    ]);

    if (!raindropRefreshToken || !tokenExpiresAt) {
      return;
    }

    // 提前 60 秒刷新，避免请求过程中过期
    if (Date.now() < (Number(tokenExpiresAt) - 60000)) {
      return;
    }

    const response = await fetch(OAUTH_CONFIG.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: raindropRefreshToken,
        client_id: OAUTH_CONFIG.clientId,
        client_secret: OAUTH_CONFIG.clientSecret
      })
    });

    let data = {};
    try {
      data = await response.json();
    } catch (error) {
      data = {};
    }

    if (!response.ok || !data.access_token) {
      throw new Error(data.error || data.message || '刷新 access_token 失败');
    }

    this.token = data.access_token;
    await chrome.storage.sync.set({
      raindropToken: data.access_token,
      raindropRefreshToken: data.refresh_token || raindropRefreshToken,
      tokenExpiresAt: data.expires_in ? Date.now() + (Number(data.expires_in) * 1000) : tokenExpiresAt
    });
  }

  async exchangeCodeForToken(code, redirectUri) {
    console.log('Exchanging code for token...');
    console.log('Code:', code);
    console.log('Redirect URI:', redirectUri);

    const response = await fetch(OAUTH_CONFIG.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code: code,
        client_id: OAUTH_CONFIG.clientId,
        client_secret: OAUTH_CONFIG.clientSecret,
        redirect_uri: redirectUri
      })
    });

    console.log('Token response status:', response.status);

    if (!response.ok) {
      let errorMsg = response.statusText;
      try {
        const error = await response.json();
        console.error('Token error response:', error);
        errorMsg = error.error || error.message || errorMsg;
      } catch (e) {
        const text = await response.text();
        console.error('Token error text:', text);
        errorMsg = text || errorMsg;
      }
      throw new Error(`获取 Token 失败: ${errorMsg}`);
    }

    const data = await response.json();
    console.log('Token data received:', data);

    // 保存 refresh_token 以便将来刷新
    if (data.refresh_token) {
      await chrome.storage.sync.set({
        raindropRefreshToken: data.refresh_token,
        tokenExpiresAt: Date.now() + (data.expires_in * 1000)
      });
    }

    return data.access_token;
  }

  async request(endpoint, options = {}) {
    if (!this.token) {
      throw new Error('未设置 API Token');
    }

    await this.refreshAccessTokenIfNeeded();

    const url = `${API_BASE}${endpoint}`;
    const config = {
      ...options,
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        ...options.headers
      }
    };

    const maxAttempts = 4;
    let attempt = 0;
    let delay = 1000;

    while (attempt < maxAttempts) {
      attempt++;
      try {
        const response = await fetch(url, config);

        if (response.status === 429) {
          if (attempt >= maxAttempts) {
            throw new Error('API 速率限制：已达到最大重试次数');
          }
          console.warn('速率限制，等待重试...');
          await this.sleep(delay);
          delay = Math.min(delay * 2, 60000);
          continue;
        }

        const data = await this.parseJsonResponse(response);
        if (!response.ok) {
          const errorMsg = (data && (data.error || data.message)) || response.statusText || `HTTP ${response.status}`;
          throw new Error(`API 错误: ${errorMsg}`);
        }

        this.assertRaindropOk(data);
        return data;
      } catch (error) {
        if (attempt >= maxAttempts) {
          throw error;
        }

        const msg = error && error.message ? String(error.message) : '';
        const isNetwork =
          error instanceof TypeError ||
          msg.includes('Failed to fetch') ||
          msg.includes('NetworkError');

        if (!isNetwork) {
          throw error;
        }

        console.warn('网络请求失败，重试中...', error);
        await this.sleep(delay);
        delay = Math.min(delay * 2, 30000);
      }
    }

    throw new Error('请求失败：已达到最大重试次数');
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async parseJsonResponse(response) {
    const rawText = await response.text();
    if (!rawText) {
      return {};
    }

    try {
      return JSON.parse(rawText);
    } catch (error) {
      const textPreview = rawText.slice(0, 120).replace(/\s+/g, ' ');
      throw new Error(`响应不是有效 JSON (HTTP ${response.status}): ${textPreview}`);
    }
  }

  assertRaindropOk(data) {
    if (!data || typeof data !== 'object' || !('result' in data)) {
      return;
    }
    if (data.result === false) {
      const msg = data.errorMessage || data.error || data.message || 'Raindrop API 返回失败';
      throw new Error(msg);
    }
  }

  extractItemsArray(data) {
    if (!data || typeof data !== 'object') {
      return [];
    }
    if (Array.isArray(data.items)) {
      return data.items;
    }
    if (Array.isArray(data)) {
      return data;
    }
    return [];
  }

  async getRaindrops(collectionId = 0, page = 0) {
    const data = await this.request(`/raindrops/${collectionId}?perpage=50&page=${page}`);
    return this.extractItemsArray(data);
  }

  async getAllRaindrops(collectionId = -1) {
    let allRaindrops = [];
    let page = 0;
    let hasMore = true;

    while (hasMore) {
      const raindrops = await this.getRaindrops(collectionId, page);
      allRaindrops = allRaindrops.concat(raindrops);
      hasMore = raindrops.length === 50;
      page++;
    }

    return allRaindrops;
  }

  async createRaindrop(data) {
    return await this.request('/raindrop', {
      method: 'POST',
      body: JSON.stringify(data)
    });
  }

  async updateRaindrop(id, data) {
    return await this.request(`/raindrop/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data)
    });
  }

  async deleteRaindrop(id) {
    return await this.request(`/raindrop/${id}`, {
      method: 'DELETE'
    });
  }

  async getCollections() {
    const data = await this.request('/collections');
    return this.extractItemsArray(data);
  }

  /**
   * 官方文档要求分别请求根集合与子集合后自行组装树结构；
   * /collections/nested 不在公开文档中，且可能对部分账号返回空数组导致界面无任何集合。
   */
  async getCollectionsNested() {
    const rootData = await this.request('/collections');
    const roots = this.extractItemsArray(rootData);

    let children = [];
    try {
      const childData = await this.request('/collections/childrens');
      children = this.extractItemsArray(childData);
    } catch (error) {
      console.warn('获取子集合失败，仅展示根级集合:', error.message);
    }

    return this.mergeCollectionsTree(roots, children);
  }

  mergeCollectionsTree(roots, children) {
    const nodeMap = new Map();

    const asTreeNode = (item) => ({ ...item, children: [] });

    for (const item of roots) {
      if (item && item._id != null) {
        nodeMap.set(item._id, asTreeNode(item));
      }
    }
    for (const item of children) {
      if (!item || item._id == null) continue;
      const existing = nodeMap.get(item._id);
      const next = asTreeNode(item);
      if (existing && existing.children && existing.children.length > 0) {
        next.children = existing.children;
      }
      nodeMap.set(item._id, next);
    }

    const output = [];
    for (const node of nodeMap.values()) {
      const parentId = this.extractParentId(node.parent);
      if (parentId != null && nodeMap.has(parentId)) {
        nodeMap.get(parentId).children.push(node);
      } else {
        output.push(node);
      }
    }

    this.sortCollectionsByRaindropOrder(output);
    return output;
  }

  sortCollectionsByRaindropOrder(nodes) {
    if (!Array.isArray(nodes) || nodes.length === 0) {
      return;
    }
    nodes.sort((a, b) => (Number(b.sort) || 0) - (Number(a.sort) || 0));
    for (const node of nodes) {
      if (node.children && node.children.length > 0) {
        this.sortCollectionsByRaindropOrder(node.children);
      }
    }
  }

  extractParentId(parent) {
    if (parent === undefined || parent === null || parent === '') {
      return null;
    }
    if (typeof parent === 'number') {
      return parent === 0 ? null : parent;
    }
    if (typeof parent === 'string') {
      const n = Number(parent);
      return n === 0 || Number.isNaN(n) ? null : n;
    }
    if (typeof parent === 'object') {
      if (parent.$id !== undefined && parent.$id !== null) {
        const n = Number(parent.$id);
        return n === 0 || Number.isNaN(n) ? null : n;
      }
      if (parent._id !== undefined && parent._id !== null) {
        const n = Number(parent._id);
        return n === 0 || Number.isNaN(n) ? null : n;
      }
    }
    return null;
  }

  async createCollection(data) {
    return await this.request('/collection', {
      method: 'POST',
      body: JSON.stringify(data)
    });
  }

  async updateCollection(id, data) {
    return await this.request(`/collection/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data)
    });
  }

  async deleteCollection(id) {
    return await this.request(`/collection/${id}`, {
      method: 'DELETE'
    });
  }
}
