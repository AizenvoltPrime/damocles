"""US-014: CPU-mode device selection.

The Parakeet engine's ``select_device`` helper is the single decision
point for cuda-vs-cpu in the real-engine path. These tests exercise the
three runtime modes against mocked CUDA states, so the host running
pytest does not need a real GPU.

Returns a tuple ``(device, auto_fallback_reason, free_vram_mb)``. The
fallback reason surfaces low-VRAM and no-CUDA fallbacks to the host so
the webview can render a yellow "CPU mode" chip (US-013).
"""

from __future__ import annotations

import logging
from dataclasses import replace

import pytest

torch = pytest.importorskip("torch")

from damocles_voice_sidecar.engines.asr_parakeet import (
    CUDA_FREE_VRAM_FLOOR_BYTES,
    select_device,
)
from damocles_voice_sidecar.protocol import ModelLoadFailed, SidecarConfig


def _cfg(**overrides) -> SidecarConfig:
    base = SidecarConfig(port=0, models_dir="/tmp", runtime_mode="auto")
    return replace(base, **overrides)


def test_auto_mode_picks_cpu_when_cuda_unavailable(monkeypatch) -> None:
    monkeypatch.setattr(torch.cuda, "is_available", lambda: False)
    device, reason, free_mb = select_device(_cfg(runtime_mode="auto"))
    assert device == "cpu"
    assert reason == "no-cuda"
    assert free_mb == 0.0


def test_auto_mode_picks_cuda_when_available_with_headroom(monkeypatch) -> None:
    monkeypatch.setattr(torch.cuda, "is_available", lambda: True)
    monkeypatch.setattr(
        torch.cuda,
        "mem_get_info",
        lambda: (CUDA_FREE_VRAM_FLOOR_BYTES + 1, CUDA_FREE_VRAM_FLOOR_BYTES * 2),
    )
    device, reason, free_mb = select_device(_cfg(runtime_mode="auto"))
    assert device == "cuda"
    assert reason is None
    assert free_mb > 0


def test_auto_mode_falls_back_to_cpu_when_vram_below_floor(
    monkeypatch, caplog
) -> None:
    monkeypatch.setattr(torch.cuda, "is_available", lambda: True)
    monkeypatch.setattr(
        torch.cuda,
        "mem_get_info",
        lambda: (CUDA_FREE_VRAM_FLOOR_BYTES - 1, CUDA_FREE_VRAM_FLOOR_BYTES * 2),
    )
    with caplog.at_level(logging.INFO):
        device, reason, free_mb = select_device(_cfg(runtime_mode="auto"))
    assert device == "cpu"
    assert reason == "low-vram"
    assert free_mb > 0
    assert any(
        "auto-fallback" in rec.message and "below 2.5GB" in rec.message
        for rec in caplog.records
    )


def test_cpu_mode_signals_user_pref_when_cuda_was_available(monkeypatch) -> None:
    monkeypatch.setattr(torch.cuda, "is_available", lambda: True)
    monkeypatch.setattr(
        torch.cuda,
        "mem_get_info",
        lambda: (CUDA_FREE_VRAM_FLOOR_BYTES + 1, CUDA_FREE_VRAM_FLOOR_BYTES * 2),
    )
    device, reason, _ = select_device(_cfg(runtime_mode="cpu"))
    assert device == "cpu"
    assert reason == "user-pref"


def test_cpu_mode_no_signal_when_cuda_was_absent(monkeypatch) -> None:
    monkeypatch.setattr(torch.cuda, "is_available", lambda: False)
    device, reason, _ = select_device(_cfg(runtime_mode="cpu"))
    assert device == "cpu"
    assert reason is None


def test_forced_cuda_raises_when_cuda_unavailable(monkeypatch) -> None:
    monkeypatch.setattr(torch.cuda, "is_available", lambda: False)
    with pytest.raises(ModelLoadFailed):
        select_device(_cfg(runtime_mode="cuda"))


def test_forced_cuda_returns_no_fallback(monkeypatch) -> None:
    monkeypatch.setattr(torch.cuda, "is_available", lambda: True)
    monkeypatch.setattr(
        torch.cuda,
        "mem_get_info",
        lambda: (CUDA_FREE_VRAM_FLOOR_BYTES + 1, CUDA_FREE_VRAM_FLOOR_BYTES * 2),
    )
    device, reason, _ = select_device(_cfg(runtime_mode="cuda"))
    assert device == "cuda"
    assert reason is None
