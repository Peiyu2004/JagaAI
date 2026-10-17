"""Build the standalone, unexecuted Colab notebook from reviewable source cells."""
from pathlib import Path
import json
import textwrap

HERE = Path(__file__).resolve().parent
cells = []


def markdown(source):
    cells.append({"cell_type": "markdown", "metadata": {},
                  "source": textwrap.dedent(source).strip().splitlines(keepends=True)})


def code(source):
    cells.append({"cell_type": "code", "execution_count": None, "outputs": [],
                  "metadata": {}, "source": textwrap.dedent(source).strip().splitlines(keepends=True)})


markdown("""
# JagaAI · public MEVA / Qwen3-VL experiment

Prepared 2026-10-15. **No GPU run: no training, dataset/model download,
accuracy result, or Ollama adapter export is claimed.** Select a Colab T4 GPU
runtime before enabling GPU actions. Upload only this notebook and a normalized
public-data interval manifest; download selected MEVA videos directly in Colab.
Do not upload local residents' media. This notebook never mounts Drive or pushes
weights to a hub. `/content` is ephemeral; configure persistent storage yourself.

The native MEVA annotation reader is an unresolved input gate: the official
annotation repository/schema could not be retrieved during preparation. This
notebook accepts an explicitly documented JagaAI normalized manifest; it does not
pretend that format is native MEVA JSON/KPF. See `v3/docs/training/README.md`.

Sources checked 2026-10-15:
[MEVA](https://mevadata.org/),
[public S3](https://registry.opendata.aws/mevadata/),
[license](https://mevadata.org/resources/MEVA-data-license.txt),
[NIST classes](https://actev.nist.gov/sdl),
[Qwen 8B](https://huggingface.co/Qwen/Qwen3-VL-8B-Instruct),
[Unsloth vision](https://unsloth.ai/docs/basics/vision-fine-tuning),
[upstream notebook](https://github.com/unslothai/notebooks/blob/main/nb/Qwen3_VL_(8B)-Vision.ipynb),
[Transformers 4-bit](https://huggingface.co/docs/transformers/main/en/quantization/bitsandbytes),
[Ollama import](https://docs.ollama.com/import).
""")

code("""
from pathlib import Path
import json, os, sys, subprocess, time, gc, platform

# All costly/network-dependent actions are opt-in. No account access is automatic.
RUN_INSTALL = False
RUN_BASELINES = False
RUN_TRAINING = False
RUN_FINETUNED_EVAL = False
RUN_GGUF_EXPORT = False
RUN_OLLAMA_PROBE = False  # Local runtime only; Colab cannot see your laptop loopback.
PUBLIC_DATA_ROOT = Path('/content/meva-public')
MANIFEST_PATH = PUBLIC_DATA_ROOT / 'intervals.jsonl'
ARTIFACT_ROOT = Path('/content/jagaai-experiment')
CHECKPOINT_ROOT = ARTIFACT_ROOT / 'checkpoints'  # Change to an already mounted persistent path.
GROUP_BY = 'date'  # Or 'camera_id'. Never randomize individual intervals.
SEED = 20261015
FRAMES_PER_SAMPLE = 4
MAX_IMAGE_SIDE = 336
MAX_LENGTH = 2048
SMOKE_STEPS = 10  # Set None for an epoch run after deployment/reload gates pass.
TRAIN_EPOCHS = 1
RESUME_FROM_CHECKPOINT = None
FINAL_TEST = False  # Compare on validation first; set True only after decisions are frozen.
MIN_VALIDATION_SAMPLES = 10
BASE_2B = 'Qwen/Qwen3-VL-2B-Instruct'
BASE_8B = 'Qwen/Qwen3-VL-8B-Instruct'
ADAPTER_PATH = ARTIFACT_ROOT / 'adapter'
ARTIFACT_ROOT.mkdir(parents=True, exist_ok=True)
print('Status: preparation only. Costly switches:', {key: value for key, value in
      dict(RUN_INSTALL=RUN_INSTALL, RUN_BASELINES=RUN_BASELINES,
           RUN_TRAINING=RUN_TRAINING, RUN_FINETUNED_EVAL=RUN_FINETUNED_EVAL).items()})
""")

