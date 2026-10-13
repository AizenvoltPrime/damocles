from __future__ import annotations

import shutil
import subprocess
import sys
import wave

import numpy as np
import pytest


@pytest.fixture(scope="session")
def sapi(tmp_path_factory):
    """Synthesize ``text`` with a SAPI voice as 16 kHz int16 mono, trimmed to the speech."""
    powershell = shutil.which("powershell.exe")
    if sys.platform != "win32" or powershell is None:
        pytest.skip("speech clips are synthesized with Windows SAPI")
    out_dir = tmp_path_factory.mktemp("sapi")

    def synth(text: str, voice: str, rate: int = 0) -> np.ndarray:
        path = out_dir / f"{abs(hash((text, voice, rate)))}.wav"
        script = (
            "Add-Type -AssemblyName System.Speech;"
            "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;"
            f"$s.SelectVoice('{voice}'); $s.Rate = {rate};"
            "$f = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000,"
            " [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,"
            " [System.Speech.AudioFormat.AudioChannel]::Mono);"
            f"$s.SetOutputToWaveFile('{path}', $f); $s.Speak('{text}'); $s.Dispose()"
        )
        done = subprocess.run(
            [powershell, "-NoProfile", "-NonInteractive", "-Command", script],
            capture_output=True,
            text=True,
            timeout=60,
        )
        if done.returncode != 0 or not path.is_file():
            pytest.skip(f"SAPI voice {voice!r} unavailable: {done.stderr.strip()[:200]}")
        with wave.open(str(path), "rb") as wav:
            pcm = np.frombuffer(wav.readframes(wav.getnframes()), dtype=np.int16)
        loud = np.flatnonzero(np.abs(pcm) > 0.01 * np.abs(pcm).max())
        return pcm[loud[0] : loud[-1] + 1]

    return synth
