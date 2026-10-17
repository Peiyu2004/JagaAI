# JagaAI：尽量免费部署与云端 AI 方案

核对日期：2026-10-17，Asia/Kuala_Lumpur。预算偏好：暂时尽量免费，先了解能力与限制。本文件是部署方案，未执行部署或接入 Firebase。

## 推荐判断

Firebase 可以承担网页托管与真实账号登录。它不会自动运行现有 YOLOX/ByteTrack、Qwen3-VL 与 embedding 流程。要让笔记本关闭后所有功能仍可用，后台、数据库、录像与推理都必须位于云端。

最低改造量的全云演示方案是：一台带持久磁盘的云 GPU 主机，同时运行前端静态文件、FastAPI、单个分析 worker、Ollama；通过一个 HTTPS 域名访问，Firebase Authentication 负责真实登录。Ollama 只监听这台云主机内部回环地址。现有仅允许回环推理的限制可以保留，视频不会返回用户笔记本分析。

这是适合当前单机原型的小规模部署起点，仍有改造与验收工作；不是现成部署包。机器费用按所选厂商、区域和开机时长计算。学校提供的服务器或获批额度可能减轻现金支出，但未核实任何实际可用额度。

## 免费范围与成本边界

| 部分 | 可做什么 | 边界 |
|---|---|---|
| Firebase Hosting | 托管 React/Vite 构建后的页面，提供 HTTPS | Spark 有免费额度；官方当前列 10 GB 托管存储、360 MB/天传输。这些是页面托管额度，不是私有录像权限系统或 GPU |
| Firebase Authentication | Google / 邮箱密码等真实登录 | 常用非短信方式有免费额度；短信收费。发送邮件、用户量与防滥用限制需按账号实际配额核对 |
| 后台与数据 | 提供案件接口、权限、实时更新和保存数据 | 当前 FastAPI 与 SQLite 不会随静态网页一起上线；临时容器磁盘不能用于唯一数据副本 |
| Cloud Storage for Firebase | 存照片/视频 | 当前需要 Blaze 并关联计费账号；仍可能有免费用量，具体受地区、桶类型和流量影响。不能承诺 Spark 免费项目直接存视频 |
| 云 AI | 运行检测、跟踪、描述、向量生成及查询向量 | Firebase Hosting/Auth 不提供这套推理环境。要维持当前模型和合理速度，通常需付费 GPU 或实际获批的计算资源 |

## 三种选择

1. **严格零云计算费用**：先部署免费额度内的页面与登录。若数据接口、存储和 AI 尚无托管环境，不能称为完整可用系统。利用笔记本提供 AI 是混合部署，笔记本关闭会中断，不满足全部 AI 在云端的目标。
2. **全云、控制演示时长（推荐下一阶段）**：使用云 GPU 主机，在联调和展示时运行，结束后停止计算资源，持久磁盘按需保留。也可在实际获批的学校/赞助计算资源上部署。额度和费用必须先核实。
3. **长期全云运营**：网页/认证、API、持久数据库/媒体、异步 GPU 任务分开部署；需要更多运行维护和代码改造。当前没有免费长期 GPU 可用性的依据。

Google Cloud 免费试用官方当前提供符合资格的新用户 90 天 $300 credit；未升级的试用账号不能给 VM 添加 GPU，也不能申请配额提升。升级后仍需额度和 GPU 可用性，并可能产生超额费用。因此不能把注册免费试用等同于免费 GPU 已可用。

作为预算量级参考，Cloud Run 公布的 NVIDIA L4、无区域冗余 GPU 单价为 US$0.0001867/秒，约 US$0.67212/运行小时，仅 GPU 部分；CPU、内存、存储、构建和网络另算。按此价 10 个计费 GPU 小时约 US$6.72，720 小时约 US$483.93。此例是 Cloud Run 的参考价，不是 GPU VM 报价，也不保证选定区域有容量。预算告警不是自动停止计费的硬上限。

## 真实登录需要怎样接入