markdown("""
## Optional installation and environment record

This installation recipe follows the upstream Colab package family checked on
2026-10-15, including Transformers 4.57.6 and TRL 0.22.2. The full wheel set is not
claimed tested here. If Colab's image changes, compare with the linked current
upstream notebook, restart the runtime after installation, then rerun with
`RUN_INSTALL=False`. Do not force an old Torch/CUDA wheel onto a new runtime.
Record the actual `pip freeze` and model revision for reproducibility.
""")

code("""
if RUN_INSTALL:
    packages = [
        ['sentencepiece', 'protobuf', 'datasets==4.3.0', 'huggingface_hub>=0.34.0', 'hf_transfer'],
        ['--no-deps', 'unsloth_zoo', 'bitsandbytes', 'accelerate', 'peft', 'trl', 'triton', 'unsloth'],
        ['--no-deps', '--upgrade', 'torchao>=0.16.0'],
        ['transformers==4.57.6'],
        ['--no-deps', 'trl==0.22.2'],
        ['opencv-python-headless', 'pillow', 'jsonschema'],
    ]
    for arguments in packages:
        subprocess.run([sys.executable, '-m', 'pip', 'install', *arguments], check=True)
    subprocess.run(['unsloth', 'install-kernels'], check=True)
    print('Restart this runtime before importing Torch/Unsloth.')
else:
    print('Installation skipped.')

freeze = subprocess.run([sys.executable, '-m', 'pip', 'freeze'], text=True,
                        capture_output=True, check=True).stdout
(ARTIFACT_ROOT / 'pip-freeze.txt').write_text(freeze)
(ARTIFACT_ROOT / 'environment.json').write_text(json.dumps({
    'python': sys.version, 'platform': platform.platform(), 'prepared_date': '2026-10-15',
    'actual_run_utc': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
}, indent=2))
""")

markdown("""
## Input contract and helper functions

Each `intervals.jsonl` line must include: `sample_id`, `dataset="MEVA"`,
`license="CC-BY-4.0"`, `source_uri` in the official public S3 bucket,
`source_sha256`, a relative `video_path` below `PUBLIC_DATA_ROOT`,
`annotation_ref` with source annotation/release identity, `camera_id`, `date`,
`start_sec`, `end_sec`, `objects`, `objects_complete`, `activity`, `zone_hint`.
Use `negative_verified=true` for an audited negative (`activity="unknown"`).
The associated object list is not assumed exhaustive unless audited complete.
Do not use model-generated labels as ground truth. Resolve overlapping activity
intervals before sampling. `date` is the source collection date, not Malaysia time.

The next cell is standard-library-only. Its self-check validates helper behavior,
not a model or dataset. No dataset results are embedded in this notebook.
""")

code((HERE / 'training_data.py').read_text(encoding='utf-8').replace(
    'if __name__ == "__main__":\n    print(self_check())', 'print(self_check())'))

code("""
rows = load_manifest(MANIFEST_PATH, PUBLIC_DATA_ROOT) if MANIFEST_PATH.exists() else []
if not rows:
    print('Input gate pending: provide audited public intervals.jsonl and selected public videos.')
    splits = None
else:
    splits = grouped_split(rows, GROUP_BY, SEED)
    split_summary = {name: {'samples': len(part),
                           'groups': sorted({row[GROUP_BY] for row in part}),
                           'activity_counts': dict(Counter(row['activity'] for row in part))}
                     for name, part in splits.items()}
    frozen = {'manifest_sha256': file_hash(MANIFEST_PATH), 'group_by': GROUP_BY,
              'seed': SEED, 'split_hash': stable_hash(splits), 'summary': split_summary,
              'sample_ids': {name: [row['sample_id'] for row in part] for name, part in splits.items()}}
    (ARTIFACT_ROOT / 'split.json').write_text(json.dumps(frozen, indent=2))
    print(json.dumps(split_summary, indent=2))
    for name, part in splits.items():
        absent = set(ACTIVITIES) - {row['activity'] for row in part}
        if absent: print(name, 'absent labels; do not report a score for these:', sorted(absent))
""")

markdown("""
## Deterministic public-frame extraction

Four interior timestamps per annotated interval, in chronological order. Frames
are resized with preserved aspect ratio. The notebook checks bounds/seeks and
retains the actual frame index/time. A missing/bad frame stops the data gate.
Subsampling can miss actions; an action label still needs an appropriate interval.
""")

