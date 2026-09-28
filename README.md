# 实验档案

Windows 个人离线实验原始数据与记录管理工具。使用说明见 [docs/使用说明.md](docs/使用说明.md)。

本次交付版本为 1.0.0，安装包为 `release/LabArchive-Setup-1.0.0-x64.exe`，可作为 GitHub Release 附件分发。安装后的日常使用不需要开发环境。含本机实验路径和实际 WB 截图的验收材料仅保存在本地交付包，不随源码仓库上传。

## 开发

Node.js 24.x；Windows x64。依赖锁定在 package-lock.json。

```powershell
npm ci
# Electron 44 的安装包按需下载；首次使用时执行：
node node_modules/electron/install.js
npm run dev
```

```powershell
npm test
npm run build
npm run package
```

Electron 主进程通过白名单 IPC 提供 Catalog 与 StorageService 功能；渲染进程不直接访问 Node 或文件系统。数据库使用 Electron 自带 Node 的 node:sqlite。Sharp 负责显示预览，源文件保持原字节。

文件夹结构：`electron` 为数据核心与桌面集成；`shared` 为接口类型；`src` 为中文界面；`tests` 为完整性测试；`scripts` 为构建及隔离验收工具；`release` 为本机打包产物。安装包不包含测试资料库、真实实验样例和开发服务器。

本机验收脚本与结果包含具体实验文件路径及图片，仅留在本地，不随源码仓库或安装包发布。仓库中的 `tests` 使用模拟文件验证核心行为。

资料库中所有成功导入文件仅追加；文件隐藏使用可恢复的归档状态。扫描/导入/维护互斥，复制、哈希和预览均为异步任务。备份通过 SQLite snapshot 和独立文件校验生成，恢复检查库内引用与清单一致性。
