# GitHub Actions 自动化发布流程

这个工作流程会在推送版本标签时自动构建和发布 Cursor Usage Monitor 扩展到 VSCode 插件市场。

## 触发条件

当推送符合 `v*.*.*` 格式的标签时（例如 `v1.0.1`），工作流程会自动执行。

## 发布步骤

1. **创建新版本标签**
   ```bash
   git tag v1.0.1
   git push origin v1.0.1
   ```

2. **自动化流程会执行以下操作**：
   - 检出代码
   - 设置 Node.js 环境
   - 安装依赖
   - 打包扩展 (包含编译)
   - 创建 GitHub Release
   - 发布到 VSCode Marketplace
   - 发布到 OpenVSX Registry

## 必需的 GitHub Secrets

在 GitHub 仓库设置中需要配置以下 secrets：

### VSCE_PAT (VSCode Marketplace)
1. 访问 [Azure DevOps](https://dev.azure.com/)
2. 创建个人访问令牌 (Personal Access Token)
3. 权限设置为 **Marketplace (Manage)**
4. 在 GitHub 仓库的 Settings > Secrets and variables > Actions 中添加 `VSCE_PAT`

### OVSX_PAT (OpenVSX Registry)
1. 访问 [OpenVSX Registry](https://open-vsx.org/)
2. 注册账户并创建访问令牌
3. 在 GitHub 仓库的 Settings > Secrets and variables > Actions 中添加 `OVSX_PAT`

## 版本管理

- 确保 `package.json` 中的版本号与标签版本号一致
- 遵循语义化版本控制 (Semantic Versioning)
- 主版本号.次版本号.修订号 (例如: 1.0.1)

## 注意事项

- 推送标签前请确保代码已经测试完毕
- 发布是不可逆的，请谨慎操作
- 如果发布失败，检查 Actions 日志获取详细错误信息
