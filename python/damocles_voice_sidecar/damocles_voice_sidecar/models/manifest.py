"""Read MODEL_MANIFEST.json bundled with the package.

This is the Python-side counterpart to ``src/extension/voice/models/manifest.ts``.
The TS downloader writes models into ``<modelsDir>/<id>/v<version>/`` (see
``modelVersionDir`` over there); this module exposes the same path
construction so the engines locate downloaded files at exactly the path
the downloader created.
"""

from __future__ import annotations

import json
import os
from importlib import resources
from typing import Any


def load_manifest() -> dict[str, Any]:
    """Return the parsed MODEL_MANIFEST.json bundled with the package."""
    src = resources.files("damocles_voice_sidecar.models").joinpath("MODEL_MANIFEST.json")
    return json.loads(src.read_text(encoding="utf-8"))


def model_version_dir(models_dir: str, model_id: str) -> str:
    """Path to the manifest-versioned subdirectory for ``model_id``.

    Mirrors the TypeScript ``modelVersionDir``: ``<models_dir>/<id>/v<version>``.
    Raises ``KeyError`` if ``model_id`` is not present in the manifest.
    """
    manifest = load_manifest()
    entry = manifest.get("models", {}).get(model_id)
    if entry is None or "version" not in entry:
        raise KeyError(f"model {model_id!r} not found in MODEL_MANIFEST.json")
    return os.path.join(models_dir, model_id, f"v{entry['version']}")


def model_file_sha256(model_id: str, filename: str) -> str:
    """Lookup expected SHA-256 for a manifest-tracked file. Raises if unknown."""
    manifest = load_manifest()
    entry = manifest.get("models", {}).get(model_id)
    if entry is None:
        raise KeyError(f"model {model_id!r} not found in MODEL_MANIFEST.json")
    for f in entry.get("files", []):
        if f.get("filename") == filename:
            sha = f.get("sha256")
            if not isinstance(sha, str) or len(sha) != 64:
                raise ValueError(
                    f"manifest entry for {model_id}/{filename} has invalid sha256"
                )
            return sha
    raise KeyError(f"file {filename!r} not listed for model {model_id!r}")
