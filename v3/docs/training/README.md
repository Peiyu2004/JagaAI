# M2 public-data VLM experiment

Prepared and sources checked: **2026-10-15 (Asia/Kuala_Lumpur)**. Status: preparation only. No MEVA video was downloaded, no Colab/Drive session was opened, no weights were trained, and no Ollama export was verified while preparing these files.

Open `../../notebooks/JagaAI_MEVA_QLoRA.ipynb` in Colab. The notebook contains its helper functions; it does not require importing this repository. `training_data.py` is the editable helper source and `build_notebook.py` reproduces the notebook. Defaults do not install libraries, download videos/models, train, mount Drive, or export a model. Enable the relevant switches deliberately in a GPU Colab session.

## What the experiment measures

The input is an ordered, short image sequence from one annotated interval. The output is `{objects, activity, zone_hint}`. This is an annotation-conditioned classification/JSON-format experiment, **not** validation of end-to-end event detection, loitering duration, criminal intent, Malaysian CCTV accuracy, or JagaAI search performance. R1/R3 remain track/rule-based. There is no fall label, identity label, cross-camera identity, or suspiciousness label in the training target.

Use the identical frozen test samples, prompt, image budget, decoding and 4-bit inference policy for 2B original, 8B original and 8B + adapter. Results describe that quantized comparison, not full-precision model performance. Keep validation separate for checkpoint/threshold decisions; open the test set only for final comparison. Invalid JSON counts against format rate and activity recall. Precision/recall are over the selected activity labels on pre-cut samples; they are not ActEV temporal detection metrics. Object metrics are calculated only when `objects_complete=true`, since activity annotations do not guarantee an exhaustive list of visible objects. Zone accuracy excludes `unknown` reference labels.

## Verified sources and corrections to plan v3

