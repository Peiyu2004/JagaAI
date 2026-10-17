# JagaAI AI 演示（RTX 3050）

双击 `Start-AI-Demo.cmd`，打开 <http://127.0.0.1:5174>。此入口使用独立的 `data/ai-demo`，原业务数据仍由 `Start-V3.cmd` 打开。登录方式见页面的本地账号说明。

## 现场顺序

1. 打开 Ask JagaAI，搜索 `Show restricted entry events`。打开结果，观看人在楼梯或庭院跨过配置边界的前后画面。
2. 搜索 `穿红衣服的人靠近白色汽车`。打开停车场结果，核对抽样画面并播放原视频。
3. 可用 `person wearing red near a white car` 和 `orang berbaju merah dekat kereta putih` 检查同一类线索。
4. 搜索 `有没有大象` 或 `穿紫色衣服的人`，查看无明确匹配以及最近片段的未满足条件。
5. 搜索 `有没有人打架`，系统明确告知尚不支持。

公开素材来自 MEVA，Kitware Inc. 和 IARPA，CC BY 4.0；JagaAI 截取、缩小并叠加了边界和检测框，未获得原作者背书。来源：[MEVA](https://mevadata.org/)，[许可](https://mevadata.org/resources/MEVA-data-license.txt)。原视频日期为 2018 年。请不要用“昨晚”搜索这些历史素材；可在 Edit conditions 指定时间。来源、分割和原始哈希见 `output/ai-readiness/demo-evaluation.json`；完整素材来源见 `data/meva` 的清单。

## 实际能力与限制

- R3：YOLOX-S 检测人，ByteTrack 跟踪，再判断脚点是否跨过相机设置的线/区域。R3 按约 10 fps 连续检查，并对边界附近放大检测，减少远处人物漏检。演示明确将生效时段设为全天，因为现有公开素材是白天画面。不能据此声称夜间识别已验证，也不能据此认定无权限进入。
- R1：保持原有 120 秒停留或 5 分钟内接近 3 辆不同车辆的规则，没有降低门槛来制造结果。长时间停留触发时增加放大裁剪复核，减少把静止机械识别成人。现有演示主要检查普通停车活动不误报；尚缺独立标注的真实 R1 正例。
- 录像搜索：本地 Qwen3-VL Instruct 生成抽样画面说明与粗粒度衣服/车辆颜色，Qwen3 Embedding 排序，并检查显式物体及颜色条件。中文和马来文中的已支持颜色条件会额外转换为统一检索短语，保留原句一起检索；页面显示 Also searched，阈值仍为 0.65。颜色和物体可能判断错误；衣服与车辆共同出现不保证属于同一人物关系。搜索结果是待核查线索。
- 人物搜索增加同帧检查：原画面的人体候选还必须通过放大裁剪复核。无人、未复核或时间/关键帧不对应的说明，不会进入人物命中或“相近片段”。模型文字里写了“有人”本身不能通过检查。重新分析会自动保存依据；缺少依据的旧索引会提示重新分析。严格过滤可能漏掉较小或遮挡的人物。
- 抽样采用周期采样和人数变化/规则触发补采样，说明只对应指定瞬间，不能证明整个时间段一直如此。达到预算后标记 partial，已分析部分仍可检索。
- 不是身份识别、打架/跌倒模型或偷窃意图判断。小目标、遮挡、暗光和跟踪中断仍是限制。

## GPU 与复现

仅选择名称含 `RTX 3050` 的 NVIDIA GPU UUID。ONNX 检测使用 CUDA；找不到显卡或 CUDA 初始化失败会明确报错，不会悄悄换到其他显卡。Ollama 使用专用端口 11435，AMD ROCm/Vulkan 关闭，一次加载一个模型，避免争抢 4 GB 显存。CPU 仍负责视频解码、跟踪规则、数据库等普通工作。

依赖：`backend/requirements-vision.txt`；本地模型 `qwen3-vl:2b-instruct`、`qwen3-embedding:0.6b`。CUDA/cuDNN 包在项目虚拟环境中，不需要修改系统显卡设置。

在演示服务的 Ollama 已启动时，另开终端运行：

```powershell
.\.venv\Scripts\python.exe scripts\prepare-ai-demo.py
```

这会从现有 MP4 截取清单中的片段并实际分析，已完成的片段跳过。`--reanalyse --cases stairs-entry` 可重跑某一个场景。运行时不要同时上传新片段，以免多个进程争用模型。

工程参考预期由公开画面的视觉检查提出，未经过独立人工标注；小规模场景通过率不能当作实际部署准确率或全量 24 段盲测结果。详细实测记录保存在 `output/ai-readiness/`。

人物误匹配的复现与测试见 `output/ai-readiness/person-search-fix-20261016.md`。维护已有演示索引时，可运行下面的补检；它使用原录像的对应帧，保留原模型说明和向量，并检查录像是否在期间过期或被重跑。请等当前录像分析完成后运行，避免争用显存。

```powershell
.\.venv\Scripts\python.exe scripts\backfill-person-evidence.py --data-dir data/ai-demo --report output/ai-readiness/person-evidence-backfill.json
.\.venv\Scripts\python.exe scripts\verify-person-search.py --rounds 3
```
