# omp-config

个人 [Oh My Pi (omp)](https://github.com/can1357/oh-my-pi) 配置仓库，用于在多台机器之间同步配置、技能和子代理。

## 包含什么

- **OMP 配置**：模型角色、模型提供商、终端界面、长期记忆和 MCP 设置。
- **技能与子代理**：包括代码知识图谱工具和 Ego Browser 技能；浏览器操作默认优先使用 Ego Lite。
- **同步工具**：Windows PowerShell 部署、可选的本机配置反向导出，以及只读健康检查。
- **Ego Browser 启动器**：Windows 版本无关启动器，避免依赖可能过期的版本目录链接；需在每台机器单独安装。

## 工作方式

GitHub 仓库是跨机器的配置来源：拉取仓库后运行 `setup.ps1` 部署到本机 `~/.omp`；需要发布本机配置修改时，可选择用 `sync-from-live.ps1` 导出到仓库，再自行提交发布。

部署前会检查仓库并备份受影响的受管文件；仓库没有的本机受管技能和子代理文件会在备份后删除。浏览器程序、登录状态、凭据及其他机器依赖不随仓库部署。

## 文档

- [配置同步与安全边界](docs/config-sync.md)：受管范围、部署和导出流程。
- [配置与操作参考](docs/omp-config-reference.md)：新机器部署、模型、技能、MCP 及日常同步详情。
- [Ego Browser 启动器安装](docs/ego-browser-setup.md)：Windows 上逐机配置版本无关的 `ego-browser` 命令。
- [同步流程图](docs/omp-config-sync.html)：配置同步流程可视化。
