# Chrome Raindrop Sync

Chrome 书签与 Raindrop.io 自动实时双向同步扩展。

## 功能特性

- ✅ **实时同步**：自动监听 Chrome 书签变化并同步到 Raindrop
- ✅ **双向同步**：定期从 Raindrop 同步书签到 Chrome
- ✅ **文件夹映射**：Chrome 文件夹自动映射为 Raindrop 集合
- ✅ **智能重试**：网络错误和速率限制自动重试
- ✅ **同步队列**：批量处理避免并发冲突
- ✅ **友好界面**：简洁的配置和状态显示

## 安装步骤

### 1. 获取 Raindrop API Token

1. 访问 [Raindrop 设置页面](https://app.raindrop.io/settings/integrations)
2. 创建新的集成应用或使用现有应用
3. 复制 Test Token（用于测试）或完成 OAuth 流程获取正式 Token

### 2. 安装扩展

1. 下载或克隆此项目到本地
2. 打开 Chrome 浏览器，访问 `chrome://extensions/`
3. 开启右上角的"开发者模式"
4. 点击"加载已解压的扩展程序"
5. 选择项目的 `chrome-raindrop-sync` 文件夹

### 3. 配置扩展

1. 点击浏览器工具栏中的扩展图标
2. 在弹出窗口中输入你的 Raindrop API Token
3. 点击"保存 Token"
4. 扩展会自动开始初始同步

## 使用说明

### 自动同步

安装配置完成后，扩展会自动工作：

- **Chrome → Raindrop**：当你在 Chrome 中添加、修改或删除书签时，变化会立即同步到 Raindrop
- **Raindrop → Chrome**：扩展每 5 分钟自动从 Raindrop 获取新书签并同步到 Chrome

### 手动同步

如果需要立即同步，可以：

1. 点击扩展图标打开配置界面
2. 点击"立即同步"按钮
3. 查看同步日志了解同步状态

## 技术架构

### 核心组件

- **manifest.json**：扩展配置文件（Manifest V3）
- **background.js**：后台服务，监听书签事件
- **raindrop-api.js**：Raindrop API 客户端
- **sync-engine.js**：同步引擎，处理数据映射
- **popup.html/js/css**：配置界面

### 同步机制

1. **Chrome → Raindrop**
   - 监听 `chrome.bookmarks` API 事件
   - 使用队列批量处理避免并发
   - 自动创建或更新 Raindrop 书签

2. **Raindrop → Chrome**
   - 定时轮询 Raindrop API
   - 比较本地映射表检测新书签
   - 自动创建 Chrome 书签

3. **数据映射**
   - Chrome 书签 ID ↔ Raindrop 书签 ID
   - Chrome 文件夹 ID ↔ Raindrop 集合 ID
   - 映射关系存储在 `chrome.storage.local`

## 注意事项

1. **API 速率限制**：Raindrop API 有速率限制，扩展已实现自动重试机制
2. **首次同步**：首次使用时会同步所有现有书签，可能需要一些时间
3. **冲突处理**：默认 Chrome 优先，即 Chrome 的变化会覆盖 Raindrop
4. **Token 安全**：Token 存储在 Chrome 的加密存储中，请勿分享给他人

## 常见问题

### Q: 同步失败怎么办？

A: 检查以下几点：
- API Token 是否正确
- 网络连接是否正常
- 查看扩展的同步日志了解具体错误

### Q: 可以选择性同步某些文件夹吗？

A: 当前版本同步所有书签，后续版本会添加选择性同步功能

### Q: 会同步书签的标签和备注吗？

A: 当前版本只同步标题和 URL，后续版本会支持标签和备注

## 开发计划

- [ ] 支持 OAuth 认证流程
- [ ] 选择性同步（排除某些文件夹）
- [ ] 同步书签标签和备注
- [ ] 冲突解决策略配置
- [ ] 同步历史记录
- [ ] 导入/导出配置

## 许可证

MIT License

## 贡献

欢迎提交 Issue 和 Pull Request！

## 相关链接

- [Raindrop.io 官网](https://raindrop.io/)
- [Raindrop API 文档](https://developer.raindrop.io/)
- [Chrome Extensions 文档](https://developer.chrome.com/docs/extensions/)
