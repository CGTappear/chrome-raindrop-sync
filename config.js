// OAuth 配置文件
// 注意：此文件包含敏感信息，不应提交到公共代码仓库

const OAUTH_CONFIG = {
  // 从你的 Raindrop 应用设置中获取的真实凭证
  clientId: '69f88a8a6a3d3cb2208f4ebb',
  clientSecret: '59ba2ded-7916-42f1-aea9-d82af7572f5b',

  // Chrome 扩展的重定向 URI（自动生成）
  redirectUri: '', // 将在运行时自动设置

  // Raindrop OAuth 端点
  authUrl: 'https://raindrop.io/oauth/authorize',
  tokenUrl: 'https://raindrop.io/oauth/access_token'
};

// 导出配置（如果在模块环境中）
if (typeof module !== 'undefined' && module.exports) {
  module.exports = OAUTH_CONFIG;
}
