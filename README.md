# JagaAI · Local community safety prototype

> **Judges / evaluators:** the submission is **JagaAI v3**. Start with [`v3/README.md`](v3/README.md) (3-step quick start). The rest of this file documents the earlier prototype.

基于 [新版 proposal](output/proposal/JagaAI_Proposal_v2.md) 逐步更新的本地原型，当前已接入本地 VLM、中英文自然语言录像搜索、居民上报自动回溯 → 人工审核 → 物业派单，以及发给居民的截图自动人脸／车牌打码。网页统一英文。代码、账号、数据库、照片与录像均保存在此电脑；没有上传 GitHub 或部署到云端。Argon 仅接收设计问题与必要代码片段用于评审，未接收录像、照片或账号数据。

## 启动

需要 Node.js 24.11 或更新的 24.x。依赖已安装，FFmpeg / FFprobe 随本地依赖提供。

在此文件夹打开 PowerShell：

```powershell
npm ci
npm run ai:setup
npm run dev
```

最方便的方式是双击 `Start-Local.cmd`；也可运行 `Start-Local.ps1`。在浏览器打开 **http://127.0.0.1:5173**。保留启动窗口，按 `Ctrl+C` 关闭网页、API、worker 及本次启动的本地模型服务。再次启动保留所有数据；`npm run fixtures` 仅准备清楚标注的内置合成演示录像。

| 角色 | 邮箱 | 密码 |
| --- | --- | --- |
| Management | manager@jaga.local | JagaLocal!2026 |
| Guard | guard@jaga.local | JagaLocal!2026 |
| Property team | maintenance@jaga.local | JagaLocal!2026 |
| Resident | resident@jaga.local | JagaLocal!2026 |

这些是本机开发账号。用户密码以带盐 scrypt 哈希保存；登录会话用 HttpOnly cookie。请在不同浏览器或退出后切换角色，以演示各自视图。

## 已实现的本地流程

- 四种角色登录、小区及对象权限、成员停用、关键修改审计。
- 居民提交问题及照片，后台自动检索已上传录像，管理审核候选片段、建立或关联事件、派给物业或保安；工作人员接单／到场／提交结果，管理关闭，居民查看公开进度。
- 摄像头资料、实际 MP4 格式检查、上传、私有播放与时间定位。
- 独立视频 worker、持久队列、事务领取、租约／心跳、限次重试、分段、缩略图、过期文件清理。
- 合成录像的预定义分析、候选提醒、人工核实、时间／地点／关键词查询、报告预填查询。
- 活动发布、报名／取消、容量限制、出席验证、幂等积分流水与个人贡献历史。

## 本地 VLM 与自然语言录像搜索

本机 `.env` 已设置 `AI_MODE=ollama`。`npm run ai:setup` 在项目 `.runtime/` 安装经过 SHA-256 校验的官方 portable Ollama，以及 `qwen3-vl:2b`（视觉）和 `qwen3-embedding:0.6b`（多语言向量）两个模型。下载依赖和模型需要网络，录像帧、描述与查询仅发送到本机回环服务。没有云端推理或云端回退。

1. 管理账号进入 **Video centre**，选择已有摄像头上传 MP4，填写录像真实开始时间，然后点击 **Analyse**。旧版 fixture 录像可点击 **Reanalyse with VLM** 重新分析。
2. Worker 对原片切分 15 秒窗口，重叠 3 秒，每段抽取 4 张帧。本地 VLM 描述可见人物、粗略衣服颜色、物体、动作和空间关系，并保留可见性限制；输出须通过结构与采样帧范围验证。
3. 描述完成后，独立持久索引任务生成向量。界面分别显示录像分析及搜索索引状态。失败有具体原因，重启可恢复；可用 **Rebuild search index** 重建或补建索引。
4. 在 **Video search** 直接输入英文或中文，例如 `穿红色衣服的人靠近白色汽车`，或 `昨晚8点到10点在B区停车场穿红衣的人`。相对日期先显示马来西亚时间供确认；已登记地点及其别名用于确定搜索范围。可展开可选时间和地点筛选。
5. 搜索使用真实查询向量与描述向量的余弦相似度，校验模型 digest、维度及描述内容版本。点击候选或观察时间点，打开有会话授权的原始录像。相似度只用于排序，不能解释成命中概率。

