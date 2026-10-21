# 保安通知本机验收记录

验收日期：2026-10-21（Asia/Kuala_Lumpur）。范围：JagaAI v3 的通知与接单集成。

## 结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 后端完整回归（含语音问答） | **211 passed**，110.69 秒 | `output/notification-verification/voice-pytest.txt`、`voice-pytest.xml` |
| 通知与新增语音测试 | 通知 28 项 + 语音 28 项包含在完整回归内 | `backend/tests/test_notifications.py`、`test_voice_dialogue.py` |
| TypeScript 与生产构建 | `npm run build` 成功 | `output/notification-verification/voice-frontend-build.txt` |
| 桌面设置及告警界面 | Playwright 实际操作通过 | `output/playwright/notifications/settings-desktop.png`、`alert-accepted-desktop.png` |
| 手机接单页 | 390×844；可接单、可刷新；页面宽度 390，无横向溢出 | `guard-mobile-before.png`、`guard-mobile-accepted.png` |
| 手机通知设置 | 390×844；Notifications 页签可见，无横向溢出 | `settings-mobile.png` |
| 浏览器错误 | 操作过程中没有 JavaScript console error | Playwright console 与页面快照 |
| 真实手机外发 | **未验收** | 用户尚无 Twilio 服务配置；7 项发送配置均为空 |

浏览器使用单独的本地 QA 数据库和清楚标记的合成告警，并复用公开演示视频作页面素材；没有修改用户的实际业务数据库，没有拨号或向真实收件人发消息。该过程验证通知流程，不验证 CCTV 检测准确率。

## 已实际操作的页面流程

1. 管理员登录，新增 `QA Duty Guard`。
2. Settings → Notifications，选择该联系人，在 Simulation 模式保存。
3. Alerts → Guard notification → Simulate notification。
4. 管理端显示 WhatsApp 的 Simulated only 状态及计划拨号时间。
5. 从管理端打开独立手机接单页，在 390×844 视口勾选可以到场并确认。
6. 手机页显示 Acceptance recorded，管理端同步显示接单人、MYT 时间及 Guard link 渠道。
7. 刷新手机页与管理页，接单记录仍存在；告警保持待人工审核。

## 自动测试覆盖的关键行为

- 新鲜实时 trigger 保存通知计划；历史录像、超时事件及带模拟标记的实时回放不自动真实外发。
- 同一告警重复提交只返回一个通知计划；自动通知按摄像头/规则执行冷却。
- WhatsApp 失败或结果不确定时只创建一个 SMS 备用，电话仍按计划执行。
- 默认电话延迟和升级联系人顺序正确；发送中断后不盲目重发；过期计划不集中补发。
- 电话接听和消息送达都不等于接单；通过已验签的电话按 **1** 才记为 Phone keypad。
- 请求参数符合 Twilio REST API：模板变量、语音 URL、四种呼叫状态回调，以及不含链接的 SMS 正文。测试用 HTTP stub 检查参数，未请求 Twilio。
- 接单幂等，两个不同接收人并发接单只有一个成功；两个 worker 不会重复领取同一次发送。
- 个人链接不可访问管理端；伪造/过期/错人的链接与伪造服务商回调被拒绝。
- 驳回告警、清理录像、解决事件、修改通知策略可停止待发计划，通知历史仍保留。
- 模拟接单不自动指派真实事件；Live 接单可以指派已关联且原本未指派的事件。

## 本次语音 demo 增量验收

- 一键启动器 `Start-Guard-Voice-Demo.cmd` 已实际启动；使用全新独立 SQLite 数据库、明确标注的合成告警，禁止真实外发。
- 浏览器实际点击“在哪里”“什么情况”，能显示该条通知的位置、记录时间、待核查事件；没有自动接单。
- 实际输入“收到但不能去”，显示未记录接单；随后输入明确“收到”，保存为 `phone_speech`。问答、确认和按键共用真实电话适配器所用的逻辑。
- 未回复的独立通话真实经过约 90 秒后，保存 `time_limit`；仍无接单。另一通接单后的通话也在约 90 秒结束，接单状态保留。
- 桌面 1440×1000、手机 390×844 截图已检查：`output/playwright/notifications/voice-call-desktop.png`、`voice-call-mobile.png`、`voice-call-accepted.png`。长内容在对话窗口内滚动。
- 自动测试覆盖实际 Twilio 外呼表单 `TimeLimit=90`、中文 Gather 模型/语言与 Polly 声音、签名验证、低置信度拒绝语音接单、按 1 备用、回调重试、固定开始时间、源失效、否定句、重复排练保留历史、英文问答，以及稍后接单会清除旧的无人接单提示。
- 本机浏览器语音枚举只有 David、Mark、Zira 三个英文声音；**中文朗读声音不可用，未完成中文出声或麦克风实际识别验收**。界面提示缺少声音；本机文字排练不依赖麦克风。真实 Twilio 识别和中文音质仍需配置账号后实机验收。
- 最终构建实际验证了按 1 接单、结束通话、刷新后保存 `phone_keypad` 和 `operator_ended`，以及清除旧的无人接单说明。模拟麦克风拒绝权限的浏览器事件，界面给出可继续文字演练的提示；该检查没有采集真实麦克风音频。
- 英文启动模式已实际启动并操作 Where is it → What happened → Received；前两步保持未接单，第三步保存语音接单。浏览器报告朗读已开始（`speechSynthesis.speaking=true`，有本地英文声音）；此检查不等于人工试听音质。截图：`voice-keypad-final.png`、`voice-english-final.png`。

此前“183 passed”是加入语音问答之前的基线，本次完整回归已更新为 211。演示步骤及真实手机接入见 [一次性语音 demo](guard-voice-demo.md)。

## 非阻塞提示

- 后端测试有一条现有 Starlette/httpx 弃用提示，所有测试通过。
- 生产构建有现有 TownScene 3D chunk 大小提示，构建成功。初始 Command centre 页面有 Three.js 警告，无 console error。
- 第一次构建遇到 Windows 系统临时目录删除权限问题；使用项目内独立 TEMP/TMP 后，生产构建成功。

## 实际发送前的剩余验收

按 [接入说明](guard-notifications.md) 配置 Twilio、获批 WhatsApp 模板、联系人同意记录和稳定公网 HTTPS 地址。之后必须用指定测试号码确认真实 WhatsApp 送达、真实电话播报及按键、SMS 备用和超时升级，才能确认服务商与手机端都可用。当前默认 Simulation，自动通知关闭。对讲机未实现。