code("""
def prepare_frames(row):
    import cv2
    from PIL import Image
    destination = ARTIFACT_ROOT / 'frames' / stable_hash({
        'row': row, 'frames': FRAMES_PER_SAMPLE, 'max_side': MAX_IMAGE_SIDE})
    destination.mkdir(parents=True, exist_ok=True)
    capture = cv2.VideoCapture(str(PUBLIC_DATA_ROOT / row['video_path']))
    fps = capture.get(cv2.CAP_PROP_FPS)
    total_frames = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
    if not capture.isOpened() or fps <= 0 or total_frames <= 0:
        capture.release()
        raise ValueError(f"Cannot probe public video: {row['sample_id']}")
    if row['end_sec'] > total_frames / fps + 1 / fps:
        capture.release()
        raise ValueError(f"Annotation interval exceeds source duration: {row['sample_id']}")
    frame_paths, timing = [], []
    try:
        for index in range(FRAMES_PER_SAMPLE):
            requested = row['start_sec'] + (row['end_sec'] - row['start_sec']) * (index + .5) / FRAMES_PER_SAMPLE
            target_frame = min(total_frames - 1, int(requested * fps))
            if not row['start_sec'] <= target_frame / fps < row['end_sec']:
                raise ValueError('Interval too short for bounded frame sampling.')
            if not capture.set(cv2.CAP_PROP_POS_FRAMES, target_frame):
                raise ValueError('Video backend cannot seek to the requested frame.')
            ok, frame = capture.read()
            actual_frame = int(round(capture.get(cv2.CAP_PROP_POS_FRAMES))) - 1
            if not ok or actual_frame != target_frame:
                raise ValueError('Frame seek failed or returned a different frame; no substitution allowed.')
            image = Image.fromarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
            image.thumbnail((MAX_IMAGE_SIDE, MAX_IMAGE_SIDE))
            output = destination / f'{index:02}.jpg'
            image.save(output, quality=92)
            frame_paths.append(str(output))
            timing.append({'requested_sec': requested, 'frame_index': actual_frame,
                           'actual_sec': actual_frame / fps, 'sha256': file_hash(output)})
    finally:
        capture.release()
    result = {**row, 'frames': frame_paths, 'sampling': timing}
    (destination / 'provenance.json').write_text(json.dumps(result, indent=2))
    return result

prepared_splits = None
if splits:
    prepared_splits = {name: [prepare_frames(row) for row in part] for name, part in splits.items()}
    print('Prepared interval counts:', {name: len(part) for name, part in prepared_splits.items()})
""")

markdown("""
## Load one model at a time and score the baseline

Use greedy decoding for reproducibility and record raw outputs. This is an
experimental decoding choice; it is not Qwen's general recommended sampling
configuration. FP16/SDPA is chosen for T4, with NF4 double quantization. Avoid BF16
and FlashAttention-2 on this T4 route. CUDA warmup is recorded separately.
Seconds per frame below is sequence latency divided by input-frame count.

Unsloth is imported before Transformers for compatibility. Turning on inference
downloads the base weights in the Colab runtime if not cached. No cloud inference
endpoint is used, but Colab itself is a cloud GPU, using public inputs only.
""")