**搜索的是 VLM 描述的语义**，目前没有直接训练视频事件模型，也没有用 CLIP 直接计算图文向量。画面细节先经过 VLM 描述；漏写的细节无法保证被搜索到。返回的是最相近候选，尚无经过真实数据校准的相关性阈值。候选不是所有查询条件已满足的证明。

每张采样帧分别调用一次 VLM，观察时间代表单个样本时刻。模型不核验 Honda 等汽车品牌、面孔身份、所有权、意图或违法责任。描述只来源于抽样画面，片段时间表示原片窗口，观察时间点表示所分析的采样帧，不能证明两帧之间的完整动作。四帧采样可能漏掉短暂事件。日期解析支持今天／昨天／昨晚／今早／过去一周、ISO 日期及钟点区间；其他日期表达请使用可选筛选框。没有进行真实授权 CCTV 的独立准确率、召回率或 Top 3 命中率评估。

全局搜索仅对 management 开放；guard 和 property team 只能访问被指派事件的证据，resident 不能查监控。居民只能接收工作人员明确审核发布的打码截图。没有新增人脸身份库或实时 CCTV 接入。

保留显式 **Keyword search** 模式供旧版 synthetic fixture 流程验证，界面不会把它称为语义搜索。`AI_MODE=fixture` 仍只接受经 SHA-256 校验的预定义动画注释，不会给普通上传套演示结果。

### 合成素材的真实模型演示

启动服务后运行 `npm run demo:semantic`，生成并上传三段画面标有 **SYNTHETIC TEST ANIMATION** 的停车场测试动画，随后通过正常队列调用本地 VLM 和 embedding。三段用于测试颜色、人物/空场景的排序区别，描述没有预先写入系统。录像时间设为运行当日的前一天 20:00、20:12、20:24（马来西亚时间），可使用上述“昨晚”查询。随后运行 `npm run smoke:semantic` 检查真实本地模型的中英文排序、日期解释与私有 Range 播放。记录位于 `output/verification/local-ai-smoke.json`。重复运行生成命令会新增三段测试视频；不是生产数据导入命令。

## 居民上报 → 自动回溯 → 审核 → 派单

1. Resident 在 **My reports** 提交地点、时间区间与问题描述。提交成功即保存检索任务，不需要管理人员点击 Analyse。Worker 只搜索同小区、同登记地点的摄像头录像，时间范围显示在管理面板中。仅填写一个时刻时扩展为前后 2 分钟；区间最长 31 天，每次最多处理 50 段录像。
2. 缺少分析或向量的录像自动排入本地 VLM／索引队列；没有录像时显示等待，后续上传匹配录像会唤醒任务。中断后任务可恢复，模型或索引失败会显示具体原因。管理人员仍可使用已有手动处理方式。
3. Management 进入 **Community reports** 打开上报。系统提供最多 3 个候选，片段被裁在所报时间内，显示来源、描述、可见性限制和排序分数。点击 **View bounded clip**，播放实际片段，填写审核记录并确认已查看后，选择批准或排除。相似度不代表事件属实。
4. 批准后选择新建事件或同地点的活动事件、物业／保安人员、优先级与内部工作说明，点击 **Link approved clips & dispatch**。证据关联、上报关联和派单在一个事务中完成，重复提交不会创建多份工单。后续改派在 **Incident workspace** 进行。
5. Property team 登录后在 **My assignments** 接单、到场、提交结果。该人员只能播放已批准的事件片段，不能访问原始长录像或全局搜索。管理关闭事件后，居民获得公开结果；居民看不到监控片段、AI 候选或内部工作说明。

审核凭据绑定当前管理人员与登录会话，15 分钟内有效；录像、描述、摄像头登记或检索范围变化后必须重新检索／查看。片段继承原录像保留期限，过期清理媒体与 AI 描述，保留人工处理历史。

当前可试的本地合成上报是 **JG-20261015-AB3449**（Zone B Parking，待审核）。`npm run demo:report` 会复用该演示，`npm run demo:report -- --new-report` 可新增上报；脚本不会批准或派单。它使用带合成标记的动画，并通过真实本地模型自动处理。首轮从提交至候选就绪实测约 **44.4 秒**，从 8 秒原片裁出 2–7 秒片段。这是本机单次合成测试，不能用于声称真实 CCTV 准确率。

