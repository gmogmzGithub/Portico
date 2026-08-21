#!/usr/bin/env python3
"""Fail-closed validation for Portico release payloads."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import posixpath
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path, PurePosixPath
from typing import Union


APP_BUNDLE_NAME = "Portico.app"
REQUIRED_ARCHES = ("darwin-arm64", "darwin-x64")
BUILTIN_CHANNEL_PACKAGES = ("portico", "portico_beta", "portico_dev")
CUSTOM_CHANNEL_PACKAGE_PREFIX = "portico_"
CUSTOM_CHANNEL_RE = re.compile(r"^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$")
MAX_CUSTOM_CHANNEL_LENGTH = 64
REQUIRED_HOST_TARGETS = (
    "aarch64-apple-darwin",
    "aarch64-unknown-linux-gnu",
    "x86_64-apple-darwin",
    "x86_64-unknown-linux-gnu",
)
REQUIRED_RUNTIME_IMAGE_NAMES = (
    "agent-vm",
    "bifrost-bridge",
    "chat-state-api",
    "health-check",
    "mcp-orc-rust",
    "mcpo-control-plane-rust",
    "open-webui-patched",
)
REQUIRED_RUNTIME_PLATFORMS = ("linux/amd64", "linux/arm64")
RUNTIME_IMAGE_REGISTRY = "harbor.example.invalid/portico"
MAX_RUNTIME_ATTESTATION_BYTES = 64 * 1024
BUILD_ID_RE = re.compile(r"^[0-9]{8}-[a-f0-9]{8,64}$")
FULL_SHA_RE = re.compile(r"^[a-f0-9]{8,64}$")
DIGEST_RE = re.compile(r"^sha256:[a-f0-9]{64}$")
SHA256_RE = re.compile(r"^[a-f0-9]{64}$")
MARKETPLACE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
MR_RUNTIME_TAG_RE = re.compile(r"^mr-([1-9][0-9]*)-([a-f0-9]{40})$")
WINDOWS_ABSOLUTE_RE = re.compile(r"^[A-Za-z]:")
APPLEDOUBLE_ROOT = "__MACOSX"
OOTB_MARKETPLACE_CONFIG = "managed-root/marketplaces-ootb.json"
OOTB_MARKETPLACE_SKILLS_ROOT = "managed-root/skills-marketplace-ootb"


class ValidationError(RuntimeError):
    pass


def is_supported_channel_package(package_name: str) -> bool:
    if package_name in BUILTIN_CHANNEL_PACKAGES:
        return True
    if not package_name.startswith(CUSTOM_CHANNEL_PACKAGE_PREFIX):
        return False

    channel_name = package_name[len(CUSTOM_CHANNEL_PACKAGE_PREFIX) :]
    return bool(
        channel_name
        and len(channel_name) <= MAX_CUSTOM_CHANNEL_LENGTH
        and channel_name not in {"stable", "beta", "dev"}
        and CUSTOM_CHANNEL_RE.fullmatch(channel_name)
    )


def progress(message: str) -> None:
    print(f"[payload-validator] {message}", flush=True)


def safe_archive_name(name: str) -> str:
    if not name or "\x00" in name:
        raise ValidationError("archive contains an empty or NUL-containing path")
    if "\\" in name:
        raise ValidationError(f"archive path uses a backslash separator: {name!r}")
    if name.startswith("/") or WINDOWS_ABSOLUTE_RE.match(name):
        raise ValidationError(f"archive contains an absolute path: {name!r}")

    trimmed = name[:-1] if name.endswith("/") else name
    normalized_path = PurePosixPath(trimmed)
    parts = normalized_path.parts
    if (
        not parts
        or str(normalized_path) != trimmed
        or any(part in ("", ".", "..") for part in parts)
    ):
        raise ValidationError(f"archive contains an unsafe traversal path: {name!r}")
    return trimmed


def validate_symlink_target(entry_name: str, target: str) -> None:
    if not target or "\x00" in target or "\\" in target:
        raise ValidationError(f"archive symlink has an unsafe target: {entry_name!r} -> {target!r}")
    if target.startswith("/") or WINDOWS_ABSOLUTE_RE.match(target):
        raise ValidationError(f"archive symlink has an absolute target: {entry_name!r} -> {target!r}")

    resolved = posixpath.normpath(posixpath.join(posixpath.dirname(entry_name), target))
    if resolved == ".." or resolved.startswith("../") or resolved.startswith("/"):
        raise ValidationError(f"archive symlink escapes the payload: {entry_name!r} -> {target!r}")


class DirectoryPayload:
    def __init__(self, root: Path) -> None:
        self.root = root.resolve(strict=True)
        self.names: set[str] = set()
        self._scan()

    def _scan(self) -> None:
        casefolded: dict[str, str] = {}
        for current_root, directories, files in os.walk(self.root, followlinks=False):
            for basename in [*directories, *files]:
                path = Path(current_root) / basename
                relative = path.relative_to(self.root).as_posix()
                safe_archive_name(relative)
                folded = relative.casefold()
                if folded in casefolded and casefolded[folded] != relative:
                    raise ValidationError(
                        f"payload contains case-colliding paths: {casefolded[folded]!r} and {relative!r}"
                    )
                casefolded[folded] = relative
                self.names.add(relative)

                if path.is_symlink():
                    try:
                        resolved = path.resolve(strict=True)
                        resolved.relative_to(self.root)
                    except (FileNotFoundError, RuntimeError, ValueError) as error:
                        raise ValidationError(
                            f"payload symlink is broken or escapes the payload: {relative!r}"
                        ) from error

    def read_text(self, name: str) -> str:
        try:
            return self.read_bytes(name).decode("utf-8")
        except UnicodeDecodeError as error:
            raise ValidationError(f"unable to read payload file {name}: {error}") from error

    def read_bytes(self, name: str) -> bytes:
        path = self.root / name
        if not path.is_file() or path.is_symlink():
            raise ValidationError(f"required payload file is missing: {name}")
        try:
            return path.read_bytes()
        except OSError as error:
            raise ValidationError(f"unable to read payload file {name}: {error}") from error

    def is_file(self, name: str) -> bool:
        path = self.root / name
        return path.is_file() and not path.is_symlink()

    def is_executable_file(self, name: str) -> bool:
        path = self.root / name
        return self.is_file(name) and os.access(path, os.X_OK)

    def is_directory(self, name: str) -> bool:
        path = self.root / name
        return path.is_dir() and not path.is_symlink()


class ZipPayload:
    def __init__(self, path: Path) -> None:
        self.path = path
        try:
            self.archive = zipfile.ZipFile(path)
        except (OSError, zipfile.BadZipFile) as error:
            raise ValidationError(f"payload is not a readable ZIP archive: {error}") from error

        self.infos: dict[str, zipfile.ZipInfo] = {}
        self.names: set[str] = set()
        try:
            self._scan()
        except Exception:
            self.archive.close()
            raise

    def close(self) -> None:
        self.archive.close()

    def _scan(self) -> None:
        casefolded: dict[str, str] = {}
        for info in self.archive.infolist():
            normalized = safe_archive_name(info.filename)
            if normalized in self.infos:
                raise ValidationError(f"archive contains a duplicate path: {normalized!r}")
            folded = normalized.casefold()
            if folded in casefolded and casefolded[folded] != normalized:
                raise ValidationError(
                    f"archive contains case-colliding paths: {casefolded[folded]!r} and {normalized!r}"
                )
            casefolded[folded] = normalized
            self.infos[normalized] = info
            self.names.add(normalized)

            mode = info.external_attr >> 16
            if stat.S_ISLNK(mode):
                try:
                    target = self.archive.read(info).decode("utf-8")
                except (OSError, UnicodeDecodeError, zipfile.BadZipFile) as error:
                    raise ValidationError(f"unable to read archive symlink {normalized!r}") from error
                validate_symlink_target(normalized, target)

        self._validate_appledouble_entries()

    def _validate_appledouble_entries(self) -> None:
        for name, info in self.infos.items():
            if name == APPLEDOUBLE_ROOT:
                if not info.is_dir():
                    raise ValidationError("archive AppleDouble root must be a directory")
                continue
            if not name.startswith(f"{APPLEDOUBLE_ROOT}/"):
                continue

            mode = info.external_attr >> 16
            if stat.S_ISLNK(mode):
                raise ValidationError(f"archive AppleDouble metadata cannot be a symlink: {name!r}")

            relative = name[len(APPLEDOUBLE_ROOT) + 1 :]
            if info.is_dir():
                target_name = relative.rstrip("/")
            else:
                parts = list(PurePosixPath(relative).parts)
                if not parts or not parts[-1].startswith("._") or parts[-1] == "._":
                    raise ValidationError(
                        f"archive contains malformed AppleDouble metadata: {name!r}"
                    )
                parts[-1] = parts[-1][2:]
                target_name = PurePosixPath(*parts).as_posix()

            if not target_name or target_name not in self.names:
                raise ValidationError(
                    f"archive AppleDouble metadata has no matching payload entry: {name!r}"
                )

    def verify_crc(self) -> None:
        try:
            bad_entry = self.archive.testzip()
        except (OSError, RuntimeError, zipfile.BadZipFile) as error:
            raise ValidationError(f"ZIP CRC validation failed: {error}") from error
        if bad_entry:
            raise ValidationError(f"ZIP CRC validation failed for {bad_entry}")

    def read_text(self, name: str) -> str:
        try:
            return self.read_bytes(name).decode("utf-8")
        except UnicodeDecodeError as error:
            raise ValidationError(f"unable to read payload file {name}: {error}") from error

    def read_bytes(self, name: str) -> bytes:
        info = self.infos.get(name)
        if info is None or info.is_dir() or stat.S_ISLNK(info.external_attr >> 16):
            raise ValidationError(f"required payload file is missing: {name}")
        try:
            return self.archive.read(info)
        except (OSError, zipfile.BadZipFile) as error:
            raise ValidationError(f"unable to read payload file {name}: {error}") from error

    def is_file(self, name: str) -> bool:
        info = self.infos.get(name)
        if info is None or info.is_dir():
            return False
        return not stat.S_ISLNK(info.external_attr >> 16)

    def is_executable_file(self, name: str) -> bool:
        info = self.infos.get(name)
        if not self.is_file(name) or info is None:
            return False
        return bool((info.external_attr >> 16) & 0o111)

    def is_directory(self, name: str) -> bool:
        prefix = name.rstrip("/") + "/"
        exact = self.infos.get(name)
        return bool(exact and exact.is_dir()) or any(entry.startswith(prefix) for entry in self.names)


def required_app_paths() -> dict[str, str]:
    return {
        arch: f"artifacts/apps/{arch}/{APP_BUNDLE_NAME}"
        for arch in REQUIRED_ARCHES
    }


def validate_marketplace_id(value: object, label: str) -> str:
    if not isinstance(value, str) or not MARKETPLACE_ID_RE.fullmatch(value):
        raise ValidationError(f"OOTB marketplace {label} is invalid: {value!r}")
    return value


def validate_baseline_path(value: object, skill_key: str) -> str:
    if not isinstance(value, str):
        raise ValidationError(f"OOTB baseline path is invalid for {skill_key}: {value!r}")
    try:
        return safe_archive_name(value)
    except ValidationError as error:
        raise ValidationError(
            f"OOTB baseline path is invalid for {skill_key}: {value!r}"
        ) from error


def validate_bundled_marketplace_defaults(
    payload: Union[DirectoryPayload, ZipPayload],
    *,
    allow_missing_assets: bool = False,
) -> None:
    missing_config = not payload.is_file(OOTB_MARKETPLACE_CONFIG)
    missing_skills = not payload.is_directory(OOTB_MARKETPLACE_SKILLS_ROOT)
    if allow_missing_assets and (missing_config or missing_skills):
        missing = []
        if missing_config:
            missing.append(OOTB_MARKETPLACE_CONFIG)
        if missing_skills:
            missing.append(f"{OOTB_MARKETPLACE_SKILLS_ROOT}/")
        progress(
            "WARNING: Explicitly allowing missing OOTB marketplace bootstrap assets: "
            + ", ".join(missing)
        )
        return

    if missing_config:
        raise ValidationError(
            f"payload is missing the OOTB marketplace config: {OOTB_MARKETPLACE_CONFIG}"
        )
    if missing_skills:
        raise ValidationError(
            f"payload is missing the OOTB marketplace skills: {OOTB_MARKETPLACE_SKILLS_ROOT}/"
        )

    try:
        config = json.loads(payload.read_text(OOTB_MARKETPLACE_CONFIG))
    except json.JSONDecodeError as error:
        raise ValidationError(f"OOTB marketplace config is invalid JSON: {error}") from error
    if not isinstance(config, dict):
        raise ValidationError("OOTB marketplace config must contain a JSON object")

    marketplaces = config.get("marketplaces")
    installed_skills = config.get("installedSkills")
    if not isinstance(marketplaces, list) or not marketplaces:
        raise ValidationError("OOTB marketplace config must contain a non-empty marketplaces array")
    if not isinstance(installed_skills, list) or not installed_skills:
        raise ValidationError("OOTB marketplace config must contain a non-empty installedSkills array")

    marketplace_ids: set[str] = set()
    for marketplace in marketplaces:
        if not isinstance(marketplace, dict):
            raise ValidationError("OOTB marketplace entries must be JSON objects")
        marketplace_id = validate_marketplace_id(marketplace.get("id"), "id")
        if marketplace_id in marketplace_ids:
            raise ValidationError(f"OOTB marketplace id is duplicated: {marketplace_id}")
        marketplace_ids.add(marketplace_id)

    installed_keys: set[str] = set()
    for installed in installed_skills:
        if not isinstance(installed, dict):
            raise ValidationError("OOTB installed skill entries must be JSON objects")
        marketplace_id = validate_marketplace_id(
            installed.get("marketplaceId"), "installed skill marketplaceId"
        )
        skill_id = validate_marketplace_id(installed.get("skillId"), "installed skill skillId")
        # Plugin-grouped marketplaces nest their skills one directory deeper
        # (skills-marketplace/<marketplace>/<plugin>/<skill>). pluginName is
        # optional; absent means the legacy two-segment layout.
        plugin_name = installed.get("pluginName")
        if plugin_name is not None:
            plugin_name = validate_marketplace_id(
                plugin_name, "installed skill pluginName"
            )
        skill_key = (
            f"{marketplace_id}/{plugin_name}/{skill_id}"
            if plugin_name
            else f"{marketplace_id}/{skill_id}"
        )
        if marketplace_id not in marketplace_ids:
            raise ValidationError(
                f"OOTB installed skill references an unknown marketplace: {skill_key}"
            )
        if skill_key in installed_keys:
            raise ValidationError(f"OOTB installed skill is duplicated: {skill_key}")
        installed_keys.add(skill_key)

        expected_local_path = f"skills-marketplace/{skill_key}"
        if installed.get("localPath") != expected_local_path:
            raise ValidationError(
                f"OOTB installed skill localPath must be {expected_local_path}: {skill_key}"
            )

        payload_skill_root = f"{OOTB_MARKETPLACE_SKILLS_ROOT}/{skill_key}"
        skill_manifest = f"{payload_skill_root}/SKILL.md"
        if not payload.is_file(skill_manifest):
            raise ValidationError(f"OOTB installed skill is missing SKILL.md: {skill_key}")

        baseline = installed.get("baseline")
        if baseline is None:
            continue
        if not isinstance(baseline, dict) or not isinstance(baseline.get("files"), list):
            raise ValidationError(f"OOTB installed skill baseline is invalid: {skill_key}")

        baseline_files: dict[str, str] = {}
        for baseline_file in baseline["files"]:
            if not isinstance(baseline_file, dict):
                raise ValidationError(f"OOTB baseline file entry is invalid: {skill_key}")
            relative_path = validate_baseline_path(baseline_file.get("path"), skill_key)
            expected_hash = baseline_file.get("sha256")
            if not isinstance(expected_hash, str) or not SHA256_RE.fullmatch(expected_hash):
                raise ValidationError(
                    f"OOTB baseline sha256 is invalid for {skill_key}/{relative_path}"
                )
            if relative_path in baseline_files:
                raise ValidationError(
                    f"OOTB baseline path is duplicated for {skill_key}: {relative_path}"
                )
            baseline_files[relative_path] = expected_hash

        actual_files = {
            name[len(payload_skill_root) + 1 :]
            for name in payload.names
            if name.startswith(f"{payload_skill_root}/") and payload.is_file(name)
        }
        if actual_files != set(baseline_files):
            raise ValidationError(f"OOTB baseline file inventory does not match {skill_key}")
        for relative_path, expected_hash in baseline_files.items():
            payload_path = f"{payload_skill_root}/{relative_path}"
            actual_hash = hashlib.sha256(payload.read_bytes(payload_path)).hexdigest()
            if actual_hash != expected_hash:
                raise ValidationError(
                    f"OOTB baseline hash mismatch for {skill_key}/{relative_path}"
                )

    # Coverage sweep: every shipped path must live under a listed skill root
    # (or be an ancestor directory of one — marketplace and plugin folders).
    # Listed roots are the config's own segmented keys, so both the legacy
    # two-segment and the plugin three-segment layouts validate; missing
    # skills are already rejected by the per-row SKILL.md check above, and
    # per-skill file inventories are enforced exactly by the baseline check.
    skills_prefix = f"{OOTB_MARKETPLACE_SKILLS_ROOT}/"
    listed_roots = sorted(
        f"{OOTB_MARKETPLACE_SKILLS_ROOT}/{key}" for key in installed_keys
    )
    unlisted_keys: set[str] = set()
    for name in payload.names:
        if not name.startswith(skills_prefix):
            continue
        if payload.is_file(name):
            # Root-level metadata files (the checked-in tree ships a
            # .gitkeep) are not skill content.
            if "/" not in name[len(skills_prefix) :]:
                continue
            covered = any(name.startswith(f"{root}/") for root in listed_roots)
        else:
            covered = any(
                name == root
                or name.startswith(f"{root}/")
                or root.startswith(f"{name}/")
                for root in listed_roots
            )
        if covered:
            continue
        relative = name[len(skills_prefix) :]
        display_parts = relative.split("/")
        if payload.is_file(name):
            display_parts = display_parts[:-1]
        unlisted_keys.add("/".join(display_parts[:3]) or relative)
    if unlisted_keys:
        # Collapse ancestors: reporting mp/plugin/skill already covers mp and
        # mp/plugin, so only the most specific unlisted keys surface.
        specific_keys = {
            key
            for key in unlisted_keys
            if not any(
                other != key and other.startswith(f"{key}/")
                for other in unlisted_keys
            )
        }
        raise ValidationError(
            "OOTB marketplace skill inventory does not match installedSkills "
            f"(unlisted: {', '.join(sorted(specific_keys))})"
        )


def validate_runtime_image_attestation(
    payload: Union[DirectoryPayload, ZipPayload],
    manifest: dict[str, object],
    full_sha: str,
) -> None:
    attestation_path = manifest.get("runtimeImageAttestation")
    docker_image_tag = manifest.get("dockerImageTag")
    if attestation_path is None:
        if docker_image_tag != manifest.get("buildNumber"):
            raise ValidationError("manifest dockerImageTag must match the release build id")
        return

    if attestation_path != "runtime-image-attestation.json":
        raise ValidationError(
            "manifest runtimeImageAttestation must be 'runtime-image-attestation.json'"
        )
    if len(full_sha) != 40:
        raise ValidationError("attested release payloads require a full 40-character source revision")
    build_number = manifest.get("buildNumber")
    if docker_image_tag not in {full_sha, build_number}:
        mr_tag_match = (
            MR_RUNTIME_TAG_RE.fullmatch(docker_image_tag)
            if isinstance(docker_image_tag, str)
            else None
        )
        if not mr_tag_match or mr_tag_match.group(2) != full_sha:
            raise ValidationError(
                "attested manifest dockerImageTag must be the release build id, "
                "the full source revision, or mr-<iid>-<full-source-revision>"
            )

    raw_attestation = payload.read_text(attestation_path)
    if len(raw_attestation.encode("utf-8")) > MAX_RUNTIME_ATTESTATION_BYTES:
        raise ValidationError("runtime image attestation exceeds 65536 bytes")
    try:
        attestation = json.loads(raw_attestation)
    except json.JSONDecodeError as error:
        raise ValidationError(f"runtime image attestation is invalid JSON: {error}") from error

    if not isinstance(attestation, dict) or set(attestation) != {
        "schemaVersion",
        "sourceRevision",
        "tag",
        "images",
    }:
        raise ValidationError("runtime image attestation has unexpected fields")
    if attestation.get("schemaVersion") != 1:
        raise ValidationError("runtime image attestation schemaVersion must be 1")
    if attestation.get("sourceRevision") != full_sha:
        raise ValidationError("runtime image attestation sourceRevision mismatch")
    if attestation.get("tag") != docker_image_tag:
        raise ValidationError("runtime image attestation tag mismatch")

    images = attestation.get("images")
    if not isinstance(images, list) or len(images) != len(REQUIRED_RUNTIME_IMAGE_NAMES):
        raise ValidationError("runtime image attestation must contain exactly seven images")

    observed_names: list[str] = []
    for image in images:
        if not isinstance(image, dict) or set(image) != {
            "name",
            "reference",
            "indexDigest",
            "platforms",
        }:
            raise ValidationError("runtime image attestation image has unexpected fields")
        name = image.get("name")
        if not isinstance(name, str) or name not in REQUIRED_RUNTIME_IMAGE_NAMES:
            raise ValidationError(f"runtime image attestation contains an unknown image: {name!r}")
        observed_names.append(name)
        expected_reference = f"{RUNTIME_IMAGE_REGISTRY}/{name}:{docker_image_tag}"
        if image.get("reference") != expected_reference:
            raise ValidationError(f"runtime image attestation reference mismatch for {name}")
        index_digest = image.get("indexDigest")
        if not isinstance(index_digest, str) or not DIGEST_RE.fullmatch(index_digest):
            raise ValidationError(f"runtime image attestation index digest is invalid for {name}")

        platforms = image.get("platforms")
        if not isinstance(platforms, dict) or set(platforms) != set(REQUIRED_RUNTIME_PLATFORMS):
            raise ValidationError(f"runtime image attestation platforms are invalid for {name}")
        for platform_name in REQUIRED_RUNTIME_PLATFORMS:
            platform = platforms.get(platform_name)
            if not isinstance(platform, dict) or set(platform) != {
                "digest",
                "revision",
                "version",
            }:
                raise ValidationError(
                    f"runtime image attestation platform has unexpected fields for {name} {platform_name}"
                )
            digest = platform.get("digest")
            if not isinstance(digest, str) or not DIGEST_RE.fullmatch(digest):
                raise ValidationError(
                    f"runtime image attestation digest is invalid for {name} {platform_name}"
                )
            if platform.get("revision") != full_sha:
                raise ValidationError(
                    f"runtime image attestation revision mismatch for {name} {platform_name}"
                )
            if platform.get("version") != docker_image_tag:
                raise ValidationError(
                    f"runtime image attestation version mismatch for {name} {platform_name}"
                )

    if sorted(observed_names) != list(REQUIRED_RUNTIME_IMAGE_NAMES):
        raise ValidationError("runtime image attestation image inventory is incomplete or duplicated")


def load_and_validate_manifest(
    payload: Union[DirectoryPayload, ZipPayload],
    expected_build_id: str,
    expected_channel_package: str,
    *,
    allow_missing_ootb_marketplace_assets: bool = False,
) -> dict[str, object]:
    try:
        manifest = json.loads(payload.read_text("release-manifest.json"))
    except json.JSONDecodeError as error:
        raise ValidationError(f"release-manifest.json is invalid JSON: {error}") from error
    if not isinstance(manifest, dict):
        raise ValidationError("release-manifest.json must contain a JSON object")

    if manifest.get("schemaVersion") != 2:
        raise ValidationError("release-manifest.json schemaVersion must be 2")
    if manifest.get("buildNumber") != expected_build_id:
        raise ValidationError(
            f"manifest buildNumber does not match filename/build identity: {manifest.get('buildNumber')!r}"
        )
    if manifest.get("channelPackageName") != expected_channel_package:
        raise ValidationError(
            "manifest channelPackageName does not match filename/channel identity: "
            f"{manifest.get('channelPackageName')!r}"
        )
    if manifest.get("managedRootDir") != "managed-root":
        raise ValidationError("manifest managedRootDir must be 'managed-root'")

    full_sha = manifest.get("fullSha")
    if not isinstance(full_sha, str) or not FULL_SHA_RE.fullmatch(full_sha):
        raise ValidationError("manifest fullSha must be 8-64 lowercase hexadecimal characters")
    short_revision = expected_build_id.split("-", 1)[1]
    if not full_sha.startswith(short_revision):
        raise ValidationError(
            f"manifest fullSha {full_sha} does not match build id revision {short_revision}"
        )

    validate_runtime_image_attestation(payload, manifest, full_sha)

    expected_apps = required_app_paths()
    if manifest.get("appBundles") != expected_apps:
        raise ValidationError("manifest appBundles must contain exactly the arm64 and x64 release app paths")

    dmgs = manifest.get("dmgs")
    if not isinstance(dmgs, dict) or set(dmgs) != set(REQUIRED_ARCHES):
        raise ValidationError("manifest dmgs must contain exactly darwin-arm64 and darwin-x64")
    for arch in REQUIRED_ARCHES:
        dmg_path = dmgs.get(arch)
        expected_prefix = f"artifacts/dmg/{arch}/"
        if (
            not isinstance(dmg_path, str)
            or safe_archive_name(dmg_path) != dmg_path
            or not dmg_path.startswith(expected_prefix)
            or not dmg_path.lower().endswith(".dmg")
        ):
            raise ValidationError(f"manifest contains an invalid {arch} DMG path: {dmg_path!r}")

    host_targets = manifest.get("hostMcpTargets")
    if not isinstance(host_targets, list) or sorted(host_targets) != list(REQUIRED_HOST_TARGETS):
        raise ValidationError("manifest hostMcpTargets must contain exactly the four required host targets")

    docker_images = manifest.get("dockerImages")
    if not isinstance(docker_images, list) or not docker_images:
        raise ValidationError("manifest dockerImages must be a non-empty array")

    if not payload.is_directory("managed-root"):
        raise ValidationError("payload is missing managed-root/")
    validate_bundled_marketplace_defaults(
        payload,
        allow_missing_assets=allow_missing_ootb_marketplace_assets,
    )
    for arch, app_path in expected_apps.items():
        if not payload.is_directory(app_path):
            raise ValidationError(f"payload is missing the {arch} app bundle: {app_path}")
        build_info_path = f"{app_path}/Contents/Resources/build-info.json"
        try:
            build_info = json.loads(payload.read_text(build_info_path))
        except json.JSONDecodeError as error:
            raise ValidationError(f"{arch} app build-info.json is invalid JSON: {error}") from error
        if not isinstance(build_info, dict):
            raise ValidationError(f"{arch} app build-info.json must contain a JSON object")
        if build_info.get("buildNumber") != expected_build_id:
            raise ValidationError(f"{arch} app buildNumber does not match the release build id")
        if build_info.get("fullSha") != full_sha:
            raise ValidationError(f"{arch} app fullSha does not match release-manifest.json")
        if build_info.get("channel") != expected_channel_package:
            raise ValidationError(f"{arch} app channel does not match the release channel package")
    for arch in REQUIRED_ARCHES:
        dmg_path = str(dmgs[arch])
        if not payload.is_file(dmg_path):
            raise ValidationError(f"payload is missing the {arch} DMG: {dmg_path}")
    for target in REQUIRED_HOST_TARGETS:
        binary_path = f"host-mcp-binaries/{target}/mcp-orc"
        if not payload.is_executable_file(binary_path):
            raise ValidationError(f"payload is missing executable host MCP binary: {binary_path}")

    allowed_arches = set(REQUIRED_ARCHES)
    for name in payload.names:
        for prefix in ("artifacts/apps/", "artifacts/dmg/"):
            if not name.startswith(prefix):
                continue
            remainder = name[len(prefix) :]
            if not remainder:
                continue
            architecture = remainder.split("/", 1)[0]
            if architecture not in allowed_arches:
                raise ValidationError(f"payload contains an unexpected macOS architecture: {architecture}")

    return manifest


def extract_macos_artifacts(payload: ZipPayload, destination: Path) -> None:
    ditto = shutil.which("ditto")
    if ditto is None:
        raise ValidationError(
            "ditto is required to restore macOS signature metadata from release ZIPs"
        )

    run_validation_command(
        [ditto, "-x", "-k", str(payload.path), str(destination)],
        "Apple-preserving release ZIP extraction",
    )


def run_validation_command(command: list[str], description: str) -> None:
    try:
        completed = subprocess.run(
            command,
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
    except OSError as error:
        raise ValidationError(f"unable to run {description}: {error}") from error
    if completed.returncode != 0:
        details = completed.stdout.strip()
        if len(details) > 2000:
            details = details[-2000:]
        raise ValidationError(
            f"{description} failed with exit code {completed.returncode}"
            + (f": {details}" if details else "")
        )


def verify_macos_artifacts(root: Path, manifest: dict[str, object]) -> None:
    if shutil.which("codesign") is None:
        raise ValidationError("codesign is required for macOS release payload validation")
    if shutil.which("spctl") is None:
        raise ValidationError("spctl is required for macOS release payload validation")
    if shutil.which("xcrun") is None:
        raise ValidationError("xcrun is required for macOS notarization-ticket validation")

    apps = required_app_paths()
    dmgs = dict(manifest["dmgs"])
    for arch in REQUIRED_ARCHES:
        app_path = root / apps[arch]
        dmg_path = root / str(dmgs[arch])
        progress(f"Verifying copied {arch} app signature")
        run_validation_command(
            ["codesign", "--verify", "--deep", "--strict", "--verbose=2", str(app_path)],
            f"{arch} app signature validation",
        )
        progress(f"Assessing copied {arch} app with Gatekeeper")
        run_validation_command(
            ["spctl", "--assess", "--type", "execute", "--verbose=2", str(app_path)],
            f"{arch} app Gatekeeper validation",
        )
        progress(f"Validating copied {arch} app notarization ticket")
        run_validation_command(
            ["xcrun", "stapler", "validate", str(app_path)],
            f"{arch} app notarization-ticket validation",
        )
        progress(f"Verifying copied {arch} DMG signature")
        run_validation_command(
            ["codesign", "--verify", "--strict", "--verbose=2", str(dmg_path)],
            f"{arch} DMG signature validation",
        )
        progress(f"Assessing copied {arch} DMG with Gatekeeper")
        run_validation_command(
            [
                "spctl",
                "--assess",
                "--type",
                "open",
                "--context",
                "context:primary-signature",
                "--verbose=2",
                str(dmg_path),
            ],
            f"{arch} DMG Gatekeeper validation",
        )
        progress(f"Validating copied {arch} DMG notarization ticket")
        run_validation_command(
            ["xcrun", "stapler", "validate", str(dmg_path)],
            f"{arch} DMG notarization-ticket validation",
        )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--payload", required=True, type=Path)
    parser.add_argument("--expected-build-id", required=True)
    parser.add_argument("--expected-channel-package", required=True)
    parser.add_argument(
        "--expected-filename",
        help="Logical final ZIP filename when validating a temporary .partial archive",
    )
    parser.add_argument(
        "--verify-macos",
        action="store_true",
        help="Verify app/DMG signatures, Gatekeeper assessments, and stapled notarization tickets",
    )
    parser.add_argument(
        "--allow-missing-ootb-marketplace-assets",
        action="store_true",
        help=(
            "Allow absent top-level OOTB marketplace config/skills assets only; "
            "malformed OOTB assets and every other payload error still fail validation"
        ),
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    payload_path = args.payload.expanduser().resolve()
    expected_filename = f"{args.expected_channel_package}-{args.expected_build_id}.zip"

    if not BUILD_ID_RE.fullmatch(args.expected_build_id):
        raise ValidationError(f"invalid expected build id: {args.expected_build_id}")
    if not is_supported_channel_package(args.expected_channel_package):
        raise ValidationError(f"unsupported expected channel package: {args.expected_channel_package}")
    if args.expected_filename is not None and args.expected_filename != expected_filename:
        raise ValidationError(
            f"logical payload filename must be {expected_filename}, got {args.expected_filename}"
        )
    if args.expected_filename is None and payload_path.is_file() and payload_path.name != expected_filename:
        raise ValidationError(
            f"payload filename must be {expected_filename}, got {payload_path.name}"
        )
    if not payload_path.exists():
        raise ValidationError(f"payload path does not exist: {payload_path}")

    payload: Union[DirectoryPayload, ZipPayload]
    if payload_path.is_dir():
        progress("Checking staged payload paths and symlinks")
        payload = DirectoryPayload(payload_path)
    elif payload_path.is_file():
        progress("Checking ZIP paths and symlinks")
        payload = ZipPayload(payload_path)
        progress("Verifying ZIP CRCs")
        payload.verify_crc()
    else:
        raise ValidationError(f"payload must be a directory or ZIP file: {payload_path}")

    try:
        progress("Validating release manifest and required artifacts")
        manifest = load_and_validate_manifest(
            payload,
            args.expected_build_id,
            args.expected_channel_package,
            allow_missing_ootb_marketplace_assets=(
                args.allow_missing_ootb_marketplace_assets
            ),
        )

        if args.verify_macos:
            if isinstance(payload, ZipPayload):
                progress("Extracting signed macOS artifacts for verification")
                with tempfile.TemporaryDirectory(prefix="portico-payload-validation.") as temp_dir:
                    temp_root = Path(temp_dir)
                    (temp_root / ".portico-payload-validation").touch()
                    extract_macos_artifacts(payload, temp_root)
                    verify_macos_artifacts(temp_root, manifest)
            else:
                verify_macos_artifacts(payload.root, manifest)
    finally:
        if isinstance(payload, ZipPayload):
            payload.close()

    progress("Payload validation passed")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ValidationError as error:
        print(f"Error: {error}", file=sys.stderr)
        raise SystemExit(1)
