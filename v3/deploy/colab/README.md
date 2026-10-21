# JagaAI：免费 Colab 临时演示

此方案在同一个 Colab 运行环境里运行现有 React 网站、FastAPI、YOLOX-S/ByteTrack、Qwen3-VL 和 Qwen3 embedding。访客通过一个临时 HTTPS 网址访问网站和真实 AI，不需要本机持续开机。

这不是稳定托管。免费 Colab 可能随时终止，且限制主要通过外部网页使用免费计算资源；接受这些限制并不保证运行成功。这里不包含保活、自动重启、账号轮换或付费 API。Cloudflare Quick Tunnel 无需账号、域名或银行卡，重启后网址变化。只有在 Colab 中启动并实际验证成功后，才算完成临时上线。

## 开始

1. 打开 <https://colab.research.google.com/>，登录 Google。
2. 点击 **Upload notebook / 上传笔记本**，选择配套 `JagaAI_Colab_Temporary.ipynb`。
3. 在 **运行时 → 更改运行时类型** 选择免费的 **T4 GPU**。若无法分配免费 GPU，可等候或使用较慢的 CPU，不必升级或设置账单。
4. 按顺序运行。第一格上传配套 `JagaAI-Colab.zip`；第二格安装隔离依赖并下载模型，首次需要下载数 GB。
5. 第三格由你输入至少 12 字符的演示管理员密码；不要使用 Google 密码。管理员邮箱默认 `admin@jagaai.local`。
6. 运行第四格。它会先实际执行一次检测、图片描述和向量生成；全部成功才启动网站并打印 `https://….trycloudflare.com` 网址。把这个网址分享给访客，使用你设置的网站账号登录。
7. 两段 MEVA 公开样例在本次云环境里重新排队分析。待完成后测试 Ask JagaAI，也可上传新的授权 MP4，单文件最多 90 MB。

网站保留原有功能。临时隧道不支持 SSE，因此本版本每 5 秒查询变更版本号，有更新才刷新数据。原本的本地开发版本仍使用 SSE。管理员登录使用 Secure、HttpOnly、SameSite=Strict Cookie，仅允许当前临时网址发起浏览器写请求。

## 账号和数据

- 启动包没有原项目数据库、登录会话、`.env`、私人录像、居民报告或已生成的 AI 搜索结果。
- 本次演示使用独立数据库。监督员默认密码随机生成，不使用项目公开的默认密码；需要时可由管理员在设置中另建账号。
- `/resident` 默认保留固定验证码 **246810** 的演示入口。它不是短信或真实身份验证，仅可填写演示资料；第一格取消 `RESIDENT_DEMO_LOGIN` 可以关闭它。
- 样例来源为 MEVA，Kitware Inc. 和 IARPA，CC BY 4.0，未获原作者背书。截取、缩小，演示边界全天启用。原录像日期为 2018 年；不要限定最近一天搜索。详细源地址、日期、修改与哈希位于启动包 `v3/deploy/colab/samples/manifest.json`。
- 学校、家中或公司内网的 RTSP 地址无法自动从 Colab 访问。使用公开样例、上传录像或实际可从云端访问的授权输入。

## 手动重启和备份

正常停止：点击最后一个启动格的停止按钮，程序会停止本次创建的服务。

- 同一次运行环境：重跑第三、四格，使用原管理员邮箱与密码。
- Colab 已回收运行环境：重新运行所有格。未启用备份时，临时数据库和上传录像会丢失，重新建立公开样例。
- 可在第一格启用 `BACKUP_TO_GOOGLE_DRIVE`，由你授权访问 Drive。启动包及数据快照保存到 `MyDrive/JagaAI-Colab`。每两分钟和正常停止时保存快照；突然回收时可能丢失最近修改。
- SQLite 在 Colab 本地磁盘上运行，用 SQLite backup API 生成快照后再复制到 Drive；不复制正在写入的 WAL 文件。媒体备份尽力完成，不能替代正式备份系统。
- 从备份恢复只会填入空的云端数据目录，已有本次会话数据不会被旧快照覆盖。恢复后保留原管理员凭据，不会静默重置密码。
- 每次重启的新网址需要重新分享；旧网址会失效。此方案不会自动创建这里的 Sites Publish 项目。

## 检查故障

日志在 Colab `/content/jagaai-colab/v3/.runtime-colab/logs/`。AI 检查失败时不会显示“已上线”。缺少免费 GPU、模型下载失败、代理连接被阻止等情况均需检查错误后手动重试。

免费环境的速度、GPU、网络可用性和持续运行时间不能承诺。代码本地测试通过不等于 Google Colab 和公网隧道已经验证；实际运行情况以对应 Notebook 输出为准。

## 重新打包当前代码

在项目根目录运行：

```powershell
v3\.venv\Scripts\python.exe v3\scripts\build-colab-bundle.py --output "C:\Users\HP\Downloads\Sime darby\output\colab"
```

打包器先检查 TypeScript 并构建轮询版网页，再按明确文件清单收集后端、默认检测模型、许可证、两段公开录像和启动脚本。ZIP 与 Notebook 通过 SHA-256 配对，勿混用不同版本。

## 参考

- Colab 官方限制：<https://research.google.com/colaboratory/faq.html>
- Cloudflare Quick Tunnels：<https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/>
- MEVA：<https://mevadata.org/>
- MEVA 许可：<https://mevadata.org/resources/MEVA-data-license.txt>