已通过浏览器完整执行另一条明确标为 Synthetic QA 的审核／派单／完成／关闭流程。`npm run verify:report` 只核验已完成的演示记录；可用 `-- --report=<report id>` 指定已完成记录。结果在 `output/verification/report-workflow-smoke.json`，操作步骤见 [demo walkthrough](docs/demo-walkthrough.md)。

## 处理截图的本地隐私打码

Property team／Management 在事件中上传证据照片后，后台使用本地 **YuNet 人脸检测 + YOLOv9 车牌检测** 自动生成独立打码副本，移除检测区域的细节并清除 EXIF。选择 **Review masked screenshot**，核对画面；漏掉的区域可以拖动补遮挡，应用后重新预览。填写居民说明并确认核对后，点击 **Send masked screenshot to residents**。

居民在关联上报的 **Treatment screenshots** 只能看到已发布副本；原图保持内部权限。支持撤回、过期清理和版本校验；失败时不发送原图。只对静态截图打码，不进行身份识别或车牌 OCR，也不对整个视频逐帧打码。检测可能漏检，发送前需要人工核对。

本机模型和 Python 依赖已就绪；新环境使用 `npm run privacy:setup`，依赖见 `scripts/requirements-privacy.txt`。完整说明及素材来源见 [截图隐私流程](docs/privacy-screenshots.md)。本地测试事件 **[Privacy QA] Screenshot handoff**（上报 **JG-20261015-FE00CD**）展示了一张脸、一块车牌及一块手动补遮挡。`npm run verify:privacy` 可核验已完成的演示，结果保存在 `output/verification/privacy-smoke.json`。

## 文件与数据

| 位置 | 用途 |
| --- | --- |
| apps/web | React 英文界面 |
| apps/api/src | Express 权限与业务接口 |
| apps/worker/src | 视频处理、本地 AI 与清理 |
| packages/shared/store.ts | SQLite 数据存取与事务 |
| data/jagaai.sqlite | 持久业务数据及审计 |
| data/media | 私有照片、录像及缩略图 |
| data/fixtures | 旧版合成演示内容校验清单 |
| .runtime/models | 两个本地模型权重 |
| .runtime/privacy-models | 人脸／车牌 ONNX 模型（仅本地 CPU 推理） |
| .runtime/ollama.log | 本地模型运行日志 |
| data/semantic-demo | 新版真实模型测试动画及 manifest |
| data/report-workflow-demo | 自动回溯演示 manifest（不含登录凭据） |
| data/privacy-demo | 截图隐私演示事件 manifest（不含登录凭据） |
| docs | 范围、数据模型、进度、测试记录 |
| tests/integration | 业务、权限、并发与 worker 测试 |

`data/`、`.env`、`.runtime/`、`node_modules/` 都在忽略列表中。媒体必须通过授权接口访问，没有静态公开媒体目录。默认保留演示录像 7 天（可配置），过期后 worker 清理实际文件和分析记录。此期限是原型设置，不是法规。

安装依赖时会从 npm 下载软件，AI setup 从官方发布与模型仓库下载运行包和权重；应用运行期间不会把业务数据送往云端。前端没有外部字体、远程图标、分析统计或云端 API。

## 验证与恢复

```powershell
npm run build
npm test
```

查看 `docs/test-results.md` 的实际验证记录与限制。API 测试使用独立临时数据库，不改变演示数据。

异常退出后重新 `npm run dev` 即可。已完成的分析不重复创建提醒；处理中任务在租约到期后可恢复。失败原因保留在界面，失败和“无候选提醒”是不同状态。

备份前关闭运行窗口，再复制整个 `data` 文件夹；恢复时同样先关闭进程再替换备份。不要只复制 SQLite 主文件而遗漏尚未提交的 WAL。此原型只监听本机回环地址，适合本地开发与演示。

## 后续工作

授权录像、用户访谈、保留测试集及长时间连续运行验证仍待完成。详情见 `docs/progress.md`。原开发计划保留不变，后续不能把演示注释或合成测试结果写成真实模型成果。
