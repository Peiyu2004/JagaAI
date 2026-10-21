# 保安通知与接单

JagaAI v3 支持 WhatsApp、自动语音电话、SMS 备用和持久化接单记录。默认关闭自动通知，默认使用 **Simulation**；模拟状态不代表任何真实手机已收到消息。对讲机尚未接入。

电话支持“收到”语音接单、按 1 备用，以及查询本条告警的位置和情况；每通最多 90 秒。一次性演示可使用独立启动器，详见 [语音 demo 与实机接入](guard-voice-demo.md)。

录像和 AI 推理沿用原有权限及本地处理。启用 Live 后，联系人号码、事件摘要、地点、时间和个人接单链接会发送给 Twilio/WhatsApp；不自动外发原片或监控截图。

## 本机使用

1. 使用原有 `Start-AI-Demo.cmd` 或 `Start-V3.cmd` 启动，以管理员登录。
2. 在 **Settings → Team & access → Add guard** 添加当班及升级联系人。自动通知号码采用国际格式，例如 `+60123456789`。班次字段是备注；第一版由管理人员在交班时选择当班联系人，不自动解析班次文字。
3. 打开 **Settings → Notifications**，保留 **Simulation**，选择 Duty contact 和可选的 Escalation contact，保存。
4. 打开一条 **Alerts** 记录，在 **Guard notification** 选择联系人，点击 **Simulate notification**。同一告警只有一份通知计划，重复点击返回原记录。
5. 约两秒后 WhatsApp 步骤显示 **Simulated only**。点击 **Open simulated guard page**，勾选可以到场，再点击 **Accept practice request**。
6. 返回管理页面：记录应显示联系人、接单时间和 `Guard link`；尚未发送的电话和升级通知变为 **Stopped**。管理人员也可以在保安直接回复控制室后使用 **Record acceptance**，记录保安姓名及操作人员。

手机接单页不要求保安拥有管理账号，只显示该条通知的地点、事件摘要、时间及接单状态。它不提供监控录像、搜索入口、居民资料或其他事件。个人链接有效期为 30 分钟，不要转发。

模拟接单只记入模拟历史，不会自动把真实事件分配给保安；告警仍需人工审核。正常 Live 接单可以为已关联且尚未指派的事件填写保安，并保持已有的人工指派。

## 通知顺序

| 时机 | 行为 |
| --- | --- |
| 新通知 | 给当班联系人发送 WhatsApp |
| 默认 60 秒无人明确接单 | 拨打当班联系人电话，播报待核实事件；说“收到”或按 **1** 接单，可问位置和情况，最多 90 秒 |
| WhatsApp 失败、结果不确定，或在电话等待期内仍未确认送达 | 启用一次 SMS 备用，不重复发送同一 SMS |
| 默认 180 秒无人接单 | 给升级联系人发送 WhatsApp；再等待电话延迟后拨打升级电话 |
| 有人接单 | 保存渠道、人员、时间；取消尚未发送的通知 |
| 已尝试所有计划联系人且仍无接单 | 标记 **Follow-up required**，由控制室继续跟进 |

电话等待、升级等待及同摄像头/规则的冷却时间可以设置。`urgent` 告警可配置立即拨号。当前检测规则产生 `normal` 或 `high` 告警，不会自动推断为 `urgent`。

“Submitted to provider / Sent / Delivered / Read / Answered / Completed” 均不等于接单。接单必须由个人链接确认、经签名验证的电话明确语音或按键 **1**，或控制室明确记录。

## 自动触发边界

- 在 **Notify automatically for new live triggers** 打开后，新的实时录像规则告警会在保存告警的同一事务中创建通知计划，独立于慢速 VLM 描述任务。
- 上传历史录像、重跑旧分析不会自动外发；自动通知只接受事件时间在当前前 5 分钟内、至多未来 30 秒的实时片段。
- `demo:` 模拟摄像头片段保存独立模拟标记；即使之后修改摄像头地址，该片段也不会自动发送真实通知。Simulation 模式可用于演练实时回放。
- 相同摄像头与规则默认冷却 600 秒。被合并的告警保留 **Within cooldown** 记录，既有检测层去重继续有效。
- 驳回告警、过期录像、被新分析取代的事件、解决/关闭事件、停止通知或修改通知策略都会停止待发计划。
- 队列写入 SQLite，重启可恢复。发送中的请求若中断超过 60 秒，会标为 **Delivery uncertain**，等待签名回调确认，不会盲目重发。同一步骤若已迟到超过 5 分钟，也不会补发旧告警。
- 已经提交给服务商的消息或电话不能撤回；接单/停止操作取消尚未发送的步骤。电话播报开始前也会再次检查通知是否仍开放。

## 接通真实服务

本次验收没有配置真实 Twilio 账号，因此未发送真实 WhatsApp、电话或 SMS。以下配置完成后仍需用指定测试号码完成真实送达验收。