code("""
PROMPT = (
    'Describe the visible ordered surveillance frames as one JSON object only. '
    'Use exactly this JSON schema: ' + json.dumps(OUTPUT_SCHEMA) + '. '
    'List visible object classes. Select one supported visible activity; if the '
    'frames do not establish it, use unknown. Use unknown for unclear scene zones. '
    'Do not infer identity, ownership, intent, illegality, suspicion or falling. '
    'Frames are ordered from earliest to latest; do not invent motion between frames.'
)

def gpu_modules():
    import unsloth  # Must precede Transformers in this experimental runtime.
    import torch
    from transformers import Qwen3VLForConditionalGeneration, AutoProcessor, BitsAndBytesConfig
    if not torch.cuda.is_available(): raise RuntimeError('Select a GPU Colab runtime first.')
    return torch, Qwen3VLForConditionalGeneration, AutoProcessor, BitsAndBytesConfig

def load_4bit(base_id, adapter_path=None):
    torch, model_class, processor_class, quant_class = gpu_modules()
    quant = quant_class(load_in_4bit=True, bnb_4bit_quant_type='nf4',
                       bnb_4bit_compute_dtype=torch.float16, bnb_4bit_use_double_quant=True)
    processor = processor_class.from_pretrained(base_id)
    model = model_class.from_pretrained(base_id, quantization_config=quant,
                                       torch_dtype=torch.float16, device_map={'': 0},
                                       attn_implementation='sdpa')
    if adapter_path:
        from peft import PeftModel
        model = PeftModel.from_pretrained(model, str(adapter_path), is_trainable=False)
        processor = processor_class.from_pretrained(str(adapter_path))
    model.eval()
    return model, processor

def predict_sample(model, processor, row):
    import torch
    content = [{'type': 'image', 'image': path} for path in row['frames']]
    content.append({'type': 'text', 'text': PROMPT})
    torch.cuda.synchronize()
    started = time.perf_counter()
    inputs = processor.apply_chat_template([{'role': 'user', 'content': content}],
        tokenize=True, add_generation_prompt=True, return_dict=True, return_tensors='pt').to('cuda')
    if inputs['input_ids'].shape[-1] + 256 > MAX_LENGTH:
        raise ValueError('Input plus output budget exceeds MAX_LENGTH; reduce frames/resolution consistently.')
    with torch.inference_mode():
        generated = model.generate(**inputs, max_new_tokens=256, do_sample=False, use_cache=True)
    torch.cuda.synchronize()
    raw = processor.batch_decode(generated[:, inputs['input_ids'].shape[-1]:],
                                 skip_special_tokens=True)[0]
    return {'sample_id': row['sample_id'], 'raw_response': raw,
            'elapsed_sec': time.perf_counter() - started, 'frame_count': len(row['frames'])}

def evaluate_model(tag, model, processor, sample_rows, metadata):
    import torch
    raw_path = ARTIFACT_ROOT / f'{tag}-predictions.jsonl'
    records = []
    torch.cuda.reset_peak_memory_stats()
    warmup = predict_sample(model, processor, sample_rows[0])
    with raw_path.open('w', encoding='utf-8') as output:
        for row in sample_rows:
            try: record = predict_sample(model, processor, row)
            except Exception as error:
                record = {'sample_id': row['sample_id'], 'raw_response': '',
                          'frame_count': len(row['frames']), 'error': str(error)}
            records.append(record)
            output.write(json.dumps(record) + '\\n')
            output.flush()
    metrics = score_predictions(sample_rows, records)
    report = {**metrics, 'tag': tag, 'provenance': metadata,
              'prompt_sha256': stable_hash(PROMPT), 'schema_sha256': stable_hash(OUTPUT_SCHEMA),
              'samples_sha256': stable_hash([row['sample_id'] for row in sample_rows]),
              'warmup_sec': warmup['elapsed_sec'], 'image_max_side': MAX_IMAGE_SIDE,
              'frame_count': FRAMES_PER_SAMPLE,
              'peak_allocated_bytes': torch.cuda.max_memory_allocated(),
              'gpu': torch.cuda.get_device_name(0), 'decoding': 'greedy_max256',
              'split': 'test' if FINAL_TEST else 'validation'}
    (ARTIFACT_ROOT / f'{tag}-metrics.json').write_text(json.dumps(report, indent=2))
    return report

def release_gpu():
    import torch
    gc.collect()
    torch.cuda.empty_cache()

eval_rows = prepared_splits['test' if FINAL_TEST else 'validation'] if prepared_splits else []
if RUN_BASELINES:
    if len(eval_rows) < MIN_VALIDATION_SAMPLES:
        raise ValueError('Provide enough audited validation/test samples before model evaluation.')
    for tag, base in [('2b-original', BASE_2B), ('8b-original', BASE_8B)]:
        model, processor = load_4bit(base)
        report = evaluate_model(tag, model, processor, eval_rows, {
            'base_model': base, 'revision': getattr(model.config, '_commit_hash', None),
            'quantization': 'bitsandbytes_nf4_double_fp16', 'adapter': None})
        print(tag, report['activity_micro_precision'], report['activity_micro_recall'],
              report['schema_correct_rate'])
        del model, processor
        release_gpu()
else:
    print('GPU baseline evaluation skipped; no metrics claimed.')
""")

markdown("""
## Ten-step deployment smoke or full QLoRA epoch

Requires at least ten training intervals. Only train after inspecting the data and
validation baseline. Start with 10 optimizer steps, save adapter/processor, and
verify reload before a long run. A smoke adapter's metrics are labeled separately;
they are not a completed fine-tuning result. Set `SMOKE_STEPS=None` for full epochs.
Batch 1, LoRA rank 8, accumulation 4, FP16 and checkpointing are conservative
starting settings, not a promise to fit every T4/image sequence.

No Drive mount is hidden in this code. To preserve checkpoints, configure an
already-mounted persistent output path yourself. Resume must use the same split,
base model and training settings. Save checkpoints each epoch (or each ten steps
in smoke mode), plus final adapter. No training/publishing service is contacted.
""")

