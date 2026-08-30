# DSH-WM-20260830-03：README 缺少面向用户的可执行安装说明

## 问题信息
- 发现日期：2026-08-30
- 发现会话或复现方式：发布完成后复核 GitHub 与 NPM 项目首页
- 相关模块或代码：`README.md`、`package.json`
- 状态：已解决
- 验证情况：29 个测试、类型检查、生产构建和打包检查通过；GitHub Release 远程安装及核心模块导入通过；主分支和 `v0.2.12` 标签已推送

## 问题描述

原 README 以能力清单、存储布局和开发验证为主体，安装入口不突出，也没有覆盖验证安装、更新、卸载、整理触发条件和常见问题。对只想安装插件的用户而言，内部架构信息过多，实际使用路径不完整。

文档虽然给出了 NPM 安装命令，但所谓“从源码安装”要求用户克隆项目、安装依赖并手动构建，不属于可直接分发的插件安装方式。GitHub 自动生成的源码压缩包也不包含未提交的 `lib/`，不能直接作为 DSH 插件安装。

## 影响

- GitHub 或 NPM 访客难以快速判断插件用途和安装前提。
- 用户容易把源码构建误认为正常安装流程。
- 缺少安装验证、更新、卸载和重启说明，增加使用失败概率。
- 如果直接使用 GitHub Git 依赖安装，缺少构建生命周期会导致插件入口文件不存在。

## 原因判断

README 同时承担了用户指南和架构说明，信息层级没有按下载者的实际流程组织；包脚本只覆盖本地开发和 NPM 发布，没有为 Git 依赖安装声明构建生命周期。

## 解决方案

- 将 README 重写为用户指南，优先说明定位、前提、NPM/GitHub 安装、重启验证、更新、卸载、整理触发、数据位置和常见问题。
- 将内部存储与模块细节留在 `DESIGN.md` 和 `docs/ARCHITECTURE.md`，README 只保留必要行为说明和文档链接。
- NPM 使用 Registry 中的预构建包；GitHub 使用版本 Release 中的预构建 `.tgz` 附件。
- 不从 Git 仓库运行 `prepare`：pnpm 11 会要求用户为具体 codeload URL 配置 `allowBuilds`，不适合作为公开安装流程。

## 处理记录

- 2026-08-30：确认 `dsh plugin add` 支持 Git host 依赖。
- 2026-08-30：确认仓库不提交 `lib/`，GitHub 源码包不能作为预构建插件直接安装。
- 2026-08-30：完成面向最终用户的 README 重写。
- 2026-08-30：远程测试发现 GitHub Git 依赖的 `prepare` 被 pnpm 11 构建许可策略拦截，安装失败并提示 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`。
- 2026-08-30：将 GitHub 安装方式收敛为预构建 Release 附件，避免要求用户运行仓库构建脚本或修改 profile 的 `allowBuilds`。
- 2026-08-30：创建 GitHub Release `v0.2.12`，上传 `flowingspring-dsh-workspace-memory-0.2.12.tgz`。
- 2026-08-30：从公开 Release URL 在全新临时项目中安装成功；确认版本为 `0.2.12`，`lib/index.js`、`cordis.patch.yml` 均存在，`@flowingspring/dsh-workspace-memory/core` 可正常导入。
- 2026-08-30：发布 NPM 与 GitHub Release `v0.2.13`；NPM `latest` 已指向 `0.2.13`，Registry 返回的 README 已确认包含 NPM 安装、GitHub 安装和常见问题章节。