| Check | Finding and direct primary source |
| --- | --- |
| MEVA access | The public S3 bucket is `mevadata-public-01`, region `us-east-1`; unsigned AWS CLI access needs no AWS account. The registry currently reports roughly 184 annotated hours. This supersedes the plan's 144-hour number. [AWS registry](https://registry.opendata.aws/mevadata/). |
| Annotation release | MEVA describes separate evaluation-level (64h) and training-level (120.2h, reduced audit) annotations, with camera metadata/site maps. Do not treat the two annotation qualities as identical. [MEVA project](https://mevadata.org/). |
| License | Dataset creators identify CC BY 4.0. Retain attribution/license, source and a note describing extracted/resized frames. Do not imply Kitware/IARPA endorsement. [Dataset license](https://mevadata.org/resources/MEVA-data-license.txt). |
| Paths/timestamps | Ground clips follow date/start/end/location/camera filenames and may be shorter than five minutes; `r13` is a transcoding release. Use measured video FPS and verified frame/time mapping, never a hard-coded 30 FPS. The HADCV22 subset has challenge-specific training restrictions; use the ordinary training release here. [Official download README](https://mevadata.org/resources/README-meva-kf1-data.html). |
| Activity vocabulary | NIST lists 37 ActEV'21 SDL activity names. The selected safe-description subset is in `activities.md`; class presence in a chosen download still needs inspection. [NIST SDL](https://actev.nist.gov/sdl). |
| Native annotations | The official project links a GitLab repository, definitions and JSON schema. The GitLab content could not be retrieved during this preparation; its exact release/schema/interval conventions remain unverified. A native KPF/JSON reader is therefore **not implemented**. [MEVA repository](https://gitlab.kitware.com/meva/meva-data-repo), [annotation format PDF](https://gitlab.kitware.com/meva/meva-data-repo/blob/master/documents/MEVA_Annotation_JSON.pdf). |
| Base model | The Qwen-owned 8B Instruct card declares Apache-2.0 and documents image/video processing with Transformers. Use this model family, rather than a text-only Qwen3 checkpoint. [Qwen model card](https://huggingface.co/Qwen/Qwen3-VL-8B-Instruct). |
| Unsloth | Unsloth publishes a Qwen3-VL 8B vision SFT notebook and documents Qwen3-VL GGUF conversion. This is upstream support, not evidence that this project's adapter exports correctly. [Qwen3-VL guide](https://unsloth.ai/docs/models/qwen3-vl-run-and-fine-tune), [official notebook source](https://github.com/unslothai/notebooks/blob/main/nb/Qwen3_VL_(8B)-Vision.ipynb). |
| T4 | Use FP16 compute, 4-bit base weights, batch 1, short context/images and gradient checkpointing. Unsloth lists T4 support but memory minima are not a Qwen3-VL multi-image guarantee. Turing tensor cores support FP16; BF16 support appears in Ampere. [Unsloth requirements](https://unsloth.ai/docs/get-started/fine-tuning-for-beginners/unsloth-requirements), [NVIDIA architecture comparison](https://docs.nvidia.com/cuda/ampere-tuning-guide/index.html). |
| Fallback | Transformers supports bitsandbytes 4-bit/NF4 and PEFT adapters. This notebook uses it for inference of the exact saved adapter when Ollama import is unverified. An 8B VLM may still exceed a 4GB laptop's memory. [Transformers quantization](https://huggingface.co/docs/transformers/main/en/quantization/bitsandbytes). |
| Ollama | The import documentation covers Safetensors/GGUF import; the current Modelfile reference does not document an `ADAPTER` instruction. Neither page supplies a tested Qwen3-VL vision-LoRA recipe. This is a documentation gap, not proof that conversion is impossible. Test merged weights + vision projector + template + image input before choosing this deployment route. [Import](https://docs.ollama.com/import), [Modelfile](https://docs.ollama.com/modelfile), [vision API](https://docs.ollama.com/capabilities/vision). |

## Data acquisition and conversion gate

Run these **in Colab**, not against local resident/CCTV folders. List only; do not sync the whole bucket:

```bash
aws s3 ls --no-sign-request s3://mevadata-public-01/
aws s3 ls --recursive --no-sign-request s3://mevadata-public-01/drops-123-r13/ > public-video-keys.txt
```

After reviewing site map/camera FoVs and the annotation release, copy only explicitly selected object keys with `aws s3 cp --no-sign-request s3://mevadata-public-01/<verified-key> <destination>`. The notebook intentionally has no guessed key or automatic multi-GB download. Keep the selected source URI, original filename, SHA-256, annotation release/commit, annotation activity ID and extraction parameters in the manifest/provenance.

Before enabling training:

1. Retrieve the official annotation definitions/schema and identify the release's timestamp/frame convention, object/geometry linkage, and any r13 mapping.
2. Implement and inspect a native reader. Resolve old activity aliases explicitly; reject unmapped labels. Do not derive targets from model captions.
3. Produce `intervals.jsonl` in the contract below, spot-check at least ten intervals with the original annotations, and record the audit. Activity-associated objects are not exhaustive visible-object labels; leave `objects_complete=false` unless completeness is established. `zone_hint` comes from reviewed camera metadata, otherwise `unknown`.
4. Split by complete **date** or complete **camera**, with at least three groups. Do not split by `(camera,date)` pairs while allowing the same camera/date to leak across sets. Overlapping/nearby intervals of a source video must remain in one split. For stronger protection use connected camera/date components or a manually audited split. Check label counts; do not silently move test examples to improve scores.
5. Select negatives only from intervals verified complete/unannotated for all selected activities. Missing annotations alone do not prove a negative. Mark those rows `activity="unknown"` and `negative_verified=true`.

The normalization contract is a **JagaAI input format**, not a claim about the native MEVA schema. One JSON object per line:

| Field | Required meaning |
| --- | --- |
| `sample_id` | Stable unique ID for the source interval. |
| `dataset` / `license` | Exactly `MEVA` / `CC-BY-4.0`. |
| `source_uri` | Verified unsigned public `s3://mevadata-public-01/...` video object. |
| `source_sha256` | SHA-256 of the downloaded video; notebook checks it. |
| `video_path` | Relative path below `PUBLIC_DATA_ROOT`; absolute paths and traversal are rejected. |
| `annotation_ref` | Annotation filename/activity ID and release commit; never a generated caption. |
| `camera_id` / `date` | Verified camera identifier and collection date `YYYY-MM-DD`; grouping keys only, not Malaysian timestamps. |
| `start_sec` / `end_sec` | Measured offsets in that exact video. Selected intervals should show one isolated label; reject unresolved overlaps. |
| `objects` | Known annotation-associated object types from `person, vehicle, bicycle, bag, package`; not a guessed full-frame inventory. |
| `objects_complete` | Boolean indicating whether all visible target object classes were audited. Defaults are not invented. |
| `activity` | Selected activity or verified negative `unknown`. |
| `zone_hint` | Reviewed camera scene: `parking, entrance, walkway, other, unknown`. |
| `negative_verified` | Required `true` for an `unknown` reference activity. |

The notebook converts these normalized intervals into 4 ordered frames and preserves original offsets. It checks every seek/frame, hashes source videos, and fails on unavailable/out-of-range media rather than substituting a nearby or synthetic frame.

## First-day deployment gate

Start with at least ten audited **training** examples and ten optimizer steps. This smoke run proves serialization/training mechanics only. Save adapter + processor, reload through Transformers 4-bit, and test held-out public images. Save environment `pip freeze`, base revision, adapter hashes, input/split hashes, raw model outputs and errors.

If attempting Ollama, first merge/export using the current upstream Qwen3-VL procedure in a sufficiently large runtime. Account for the vision encoder/projector and correct chat template. Never use a language-only GGUF or an unrelated `mmproj`. Import into a disposable local model name (no push), run the notebook's loopback image probe, compare JSON and visual responses against the exact Transformers adapter on more than one image, and capture versions/logs. `ollama create` succeeding alone does not pass this gate. The notebook does not claim to automate an unverified conversion or import adapters directly.

If the image probe fails, keep `deployment=transformers-4bit` and run offline batch analysis in a GPU runtime; import only validated descriptions with model provenance into JagaAI. Reverting to unmodified local 2B for live use remains an honest separate path. Do not claim an 8B model is live on a 4GB laptop. GGUF conversion can require substantially more RAM/disk than adapter training.

## Checkpoints and comparison

The training cell supports a 10-step smoke mode or an epoch run; save at each epoch and every 10 steps in smoke mode. Set `CHECKPOINT_ROOT` to an already-mounted persistent path if using Drive; this notebook never mounts or accesses an account automatically. `/content` is ephemeral. Verify a checkpoint exists on persistent storage and test `resume_from_checkpoint` before a long run.

Choose whether to fine-tune using the **validation** baseline. If 8B already meets the team's predeclared target, record the reason and skip training. Freeze that decision before testing. The notebook writes raw numerator/denominator metrics and per-class support, along with missing-class warnings, sample IDs and error records. Failed/invalid examples remain in the denominator. Report sequence latency and seconds per sampled input frame; the latter is an amortized measurement, not a detector FPS claim.

## Attribution text

“Public demonstration frames derived from the Multiview Extended Video with Activities (MEVA) dataset, Kitware Inc. and IARPA, CC BY 4.0. Frames extracted/resized by the JagaAI team. Source: https://mevadata.org/. Accessed [actual download date].” Also cite Corona et al., *MEVA: A Large-Scale Multiview, Multimodal Video Dataset for Activity Detection*, WACV 2021. Source/license notes should accompany demo frames and the deck.

Uncompleted work remains visible in `../acceptance.md`; no training or detection results are supplied by this preparation.

Local preparation checks completed on 2026-10-15: standard-library helper self-check, compilation of all notebook code cells, and execution of the default disabled-action path using temporary artifact directories. All comparison rows remained `not_run`. No GPU libraries were installed and no data/model inference or training was performed by those checks. Notebook cells are delivered with null execution counts and empty outputs.