code("""
if RUN_TRAINING:
    if not prepared_splits or len(prepared_splits['train']) < 10:
        raise ValueError('Training gate: at least ten audited training intervals required.')
    from unsloth import FastVisionModel
    import torch
    from PIL import Image
    from torch.utils.data import Dataset
    from unsloth.trainer import UnslothVisionDataCollator
    from trl import SFTTrainer, SFTConfig
    if not torch.cuda.is_available(): raise RuntimeError('GPU runtime required.')
    CHECKPOINT_ROOT.mkdir(parents=True, exist_ok=True)
    if str(CHECKPOINT_ROOT).startswith('/content/') and not str(CHECKPOINT_ROOT).startswith('/content/drive/'):
        print('Checkpoint path is ephemeral. Persist it before relying on recovery.')
    model, processor = FastVisionModel.from_pretrained(
        BASE_8B, load_in_4bit=True, dtype=torch.float16,
        use_gradient_checkpointing='unsloth', attn_implementation='sdpa')
    model = FastVisionModel.get_peft_model(model, r=8, lora_alpha=8, lora_dropout=0,
        finetune_vision_layers=False, finetune_language_layers=True,
        finetune_attention_modules=True, finetune_mlp_modules=True,
        bias='none', random_state=SEED)

    class IntervalConversations(Dataset):
        def __init__(self, sample_rows): self.sample_rows = sample_rows
        def __len__(self): return len(self.sample_rows)
        def __getitem__(self, index):
            row = self.sample_rows[index]
            pictures = []
            for path in row['frames']:
                with Image.open(path) as image: pictures.append(image.convert('RGB').copy())
            return {'messages': [
                {'role': 'user', 'content': [*({'type': 'image', 'image': image} for image in pictures),
                                             {'type': 'text', 'text': PROMPT}]},
                {'role': 'assistant', 'content': [{'type': 'text', 'text': json.dumps(target_of(row))}]},
            ]}

    FastVisionModel.for_training(model)
    args = SFTConfig(output_dir=str(CHECKPOINT_ROOT), per_device_train_batch_size=1,
        gradient_accumulation_steps=4, learning_rate=1e-4, warmup_steps=1,
        max_steps=SMOKE_STEPS if SMOKE_STEPS else -1, num_train_epochs=TRAIN_EPOCHS,
        fp16=True, bf16=False, optim='adamw_8bit', logging_steps=1,
        save_strategy='steps' if SMOKE_STEPS else 'epoch', save_steps=10, save_total_limit=2,
        seed=SEED, report_to='none', remove_unused_columns=False,
        dataset_text_field='', dataset_kwargs={'skip_prepare_dataset': True}, max_length=MAX_LENGTH)
    trainer = SFTTrainer(model=model, tokenizer=processor, args=args,
        train_dataset=IntervalConversations(prepared_splits['train']),
        data_collator=UnslothVisionDataCollator(model, processor))
    train_result = trainer.train(resume_from_checkpoint=RESUME_FROM_CHECKPOINT)
    ADAPTER_PATH.mkdir(parents=True, exist_ok=True)
    model.save_pretrained(str(ADAPTER_PATH))
    processor.save_pretrained(str(ADAPTER_PATH))
    (ARTIFACT_ROOT / 'training-run.json').write_text(json.dumps({
        'base_model': BASE_8B, 'base_revision': getattr(model.config, '_commit_hash', None),
        'smoke_steps': SMOKE_STEPS, 'intended_epochs': TRAIN_EPOCHS,
        'actual_global_steps': trainer.state.global_step,
        'split_sha256': stable_hash(splits), 'args': args.to_dict(),
        'adapter_files': {str(path.relative_to(ADAPTER_PATH)): file_hash(path)
                          for path in ADAPTER_PATH.rglob('*') if path.is_file()},
        'metrics': train_result.metrics, 'deployment': 'not_verified',
    }, indent=2, default=str))
    print('Adapter saved. Reload verification and deployment gate remain required.')
    # Retain for opt-in GGUF conversion below; clear before a separate full-model reload.
else:
    print('Training skipped. No checkpoint or trained adapter claimed.')
""")

