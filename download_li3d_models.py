from __future__ import annotations

import os
import sys
import time
from pathlib import Path

import requests
from huggingface_hub import hf_hub_url


TASKS = [
    {
        "repo": "lokCX/4x-Ultrasharp",
        "file": "4x-UltraSharp.pth",
        "target": r"C:\Users\rentian\Downloads\ComfyUI-aki-v3\ComfyUI\models\upscale_models\4x-UltraSharp.pth",
        "size": 66_961_958,
    },
    {
        "repo": "Comfy-Org/z_image_turbo",
        "file": "split_files/diffusion_models/z_image_turbo_bf16.safetensors",
        "target": r"C:\Users\rentian\Downloads\ComfyUI-aki-v3\ComfyUI\models\unet\z_image_turbo_bf16.safetensors",
        "size": 12_309_866_400,
    },
    {
        "repo": "Comfy-Org/z_image_turbo",
        "file": "split_files/text_encoders/qwen_3_4b.safetensors",
        "target": r"C:\Users\rentian\Downloads\ComfyUI-aki-v3\ComfyUI\models\clip\qwen_3_4b.safetensors",
        "size": 8_044_982_048,
    },
    {
        "repo": "alibaba-pai/Z-Image-Turbo-Fun-Controlnet-Union-2.1",
        "file": "Z-Image-Turbo-Fun-Controlnet-Union-2.1-2602-8steps.safetensors",
        "target": r"C:\Users\rentian\Downloads\ComfyUI-aki-v3\ComfyUI\models\model_patches\Z-Image-Turbo-Fun-Controlnet-Union-2.1-2602-8steps.safetensors",
        "size": 6_712_485_600,
    },
]


def log(message: str) -> None:
    print(time.strftime("[%Y-%m-%d %H:%M:%S]"), message, flush=True)


def download(task: dict[str, object]) -> None:
    repo = str(task["repo"])
    filename = str(task["file"])
    target = Path(str(task["target"]))
    expected = int(task["size"])
    part = target.with_suffix(target.suffix + ".part")
    target.parent.mkdir(parents=True, exist_ok=True)

    if target.exists() and target.stat().st_size == expected:
        log(f"SKIP {target.name}: already complete ({expected} bytes)")
        return

    url = hf_hub_url(repo_id=repo, filename=filename)
    downloaded = part.stat().st_size if part.exists() else 0
    if downloaded > expected:
        part.unlink()
        downloaded = 0

    headers = {}
    mode = "wb"
    if downloaded:
        headers["Range"] = f"bytes={downloaded}-"
        mode = "ab"
        log(f"RESUME {target.name}: {downloaded / 1024**3:.2f} GiB already present")
    else:
        log(f"START {target.name}: {expected / 1024**3:.2f} GiB")

    with requests.get(url, stream=True, headers=headers, timeout=(30, 120)) as response:
        if response.status_code == 416 and downloaded == expected:
            part.replace(target)
            log(f"OK {target.name}: completed from existing partial")
            return
        if response.status_code not in (200, 206):
            raise RuntimeError(f"HTTP {response.status_code} while downloading {repo}/{filename}: {response.text[:300]}")
        if downloaded and response.status_code == 200:
            log(f"SERVER ignored resume for {target.name}; restarting")
            downloaded = 0
            mode = "wb"

        last_report = time.monotonic()
        with part.open(mode + "") as fh:
            for chunk in response.iter_content(chunk_size=16 * 1024 * 1024):
                if not chunk:
                    continue
                fh.write(chunk)
                downloaded += len(chunk)
                now = time.monotonic()
                if now - last_report >= 20:
                    pct = downloaded / expected * 100
                    log(f"PROGRESS {target.name}: {downloaded / 1024**3:.2f}/{expected / 1024**3:.2f} GiB ({pct:.1f}%)")
                    last_report = now

    size = part.stat().st_size
    if size != expected:
        raise RuntimeError(f"Size mismatch for {target.name}: got {size}, expected {expected}")
    if target.exists():
        target.unlink()
    part.replace(target)
    log(f"OK {target.name}: {expected} bytes")


def main() -> int:
    log("Download job started")
    for task in TASKS:
        download(task)
    log("ALL DONE")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        log(f"ERROR {type(exc).__name__}: {exc}")
        raise