1. 建立团队自己的 Firebase 项目，先启用 Google 或邮箱密码登录，并配置实际域名。现有固定 246810 演示入口必须关闭。
2. 前端使用 Firebase SDK 登录，取得 ID token。后台以 Firebase Admin SDK 验证签名、项目/受众、有效期等，不能只读取前端传来的邮箱或角色。
3. 用 Firebase UID 建立唯一的本地用户关联。居民自行登录默认只有居民权限；管理员/主管由受信任的后台流程授权。不能让用户在注册表单自行选择管理权限。
4. 保留现有角色检查、上报归属检查与视频权限。登录身份服务不会替代这些业务权限。
5. 优先沿用同源 HttpOnly 会话，配置 HTTPS Secure Cookie、过期与退出失效。视频、图片与 SSE 也要沿用认证；单纯给 JSON 请求加 Bearer token 不会自动让 video/img/EventSource 带上同样的请求头。
6. 如果采用 Firebase Hosting 到 Cloud Run 的 rewrite，Hosting 通常会剥离除 __session 之外的 Cookie；当前 jagaai_v3_session 不能直接照搬。还要核对代理时限、上传、SSE、Range 和 SPA /resident 回退。若选择同一 GPU VM 直接提供网页与 /api，可以避免这个特定 Hosting Cookie 限制。

## 当前代码必须处理的云端差异

- `backend/app/gpu.py` 写死只接受 RTX 3050。云端常见 L4/T4 等不能直接运行，需要显式配置被允许的 GPU 并验证实际 CUDA 提供器；保留本机默认选择策略，不能悄悄降低到其他设备。
- `run.py` 是 Windows 本地启动器，设置本机端口、模型和程序路径。云服务器应使用对应 Linux 服务/容器启动方式，配置 FFmpeg/FFprobe、模型路径与进程重启。
- `main.py` 只允许本机 Origin，`auth.py` Cookie 尚无 HTTPS Secure 配置。需基于正式域名配置，而非改成所有来源都允许。
- 数据库和媒体现在是本地目录。最小单实例方案可用持久云磁盘与备份；容器自动扩容或多副本方案需要共享数据库、对象存储与独立可靠队列，不可直接复制 SQLite 和进程内队列。
- 当前事件流与分析队列在单进程内维护。最小方案保持一个 API/worker 实例，不能直接启用多个 Uvicorn worker。Cloud Run 等按请求暂停/缩容的平台需要调整后台任务模型，避免响应结束后任务被中断。
- 云端仍需运行原有模型，并核对 digest/向量版本。若改成其他模型或外部推理 API，需要重新评估描述、搜索和索引兼容性；这不是换一个网址就完成。

## 实施顺序与完成标准

1. 确认账号、域名、可用免费额度和云计算上限；选择单台 GPU VM 或分离服务。当前没有这些资源的既定选择。
2. 完成 Firebase 真实登录及后端身份/角色映射，停用所有演示凭据；先在本地验证。
3. 准备 Linux 运行环境、持久数据与备份、显卡配置、正式域名和 HTTPS；从干净环境启动。
4. 用两个独立线上账号完成居民上报到处理反馈，确认其他居民不能查看该报告、居民不能查看监控、退出后会话失效。
5. 上传一段全新的授权测试录像，由云服务实际执行检测/跟踪、描述和向量生成。关闭本机所有服务后仍能完成搜索、播放和案件更新，才算全云验收通过。
6. 检查 HTTPS Cookie、跨域、SSE 重连、上传限制、Range 播放、持久存储与重启恢复；记录实际耗时与账单。

## 官方参考

- Hosting：https://firebase.google.com/docs/hosting
- Firebase 价格与免费额度：https://firebase.google.com/pricing
- Authentication：https://firebase.google.com/docs/auth
- 后台验证 ID token：https://firebase.google.com/docs/auth/admin/verify-id-tokens
- Hosting Cookie 行为：https://firebase.google.com/docs/hosting/manage-cache
- Storage 的 Blaze 要求：https://firebase.google.com/docs/storage/faqs-storage-changes-announced-sept-2024
- Google Cloud 免费试用限制：https://docs.cloud.google.com/free/docs/free-cloud-features
- Cloud Run GPU 与费用：https://docs.cloud.google.com/run/docs/configuring/services/gpu ，https://cloud.google.com/run/pricing