markdown("""
## Explicit export gate (optional) and Transformers 4-bit fallback

Upstream describes GGUF support, but this project's Qwen3-VL multimodal adapter
conversion and Ollama import have **not** been verified. Export may need more
RAM/disk than training. Vision/projector assets, chat template and image support
must survive conversion. Do not use an unrelated projector. No direct `ADAPTER`
Modelfile recipe is asserted. `RUN_GGUF_EXPORT` performs conversion only, not
Ollama installation/import or uploading; inspect produced assets independently.

The supported experiment fallback is to reload the original base in 4-bit and
attach the exact adapter with PEFT. Run this after freeing the training model or
in a fresh runtime. A baseline that suffices can skip fine-tuning entirely.
""")

code("""
if RUN_GGUF_EXPORT:
    if not RUN_TRAINING or 'model' not in globals():
        raise RuntimeError('Export gate requires the trained Unsloth model in this runtime.')
    if not hasattr(model, 'save_pretrained_gguf'):
        raise RuntimeError('Current runtime exposes no GGUF conversion API; use Transformers fallback.')
    export_path = ARTIFACT_ROOT / 'experimental-gguf'
    try:
        model.save_pretrained_gguf(str(export_path), processor, quantization_method='q4_k_m')
        exported = {str(path.relative_to(export_path)): file_hash(path)
                    for path in export_path.rglob('*') if path.is_file()}
        (ARTIFACT_ROOT / 'export-gate.json').write_text(json.dumps({
            'conversion_completed': True, 'files': exported,
            'ollama_image_probe_passed': False, 'status': 'conversion_only_unverified_deployment'}, indent=2))
    except Exception as error:
        (ARTIFACT_ROOT / 'export-gate.json').write_text(json.dumps({
            'conversion_completed': False, 'error': str(error),
            'deployment': 'transformers-4bit'}, indent=2))
        print('Conversion failed. Retain saved adapter; use Transformers 4-bit fallback:', error)
else:
    print('GGUF conversion skipped; Ollama export unverified.')

if RUN_FINETUNED_EVAL:
    if not ADAPTER_PATH.is_dir() or not eval_rows:
        raise ValueError('Need the saved adapter and frozen evaluation samples.')
    if 'trainer' in globals(): del trainer
    if 'model' in globals(): del model
    if 'processor' in globals(): del processor
    release_gpu()
    model, processor = load_4bit(BASE_8B, ADAPTER_PATH)
    metadata = json.loads((ARTIFACT_ROOT / 'training-run.json').read_text())
    tag = '8b-smoke-adapter' if metadata['smoke_steps'] else '8b-finetuned'
    report = evaluate_model(tag, model, processor, eval_rows, {
        'base_model': BASE_8B, 'revision': getattr(model.config, '_commit_hash', None),
        'quantization': 'bitsandbytes_nf4_double_fp16',
        'adapter_files': metadata['adapter_files'], 'training_steps': metadata['actual_global_steps'],
        'deployment': 'transformers-4bit'})
    print(tag, report['activity_micro_precision'], report['activity_micro_recall'], report['schema_correct_rate'])
    del model, processor
    release_gpu()
""")

markdown("""
## Local-only Ollama image probe after a separately verified import

Run this cell in a local Python/Jupyter runtime with an already-created disposable
Ollama model and public test frames. It does not connect Colab to the laptop, start
Ollama, create a model, or push weights. `ollama create` alone is insufficient:
verify image-conditioned output on several distinct public scenes, compare to
the exact adapter's Transformers outputs, and retain the version/logs. The schema
probe alone cannot prove the fine-tuned weights or vision encoder were preserved.
""")

