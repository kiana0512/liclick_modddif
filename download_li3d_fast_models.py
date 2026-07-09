from __future__ import annotations

import os
import time
from pathlib import Path

import requests
from huggingface_hub import hf_hub_url


TASKS = [
    {
        "repo": "Comfy-Org/z_image_turbo",
        "file": "split_files/diffusion_models/z_image_turbo_int8_convrot.safetensors",
        "target": r"C:\Users\rentian\Downloads\ComfyUI-aki-v3\ComfyUI\models\unet\z_image_turbo_int8_convrot.safetensors",
        "size": 6_201_001_296,
    },
    {
        "repo": "Comfy-Org/z_image_turbo",
        "file": "split_files/text_encoders/qwen_3_4b_fp8_mixed.safetensors",
        "target": r"C:\Users\rentian\Downloads\ComfyUI-aki-v3\ComfyUI\models\clip\qwen_3_4b_fp8_mixed.safetensors",
        "size": 5_631_994_051,
    },
    {
        "repo": "alibaba-pai/Z-Image-Turbo-Fun-Controlnet-Union-2.1",
        "file": "Z-Image-Turbo-Fun-Controlnet-Union-2.1-lite-2602-8steps.safetensors",
        "target": r"C:\Users\rentian\Downloads\ComfyUI-aki-v3\ComfyUI\models\model_patches\Z-Image-Turbo-Fun-Controlnet-Union-2.1-lite-2602-8steps.safetensors",
        "size": 2_016_627_488,
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

    downloaded = part.stat().st_size if part.exists() else 0
    if downloaded > expected:
        part.unlink()
        downloaded = 0

    headers = {}
    mode = "wb"
    if downloaded:
        headers["Range"] = f"bytes={downloaded}-"
        mode = "ab"
        log(f"RESUME {target.name}: {downloaded / 1024**3:.2f} GiB")
    else:
        log(f"START {target.name}: {expected / 1024**3:.2f} GiB")

    url = hf_hub_url(repo_id=repo, filename=filename)
    with requests.get(url, stream=True, headers=headers, timeout=(30, 120)) as response:
        if response.status_code not in (200, 206):
            raise RuntimeError(f"HTTP {response.status_code} for {repo}/{filename}: {response.text[:300]}")
        if downloaded and response.status_code == 200:
            log(f"SERVER ignored resume for {target.name}; restarting")
            downloaded = 0
            mode = "wb"
        last_report = time.monotonic()
        with part.open(mode) as fh:
            for chunk in response.iter_content(chunk_size=16 * 1024 * 1024):
                if not chunk:
                    continue
                fh.write(chunk)
                downloaded += len(chunk)
                now = time.monotonic()
                if now - last_report >= 20:
                    log(
                        f"PROGRESS {target.name}: "
                        f"{downloaded / 1024**3:.2f}/{expected / 1024**3:.2f} GiB "
                        f"({downloaded / expected * 100:.1f}%)",
                    )
                    last_report = now

    size = part.stat().st_size
    if size != expected:
        raise RuntimeError(f"Size mismatch for {target.name}: got {size}, expected {expected}")
    if target.exists():
        target.unlink()
    part.replace(target)
    log(f"OK {target.name}: {expected} bytes")


def main() -> int:
    log("Fast model download job started")
    for task in TASKS:
        download(task)
    log("ALL DONE")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