1. 在 Twilio 准备可用的 WhatsApp Business sender、语音号码、SMS 发送号码，并确认账号余额、目标国家/地区的语音拨号权限和试用账号的收件人验证限制。WhatsApp Sandbox 仅适合测试，不等于生产批准。
2. 准备一个**获批的 WhatsApp 模板**。程序始终使用 `ContentSid` 和 `ContentVariables` 主动发送，不依赖保安最近是否发过消息。模板必须按下列变量约定创建：

   ```text
   Hello {{1}}, JagaAI requests your attendance.
   {{2}} at {{3}}. Event time: {{4}}.
   This event needs verification. Review and accept: {{5}}
   ```

   | 变量 | 程序提供的内容 |
   | --- | --- |
   | 1 | 联系人姓名 |
   | 2 | 待核实事件摘要，例如 Possible restricted entry |
   | 3 | 已登记地点 |
   | 4 | 事件发生时间，Asia/Kuala_Lumpur，标注 MYT |
   | 5 | 完整个人接单链接，包含 URL fragment |

   在服务商模板编辑器中提供符合格式的变量样例并提交审核。记录获批模板的 `HX...` Content SID；不要换用变量含义不同的模板。

3. 将网站和 `/api` 部署在**同一个稳定公网 HTTPS 域名**。保安手机和 Twilio 必须都能访问这个地址。`127.0.0.1` 不能给保安远程使用。构建命令为 `npm run build`（在 `v3/frontend`），后端可通过 `JAGAAI_FRONTEND_DIR` 提供构建页面。
4. 复制 `v3/.env.notifications.example` 为同目录下的 `.env.notifications`，在本机文件中填写，不要把密钥发送到聊天或提交 Git：

   | 配置项 | 用途 |
   | --- | --- |
   | `JAGAAI_PUBLIC_URL` | 例如 `https://security.example.com`，只填 origin、不填路径 |
   | `TWILIO_ACCOUNT_SID` | `AC...` 账号标识 |
   | `TWILIO_AUTH_TOKEN` | REST 认证及服务商回调验签密钥 |
   | `TWILIO_WHATSAPP_FROM` | 获批发送号码，可填 `whatsapp:+...` 或 `+...` |
   | `TWILIO_WHATSAPP_CONTENT_SID` | 上述获批模板 `HX...` |
   | `TWILIO_VOICE_FROM` | 可拨出电话的 Twilio 号码，国际格式 |
   | `TWILIO_SMS_FROM` | SMS 发送号码；开启 SMS 备用时必填 |
   | `JAGAAI_ALLOWED_ORIGINS` | 明确包含公网 HTTPS origin，多个地址用逗号分隔，不加尾部 `/` |
   | `JAGAAI_SECURE_COOKIE` | 公网 HTTPS 建议设置 `1` |
   | `JAGAAI_FRONTEND_DIR` | 构建后的 `frontend/dist` 绝对路径；合并部署时填写 |

   API 启动时读取这个文件；已有进程环境变量优先。修改后重启 API。`.env.notifications` 已加入 Git 忽略列表。
5. 在 Team & access 记录每位接收人的通知同意，再在 Notifications 选择 **Live notifications** 并保存。缺少号码、同意记录或必要配置时，后端拒绝开启。Settings 显示的 **Configured** 只表示配置存在，不代表账号已获批或真实送达成功。
6. 公网反向代理必须转发 `/api/notifications/twilio/*`。程序自动向 Twilio 提供以下地址，不需要手动为每次告警配置：
   - `/api/notifications/twilio/status/{attempt_id}`：消息/电话状态。
   - `/api/notifications/twilio/voice/{attempt_id}`：接听后的播报、语音识别和按键。
   - `/api/notifications/twilio/accept/{attempt_id}?turn=N`：分轮问答或接单；反向代理必须保留查询参数。

   三者均验证 `X-Twilio-Signature`、账号、消息/电话 SID 和目标号码。验签使用配置的公网 origin，不信任转发 Host。公网地址或密钥改变后应重启并重新测试。

## 真实手机验收步骤

使用专门标注为测试的告警和已同意的号码进行：

1. 手动发送一次 Live 测试通知，确认手机真实收到 WhatsApp；服务商回调推进到 Delivered/Read，界面仍显示等待接单。
2. 打开手机中的链接并确认接单，检查管理页面显示正确人名、MYT 时间和渠道，后续电话/升级通知停止。
3. 换一条测试告警，不接单，确认在配置延迟后收到真实电话。只接听或查询位置/情况不应被记为接单；明确说“收到”记录 Phone voice reply，按 **1** 记录 Phone keypad。按 [语音 demo 指南](guard-voice-demo.md) 验证语言、否定句和 90 秒限制。
4. 使用另一条测试告警验证 WhatsApp 失败/未确认送达时只产生一次 SMS。马来西亚 SMS 备用只发摘要及事件编号，不含链接、电话或邮件地址；由保安联系控制室确认，管理人员记录接单。
5. 不接单，验证升级联系人的消息和电话。重复 trigger 不应产生重复通知计划。测试结束后关闭自动通知或切回 Simulation。

服务商接通前不要把模拟结果描述成真实送达。此功能也不构成 CCTV 检测准确率或现场响应时延的验证；实时输入仍受录像分段和分析耗时影响。

## 参考

- [WhatsApp 模板与发送窗口](https://www.twilio.com/docs/whatsapp/key-concepts)
- [主动通知模板](https://www.twilio.com/docs/whatsapp/tutorial/send-whatsapp-notification-messages-templates)
- [外呼 API 与状态](https://www.twilio.com/docs/voice/api/call-resource)
- [电话按键收集](https://www.twilio.com/docs/voice/twiml/gather)
- [回调签名验证](https://www.twilio.com/docs/usage/security)
- [马来西亚 SMS 限制](https://www.twilio.com/en-us/guidelines/my/sms)