code("""
OLLAMA_BASE = 'http://127.0.0.1:11434'
OLLAMA_CANDIDATE = ''  # Created by a separately validated conversion/import process.
PUBLIC_PROBE_IMAGES = []  # At least two distinct public images, already present locally.

if RUN_OLLAMA_PROBE:
    import urllib.request, urllib.parse, base64
    endpoint = urllib.parse.urlsplit(OLLAMA_BASE)
    if (endpoint.scheme != 'http' or endpoint.hostname not in ('127.0.0.1', '::1')
            or endpoint.username or endpoint.password or endpoint.path not in ('', '/')
            or endpoint.query or endpoint.fragment):
        raise ValueError('Probe accepts loopback HTTP only.')
    if not OLLAMA_CANDIDATE or len(PUBLIC_PROBE_IMAGES) < 2:
        raise ValueError('Set the imported model name and at least two public test images.')
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, request, fp, code, msg, headers, new_url):
            raise RuntimeError('Redirects disabled for local media probe.')
    opener = urllib.request.build_opener(NoRedirect, urllib.request.ProxyHandler({}))
    def ollama_request(route, body=None):
        request = urllib.request.Request(OLLAMA_BASE.rstrip('/') + route,
            data=json.dumps(body).encode() if body is not None else None,
            headers={'Content-Type': 'application/json'})
        with opener.open(request, timeout=180) as response: return json.load(response)
    version = ollama_request('/api/version')
    probes = []
    for image in PUBLIC_PROBE_IMAGES:
        path = Path(image).resolve()
        if not path.is_relative_to(PUBLIC_DATA_ROOT.resolve()):
            raise ValueError('Probe image must be below the public-only dataset root.')
        answer = ollama_request('/api/generate', {'model': OLLAMA_CANDIDATE,
            'prompt': PROMPT, 'images': [base64.b64encode(path.read_bytes()).decode()],
            'format': OUTPUT_SCHEMA, 'stream': False, 'options': {'temperature': 0}})
        raw = answer.get('response', '')
        try: validate_target(json.loads(raw)); schema_passed = True
        except (ValueError, TypeError): schema_passed = False
        probes.append({'image_sha256': file_hash(path), 'raw_response': raw,
                       'schema_passed': schema_passed})
    (ARTIFACT_ROOT / 'ollama-image-probe.json').write_text(json.dumps({
        'version': version, 'model': OLLAMA_CANDIDATE, 'probes': probes,
        'visual_adapter_equivalence': 'requires_manual_comparison_not_established'}, indent=2))
    print('Image probe recorded; compare visual semantics and adapter equivalence before claiming deployment.')
else:
    print('Ollama image probe skipped. Multimodal fine-tuned import remains unverified.')
""")

markdown("""
## Review the comparison and retain evidence

Keep split/input hashes, model revisions, exact adapter hashes, environment,
sampling provenance and raw responses alongside metrics. Never replace a failed
or missing run with a fabricated result. Missing classes have no established
recall. Do not tune the system after seeing final test results without declaring
a new holdout. Add MEVA/CC BY attribution to exported public frames and deck.
Do not interpret this activity classifier as ownership/intent or automatic crime
detection. Domain transfer to Malaysian housing still needs its own evaluation.
""")

code("""
comparison = []
for tag in ('2b-original', '8b-original', '8b-finetuned', '8b-smoke-adapter'):
    path = ARTIFACT_ROOT / f'{tag}-metrics.json'
    if not path.exists():
        comparison.append({'model': tag, 'status': 'not_run'})
        continue
    result = json.loads(path.read_text())
    comparison.append({'model': tag, 'status': 'measured',
        'split': result['split'], 'samples': result['samples'],
        'precision': result['activity_micro_precision'], 'recall': result['activity_micro_recall'],
        'schema_rate': result['schema_correct_rate'],
        'seconds_per_sequence': result['mean_seconds_per_sequence'],
        'seconds_per_input_frame': result['mean_amortized_seconds_per_input_frame'],
        'sample_hash': result['samples_sha256'], 'prompt_hash': result['prompt_sha256']})
(ARTIFACT_ROOT / 'comparison.json').write_text(json.dumps(comparison, indent=2))
print(json.dumps(comparison, indent=2))
""")

notebook = {
    "cells": cells,
    "metadata": {"kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"},
                 "language_info": {"name": "python", "version": "3.11"},
                 "colab": {"provenance": [], "gpuType": "T4"}, "accelerator": "GPU"},
    "nbformat": 4, "nbformat_minor": 5,
}
for i, cell in enumerate(cells):
    cell["id"] = f"jagaai-{i:03}"
    if cell["cell_type"] == "code":
        compile("".join(cell["source"]), f"cell_{i}", "exec")
destination = HERE.parent.parent / 'notebooks' / 'JagaAI_MEVA_QLoRA.ipynb'
destination.parent.mkdir(parents=True, exist_ok=True)
destination.write_text(json.dumps(notebook, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
print(f"Built {destination.name}: {len(cells)} cells, all code cells compile, no execution outputs.")
