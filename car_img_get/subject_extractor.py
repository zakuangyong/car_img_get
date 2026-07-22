from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any, Optional

import numpy as np
from PIL import Image

@dataclass(frozen=True)
class SubjectResult:
    rgba: Image.Image
    inference_rgb: Image.Image
    mask_coverage: float
    bbox_xyxy: tuple[int, int, int, int]


def project_root() -> Path:
    return Path(__file__).resolve().parent.parent


def default_checkpoint_path() -> Path:
    return project_root() / "models" / "birefnet" / "epoch_120.pth"


def resolve_device(device: str = "auto") -> str:
    import torch

    value = str(device or "auto").strip().lower()
    if value == "auto":
        return "cuda:0" if torch.cuda.is_available() else "cpu"
    if value.isdigit():
        return f"cuda:{value}"
    if value.startswith("cuda") and not torch.cuda.is_available():
        raise RuntimeError(f"requested device {value!r}, but CUDA is unavailable")
    return value


def _clean_state_dict(state_dict: dict) -> dict:
    cleaned = {}
    for key, value in state_dict.items():
        name = str(key)
        for prefix in ("module.", "_orig_mod."):
            if name.startswith(prefix):
                name = name[len(prefix) :]
        cleaned[name] = value
    return cleaned


@lru_cache(maxsize=2)
def _load_model(checkpoint: str, device: str) -> Any:
    import torch
    from .birefnet_model import BiRefNet

    checkpoint_path = Path(checkpoint)
    if not checkpoint_path.is_file():
        raise FileNotFoundError(f"BiRefNet checkpoint not found: {checkpoint_path}")

    model = BiRefNet(bb_pretrained=False)
    state = torch.load(checkpoint_path, map_location="cpu", weights_only=True)
    if isinstance(state, dict) and isinstance(state.get("state_dict"), dict):
        state = state["state_dict"]
    if not isinstance(state, dict):
        raise RuntimeError("BiRefNet checkpoint does not contain a state dict")
    model.load_state_dict(_clean_state_dict(state), strict=True, assign=True)
    model.to(device)
    model.eval()
    return model


class SubjectExtractor:
    def __init__(
        self,
        checkpoint: Optional[Path] = None,
        *,
        device: str = "auto",
        input_size: Optional[int] = None,
        mask_threshold: float = 0.5,
    ) -> None:
        self.checkpoint = (checkpoint or default_checkpoint_path()).resolve()
        self.device = resolve_device(device)
        requested_size = input_size or (768 if self.device.startswith("cuda") else 320)
        self.input_size = max(32, int(requested_size) // 32 * 32)
        self.mask_threshold = max(0.0, min(1.0, float(mask_threshold)))

    def extract(self, image: Image.Image) -> SubjectResult:
        import torch
        import torch.nn.functional as functional

        rgb = image.convert("RGB")
        width, height = rgb.size
        resized = rgb.resize((self.input_size, self.input_size), Image.Resampling.BILINEAR)
        array = np.asarray(resized, dtype=np.float32) / 255.0
        array = (array - np.asarray([0.485, 0.456, 0.406], dtype=np.float32)) / np.asarray(
            [0.229, 0.224, 0.225], dtype=np.float32
        )
        tensor = torch.from_numpy(array.transpose(2, 0, 1)).unsqueeze(0).to(self.device)

        model = _load_model(str(self.checkpoint), self.device)
        autocast_enabled = self.device.startswith("cuda")
        with torch.inference_mode(), torch.amp.autocast(
            device_type="cuda" if autocast_enabled else "cpu",
            dtype=torch.float16,
            enabled=autocast_enabled,
        ):
            logits = model(tensor)[-1]
            mask = logits.sigmoid().to(dtype=torch.float32)
        mask = functional.interpolate(mask, size=(height, width), mode="bilinear", align_corners=True)
        mask_np = mask[0, 0].cpu().numpy().clip(0.0, 1.0)

        foreground = mask_np >= self.mask_threshold
        ys, xs = np.where(foreground)
        if xs.size == 0 or ys.size == 0:
            raise RuntimeError("BiRefNet produced an empty subject mask")

        alpha = np.rint(mask_np * 255.0).astype(np.uint8)
        rgb_np = np.asarray(rgb, dtype=np.uint8)
        rgba_np = np.dstack((rgb_np, alpha))
        rgba = Image.fromarray(rgba_np, mode="RGBA")

        alpha_f = mask_np[..., None]
        white_np = np.rint(rgb_np.astype(np.float32) * alpha_f + 255.0 * (1.0 - alpha_f)).astype(np.uint8)
        inference_rgb = Image.fromarray(white_np, mode="RGB")
        bbox = (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1)
        return SubjectResult(
            rgba=rgba,
            inference_rgb=inference_rgb,
            mask_coverage=float(foreground.mean()),
            bbox_xyxy=bbox,
        )
