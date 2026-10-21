# 一次性保安语音 demo

此功能支持中文或英文的限定告警问答：查询当前通知的位置、记录的情况，并用“收到”或按 **1** 确认出勤。答案直接来自告警记录，不调用大模型、不推断现场最新情况；不支持任意聊天、远程调取画面或代替人工确认检测结果。

## 推荐演示方式：本机排练，不需要账号或余额

1. 双击 `v3/Start-Guard-Voice-Demo.cmd`。它启动独立演示数据库，预置 3 条清楚标注的合成告警和一个演示联系人。真实业务数据不变，且此启动器禁止真实外发。地址是 `http://127.0.0.1:8767`。
2. 用原有 demo 管理员账号登录，进入 **Alerts**，选中 **Zone B Parking** 的告警，找到 **Guard notification → Rehearse call**。
3. 窗口显示 **Simulation** 和 90 秒倒计时。开启 **Speak replies** 可使用浏览器语音朗读；没有可用语音时仍显示完整回复。
4. 点击或输入“在哪里？”：回答登记地点，仍显示等待接单。再问“什么情况？”：回答记录时间、待核查事件，并说明现场尚未确认。
5. 输入“收到”，点击 **Send reply**：记录 **Phone voice reply**，取消尚未发出的通知。还可继续查询位置。说“再见”或按 **End call** 结束。
6. 另选 **North Gate** 告警演示 **Press 1 to accept**：记录 **Phone keypad**。第三条 **Perimeter Walk** 可用于等待 90 秒验证自动结束；超时没有接单时，不能显示已接单。
7. 展开 **Call transcripts**，查看输入、回复、接单渠道和时间。刷新后记录仍在。重复排练会保留各次记录，不覆盖前一次。

每次重新启动启动器会创建新的独立数据库，保存在 `v3/output/voice-demo/<时间>/`。关闭服务器窗口或按 Ctrl+C 即停止服务。演示结束后无需继续运行，也没有订阅；本机模拟不会产生 Twilio 费用。

启动器需要已准备好的 `.venv`、`frontend/dist` 和 `data/ai-demo/videos` 内的演示视频；缺少时会给出说明。一般使用现有 `Start-AI-Demo.cmd` 准备视频，前端在 `v3/frontend` 执行 `npm run build`。

### 麦克风与朗读的范围

**Use microphone** 使用浏览器的语音识别，将识别结果放入输入框，检查后点击 Send reply。需要浏览器支持、麦克风许可，有些浏览器会调用在线识别服务。拒绝权限、识别服务不可用或没有中文朗读语音时，使用文字和样例按钮完成演示。这些按钮模拟的是语音识别后的文本，不能证明真实手机的收音、网络或 Twilio 识别效果。

本机排练和真实电话共用同一个问答、接单和 90 秒计时逻辑。模拟接单保留模拟标记，不指派真实事件，也不验证 CCTV 检测准确率。

本次检查的本机浏览器只有英文朗读声音，中文声音尚未安装。因此**本机中文文字流程已验证，中文出声尚未验证**。界面会提示缺少中文声音，不会假装已经播报。需要本机出声演示时，双击 `Start-Guard-Voice-Demo-English.cmd`（等同 `Start-Guard-Voice-Demo.cmd --english`），使用已有英文声音和英文示例；它同样创建独立数据库。真实电话中文朗读使用 Twilio 的 Polly.Zhiyu，不依赖这台电脑的声音。

## 真实电话接入：需要时才做

沿用 [保安通知接入说明](guard-notifications.md) 的 Twilio 账号、号码、公网 HTTPS 和联系人同意配置。此功能使用 **Programmable Voice + Gather 语音识别 + Say 朗读**，无需 OpenAI key、ConversationRelay 或额外 AI 账号。不要用禁止外发的 `Start-Guard-Voice-Demo.cmd` 测试实机；使用正常应用启动器。

在 **Settings → Notifications → Call language** 选择语言并保存，再创建新的通知。已有通知保留创建时语言，保存策略会停止旧的待发通知。

| 项目 | 中文 | 英文 |
| --- | --- | --- |
| 识别模型 | `googlev2_chirp_3`，`cmn-Hans-CN` | `googlev2_short`，`en-US` |
| 朗读 | `Polly.Zhiyu`，`cmn-CN` | `Polly.Joanna`，`en-US` |
| 接单示例 | 收到、确认接单、我接单 | Received、I accept、I will attend |
| 查询示例 | 在哪里、什么情况 | Where is it、What happened |
| 结束 | 再见，或按 0 | Goodbye，或按 0 |

每轮短句说完后稍候，系统按轮回答；不支持边播报边自由打断的连续对话。接单使用明确的短语匹配，不把“没收到”“收到但不能去”“收到吗”当成确认。若服务商提供的识别置信度低于 0.75，语音不自动接单，保留按 1；某些模型不提供置信度，此时仍要求明确短语。接单后可继续问本条告警，最多 90 秒。连续两轮无输入或达到 12 轮问答也会提前结束。

外呼请求设置 **TimeLimit=90**，由 Twilio 限制接通后的时长；服务端还保存固定开始时间并拒绝超时接单。刷新或重复回调不会重置时间。通话挂断、超时或接听本身不代表接单，也不会停止仍未接单的后续通知。语音接单会取消尚未提交的升级通知，已经提交给服务商的请求不能撤回。

反向代理必须保留原查询参数，尤其是 `/api/notifications/twilio/accept/{attempt_id}?turn=N`。所有真实电话回调验证签名、账号、CallSid 和收件号码；不能用未签名的普通 curl 请求代替 Twilio。保存文字问答记录，不录制通话音频。

### 一次真实 demo 前的最小检查

使用明确标注为测试的告警、你同意接收的手机号码，关闭自动通知和不必要的升级联系人；排练时可以关闭 SMS 备用，避免额外计费。当前通知配置仍要求可用的 WhatsApp sender 和模板；本次没有增加独立绕过这些配置的拨号入口。试用账号可能限制自定义语音流程，需确认升级后的账号权限与余额、马来西亚外呼权限。

分别验证：中文听得清；问位置和情况不误接单；“收到”记为 Phone voice reply；另一条告警按 1 记为 Phone keypad；持续询问也会在 90 秒结束。检查 Twilio Call Logs/Debugger 没有 Gather、语音或回调错误，然后切回 Simulation。**没有真实账号与手机测试前，只能确认本机流程和适配器通过验证，不能保证真实运营商链路已验收。**

一次 90 秒电话按整分钟计费时可能按 2 分钟收费；每轮 Gather 语音识别和标准语音朗读也可能单独计费。此实现未使用此前预算示例的 ConversationRelay，实际费用应以当前 [Twilio 马来西亚价格](https://www.twilio.com/en-us/voice/pricing/my) 和用量记录为准。

参考：[Gather](https://www.twilio.com/docs/voice/twiml/gather)、[Call TimeLimit](https://www.twilio.com/docs/voice/api/call-resource)、[语音与语言列表](https://www.twilio.com/docs/voice/twiml/say/text-speech)、[识别模型支持语言](https://docs.cloud.google.com/speech-to-text/docs/speech-to-text-supported-languages)。
