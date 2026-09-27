# 公开发布检查表

核对日期：2026-09-27。程序 0.1.5，Ranking 统计日期 2026-09-26。

## 发布边界

- 安装包通过 Releases 分发，不提交 exe、node_modules、Python 环境或 OCR 模型到源码 Git。
- 公开源码使用干净首次提交，不推送开发与发布工作区的历史。
- 保留当前 Core/Common、语义产物、活动及两份历史 Ranking/Recipe、精简趋势。
- 不发布个人数据库、认证配置、Provider 日志、私人聊天、截图缓存或个人 Agent 设置。
- 工程维护阅读 MAINTAINING、AGENTS、CLAUDE 和项目 Skill；生产教练按 Runtime 封闭请求合同工作。

## 已有验证范围

0.1.5 已有源码/安装资源一致性、Renderer 构建、卸载隔离测试、打包 Daemon 与模拟 Provider 巡航交付检查记录。用户反馈该版本可用。同版本文案更新后核对过安装位置和代码。这不等于另一台无开发环境机器的完整真实对局验收。

## 安装包公开前仍需关闭

1. 第三方许可清单：ADB 三个二进制旁未发现 NOTICE；OCR 模型来源/许可与 Python 随包组件仍需完整核对。项目 LICENSE 不代替第三方许可。
2. 本轮 `npm audit --omit=dev` 报告 5 个依赖告警：3 high、1 moderate、1 low、0 critical，涉及 browserslist、nanoid、postcss、baseline-browser-mapping、esbuild。构建工具目前也列在 dependencies 内，因此这不等于 5 个用户侧可利用漏洞；需要按可达性分流，不直接 audit fix --force。尚不能宣称全部解决。
3. 重新打包后重新验证资源和代码一致性，生成新 SHA-256，不沿用旧包验收哈希。

源码导出不等于以上二进制发布条件完成。第三方游戏资料保留来源，不纳入项目原创代码授权。

## 发布步骤

检查干净导出清单与扫描报告，在导出目录初始化 main、创建首次提交，只将该目录连接公开仓库。安装包通过 v0.1.5 Release 上传并附 SHA-256，不提交到 Git。不要上传本机运行目录。
