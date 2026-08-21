import hashlib
import json
import os
import shutil
import stat
import subprocess
import tempfile
import unittest
import zipfile
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
VALIDATOR = PROJECT_ROOT / "src" / "scripts" / "validate-release-payload.py"
BUILD_ID = "06182026-deadbeef"
FULL_SHA = "deadbeefcafefeeddeadbeefcafefeeddeadbeef"
CHANNEL_PACKAGE = "portico_dev"
FILENAME = f"{CHANNEL_PACKAGE}-{BUILD_ID}.zip"
ARCHES = ("darwin-arm64", "darwin-x64")
HOST_TARGETS = (
    "aarch64-apple-darwin",
    "aarch64-unknown-linux-gnu",
    "x86_64-apple-darwin",
    "x86_64-unknown-linux-gnu",
)
RUNTIME_IMAGE_NAMES = (
    "agent-vm",
    "bifrost-bridge",
    "chat-state-api",
    "health-check",
    "mcp-orc-rust",
    "mcpo-control-plane-rust",
    "open-webui-patched",
)


class ReleasePayloadValidatorTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = Path(tempfile.mkdtemp(prefix="release-payload-validator-test."))
        self.payload_dir = self.temp_dir / "payload"
        self.make_payload_tree(self.payload_dir)

    def tearDown(self):
        shutil.rmtree(self.temp_dir)

    def make_payload_tree(self, root: Path):
        (root / "managed-root").mkdir(parents=True)
        (root / "managed-root" / "bootstrap.sh").write_text("#!/bin/sh\n", encoding="utf-8")
        ootb_skill = (
            root
            / "managed-root"
            / "skills-marketplace-ootb"
            / "example-marketplace"
            / "example-skill"
            / "SKILL.md"
        )
        ootb_skill.parent.mkdir(parents=True)
        ootb_skill_content = "---\nname: example-skill\n---\n# Example Skill\n"
        ootb_skill.write_text(ootb_skill_content, encoding="utf-8")
        # Plugin-grouped form: the marketplace nests this skill one directory
        # deeper and the config row carries pluginName.
        plugin_skill = (
            root
            / "managed-root"
            / "skills-marketplace-ootb"
            / "example-marketplace"
            / "example-plugin"
            / "plugin-skill"
            / "SKILL.md"
        )
        plugin_skill.parent.mkdir(parents=True)
        plugin_skill_content = "---\nname: plugin-skill\n---\n# Plugin Skill\n"
        plugin_skill.write_text(plugin_skill_content, encoding="utf-8")
        # The checked-in skills tree ships a root-level .gitkeep; it is
        # metadata, not skill content, and must not trip the inventory sweep.
        (
            root / "managed-root" / "skills-marketplace-ootb" / ".gitkeep"
        ).write_text("", encoding="utf-8")
        ootb_config = {
            "version": "1.0",
            "marketplaces": [{"id": "example-marketplace", "enabled": True}],
            "installedSkills": [
                {
                    "marketplaceId": "example-marketplace",
                    "skillId": "example-skill",
                    "localPath": "skills-marketplace/example-marketplace/example-skill",
                    "baseline": {
                        "files": [
                            {
                                "path": "SKILL.md",
                                "sha256": hashlib.sha256(
                                    ootb_skill_content.encode("utf-8")
                                ).hexdigest(),
                            }
                        ]
                    },
                },
                {
                    "marketplaceId": "example-marketplace",
                    "skillId": "plugin-skill",
                    "pluginName": "example-plugin",
                    "localPath": "skills-marketplace/example-marketplace/example-plugin/plugin-skill",
                    "baseline": {
                        "files": [
                            {
                                "path": "SKILL.md",
                                "sha256": hashlib.sha256(
                                    plugin_skill_content.encode("utf-8")
                                ).hexdigest(),
                            }
                        ]
                    },
                },
            ],
        }
        (root / "managed-root" / "marketplaces-ootb.json").write_text(
            json.dumps(ootb_config, indent=2) + "\n",
            encoding="utf-8",
        )

        app_paths = {}
        dmg_paths = {}
        for arch in ARCHES:
            app_relative = f"artifacts/apps/{arch}/Portico.app"
            app_paths[arch] = app_relative
            executable = root / app_relative / "Contents" / "MacOS" / "Portico"
            executable.parent.mkdir(parents=True)
            executable.write_text("#!/bin/sh\n", encoding="utf-8")
            executable.chmod(0o755)
            build_info = executable.parents[1] / "Resources" / "build-info.json"
            build_info.parent.mkdir(parents=True)
            build_info.write_text(
                json.dumps(
                    {
                        "buildNumber": BUILD_ID,
                        "fullSha": FULL_SHA,
                        "channel": CHANNEL_PACKAGE,
                    }
                ),
                encoding="utf-8",
            )

            suffix = "-arm64" if arch == "darwin-arm64" else ""
            dmg_relative = f"artifacts/dmg/{arch}/Portico-1.0.0{suffix}.dmg"
            dmg_paths[arch] = dmg_relative
            dmg = root / dmg_relative
            dmg.parent.mkdir(parents=True)
            dmg.write_bytes(f"{arch} dmg".encode())

        for target in HOST_TARGETS:
            binary = root / "host-mcp-binaries" / target / "mcp-orc"
            binary.parent.mkdir(parents=True)
            binary.write_text("#!/bin/sh\n", encoding="utf-8")
            binary.chmod(0o755)

        manifest = {
            "schemaVersion": 2,
            "buildNumber": BUILD_ID,
            "fullSha": FULL_SHA,
            "channelPackageName": CHANNEL_PACKAGE,
            "managedRootDir": "managed-root",
            "dockerImageTag": BUILD_ID,
            "dockerImages": [{"name": "example.invalid/runtime", "tag": BUILD_ID}],
            "appBundles": app_paths,
            "dmgs": dmg_paths,
            "hostMcpTargets": list(HOST_TARGETS),
        }
        (root / "release-manifest.json").write_text(
            json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
        )

    def make_zip(self, name=FILENAME):
        archive_path = self.temp_dir / name
        with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for path in sorted(self.payload_dir.rglob("*")):
                archive.write(path, path.relative_to(self.payload_dir).as_posix())
        return archive_path

    def reset_payload(self):
        shutil.rmtree(self.payload_dir)
        self.make_payload_tree(self.payload_dir)

    def read_ootb_config(self):
        config_path = self.payload_dir / "managed-root" / "marketplaces-ootb.json"
        return config_path, json.loads(config_path.read_text(encoding="utf-8"))

    def run_validator(
        self,
        payload: Path,
        *extra,
        env=None,
        expected_channel=CHANNEL_PACKAGE,
        expected_filename=FILENAME,
    ):
        command = [
            "python3",
            str(VALIDATOR),
            "--payload",
            str(payload),
            "--expected-build-id",
            BUILD_ID,
            "--expected-channel-package",
            expected_channel,
        ]
        if payload.is_dir():
            command.extend(["--expected-filename", expected_filename])
        command.extend(extra)
        return subprocess.run(
            command,
            cwd=PROJECT_ROOT,
            env=env,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        )

    def set_payload_channel(self, channel_package: str):
        manifest_path = self.payload_dir / "release-manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["channelPackageName"] = channel_package
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

        for arch in ARCHES:
            build_info_path = (
                self.payload_dir
                / f"artifacts/apps/{arch}/Portico.app/Contents/Resources/build-info.json"
            )
            build_info = json.loads(build_info_path.read_text(encoding="utf-8"))
            build_info["channel"] = channel_package
            build_info_path.write_text(
                json.dumps(build_info, indent=2) + "\n",
                encoding="utf-8",
            )

    def add_runtime_image_attestation(self, tag=FULL_SHA):
        manifest_path = self.payload_dir / "release-manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["dockerImageTag"] = tag
        manifest["runtimeImageAttestation"] = "runtime-image-attestation.json"
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

        attestation = {
            "schemaVersion": 1,
            "sourceRevision": FULL_SHA,
            "tag": tag,
            "images": [],
        }
        for index, name in enumerate(RUNTIME_IMAGE_NAMES, start=1):
            attestation["images"].append(
                {
                    "name": name,
                    "reference": (
                        f"harbor.example.invalid/portico/{name}:{tag}"
                    ),
                    "indexDigest": f"sha256:{str(index) * 64}",
                    "platforms": {
                        "linux/amd64": {
                            "digest": f"sha256:{'a' * 64}",
                            "revision": FULL_SHA,
                            "version": tag,
                        },
                        "linux/arm64": {
                            "digest": f"sha256:{'b' * 64}",
                            "revision": FULL_SHA,
                            "version": tag,
                        },
                    },
                }
            )
        (self.payload_dir / "runtime-image-attestation.json").write_text(
            json.dumps(attestation, indent=2) + "\n",
            encoding="utf-8",
        )

    def test_custom_release_channel_package_is_accepted(self):
        channel_package = "portico_team-alpha"
        filename = f"{channel_package}-{BUILD_ID}.zip"
        self.set_payload_channel(channel_package)
        archive = self.make_zip(filename)

        result = self.run_validator(
            archive,
            expected_channel=channel_package,
            expected_filename=filename,
        )

        self.assertEqual(result.returncode, 0, result.stdout)

    def test_unsafe_or_reserved_custom_release_channel_package_is_rejected(self):
        for channel_package in (
            "portico_team.alpha",
            "portico_-team",
            "portico_team-",
            "portico_stable",
        ):
            with self.subTest(channel_package=channel_package):
                result = self.run_validator(
                    self.payload_dir,
                    expected_channel=channel_package,
                    expected_filename=f"{channel_package}-{BUILD_ID}.zip",
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("unsupported expected channel package", result.stdout)

    def install_fake_macos_tools(
        self,
        fail_dmg_stapler=False,
        fail_codesign=False,
        fail_dmg_codesign=False,
        fail_dmg_gatekeeper=False,
    ):
        bin_dir = self.temp_dir / "bin"
        bin_dir.mkdir()
        log_path = self.temp_dir / "mac-tools.log"
        codesign = bin_dir / "codesign"
        spctl = bin_dir / "spctl"
        xcrun = bin_dir / "xcrun"
        ditto = bin_dir / "ditto"
        codesign.write_text(
            "#!/bin/sh\nprintf 'codesign %s\\n' \"$*\" >> \"$VALIDATION_TOOL_LOG\"\n"
            + ("exit 31\n" if fail_codesign else "")
            + ("case \"$*\" in *.dmg*) exit 32 ;; esac\n" if fail_dmg_codesign else ""),
            encoding="utf-8",
        )
        spctl.write_text(
            "#!/bin/sh\n"
            "printf 'spctl %s\\n' \"$*\" >> \"$VALIDATION_TOOL_LOG\"\n"
            + (
                "case \"$*\" in *'--type open'*) exit 33 ;; esac\n"
                if fail_dmg_gatekeeper
                else ""
            ),
            encoding="utf-8",
        )
        xcrun.write_text(
            "#!/bin/sh\n"
            "printf 'xcrun %s\\n' \"$*\" >> \"$VALIDATION_TOOL_LOG\"\n"
            + (
                "case \"$*\" in *.dmg*) exit 29 ;; esac\n"
                if fail_dmg_stapler
                else ""
            ),
            encoding="utf-8",
        )
        ditto.write_text(
            "#!/bin/sh\n"
            "printf 'ditto %s\\n' \"$*\" >> \"$VALIDATION_TOOL_LOG\"\n"
            "[ \"$1\" = -x ] && [ \"$2\" = -k ] || exit 37\n"
            "python3 - \"$3\" \"$4\" <<'PY'\n"
            "import sys, zipfile\n"
            "with zipfile.ZipFile(sys.argv[1]) as archive:\n"
            "    archive.extractall(sys.argv[2])\n"
            "PY\n",
            encoding="utf-8",
        )
        codesign.chmod(0o755)
        spctl.chmod(0o755)
        xcrun.chmod(0o755)
        ditto.chmod(0o755)
        env = os.environ.copy()
        env["PATH"] = f"{bin_dir}:{env['PATH']}"
        env["VALIDATION_TOOL_LOG"] = str(log_path)
        return env, log_path

    def test_accepts_valid_directory_and_zip(self):
        directory_result = self.run_validator(self.payload_dir)
        self.assertEqual(directory_result.returncode, 0, directory_result.stdout)

        archive_result = self.run_validator(self.make_zip())
        self.assertEqual(archive_result.returncode, 0, archive_result.stdout)
        self.assertIn("Verifying ZIP CRCs", archive_result.stdout)

    def test_rejects_missing_ootb_marketplace_assets(self):
        (self.payload_dir / "managed-root" / "marketplaces-ootb.json").unlink()
        result = self.run_validator(self.payload_dir)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("missing the OOTB marketplace config", result.stdout)

        self.reset_payload()
        shutil.rmtree(self.payload_dir / "managed-root" / "skills-marketplace-ootb")
        result = self.run_validator(self.payload_dir)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("missing the OOTB marketplace skills", result.stdout)

    def test_explicit_override_accepts_only_missing_ootb_marketplace_assets(self):
        for missing_path in (
            self.payload_dir / "managed-root" / "marketplaces-ootb.json",
            self.payload_dir / "managed-root" / "skills-marketplace-ootb",
        ):
            with self.subTest(missing_path=missing_path.name):
                if missing_path.is_dir():
                    shutil.rmtree(missing_path)
                else:
                    missing_path.unlink()

                result = self.run_validator(
                    self.payload_dir,
                    "--allow-missing-ootb-marketplace-assets",
                )

                self.assertEqual(result.returncode, 0, result.stdout)
                self.assertIn(
                    "Explicitly allowing missing OOTB marketplace bootstrap assets",
                    result.stdout,
                )
                self.reset_payload()

    def test_missing_ootb_override_keeps_every_other_validation_fail_closed(self):
        (self.payload_dir / "managed-root" / "marketplaces-ootb.json").unlink()
        shutil.rmtree(
            self.payload_dir / "artifacts/apps/darwin-arm64/Portico.app"
        )

        result = self.run_validator(
            self.payload_dir,
            "--allow-missing-ootb-marketplace-assets",
        )

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("missing the darwin-arm64 app bundle", result.stdout)

        self.reset_payload()
        config_path = self.payload_dir / "managed-root" / "marketplaces-ootb.json"
        config_path.write_text("{not-json\n", encoding="utf-8")
        result = self.run_validator(
            self.payload_dir,
            "--allow-missing-ootb-marketplace-assets",
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("OOTB marketplace config is invalid JSON", result.stdout)

    def test_rejects_malformed_duplicate_or_unsafe_ootb_manifest(self):
        config_path = self.payload_dir / "managed-root" / "marketplaces-ootb.json"
        config_path.write_text("{not-json\n", encoding="utf-8")
        result = self.run_validator(self.payload_dir)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("OOTB marketplace config is invalid JSON", result.stdout)

        self.reset_payload()
        config_path, config = self.read_ootb_config()
        config["marketplaces"].append(dict(config["marketplaces"][0]))
        config_path.write_text(json.dumps(config), encoding="utf-8")
        result = self.run_validator(self.payload_dir)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("OOTB marketplace id is duplicated", result.stdout)

        self.reset_payload()
        config_path, config = self.read_ootb_config()
        config["installedSkills"][0]["localPath"] = "../escape"
        config_path.write_text(json.dumps(config), encoding="utf-8")
        result = self.run_validator(self.payload_dir)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("OOTB installed skill localPath must be", result.stdout)

        # Plugin rows must carry the plugin-segmented localPath, not the
        # legacy two-segment shape.
        self.reset_payload()
        config_path, config = self.read_ootb_config()
        plugin_row = next(
            entry for entry in config["installedSkills"] if entry.get("pluginName")
        )
        plugin_row["localPath"] = "skills-marketplace/example-marketplace/plugin-skill"
        config_path.write_text(json.dumps(config), encoding="utf-8")
        result = self.run_validator(self.payload_dir)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(
            "OOTB installed skill localPath must be "
            "skills-marketplace/example-marketplace/example-plugin/plugin-skill",
            result.stdout,
        )

        self.reset_payload()
        config_path, config = self.read_ootb_config()
        plugin_row = next(
            entry for entry in config["installedSkills"] if entry.get("pluginName")
        )
        plugin_row["pluginName"] = "../escape"
        config_path.write_text(json.dumps(config), encoding="utf-8")
        result = self.run_validator(self.payload_dir)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(
            "OOTB marketplace installed skill pluginName is invalid", result.stdout
        )

    def test_rejects_missing_or_unlisted_ootb_skills(self):
        skill_path = (
            self.payload_dir
            / "managed-root"
            / "skills-marketplace-ootb"
            / "example-marketplace"
            / "example-skill"
            / "SKILL.md"
        )
        skill_path.unlink()
        result = self.run_validator(self.payload_dir)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("OOTB installed skill is missing SKILL.md", result.stdout)

        self.reset_payload()
        orphan = (
            self.payload_dir
            / "managed-root"
            / "skills-marketplace-ootb"
            / "extra-marketplace"
            / "orphan-skill"
            / "SKILL.md"
        )
        orphan.parent.mkdir(parents=True)
        orphan.write_text("# Orphan\n", encoding="utf-8")
        result = self.run_validator(self.payload_dir)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("unlisted: extra-marketplace/orphan-skill", result.stdout)

        # A stray skill inside a listed plugin directory is still unlisted.
        self.reset_payload()
        stray = (
            self.payload_dir
            / "managed-root"
            / "skills-marketplace-ootb"
            / "example-marketplace"
            / "example-plugin"
            / "stray-skill"
            / "SKILL.md"
        )
        stray.parent.mkdir(parents=True)
        stray.write_text("# Stray\n", encoding="utf-8")
        result = self.run_validator(self.payload_dir)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(
            "unlisted: example-marketplace/example-plugin/stray-skill", result.stdout
        )

    def test_rejects_ootb_baseline_hash_drift(self):
        skill_path = (
            self.payload_dir
            / "managed-root"
            / "skills-marketplace-ootb"
            / "example-marketplace"
            / "example-skill"
            / "SKILL.md"
        )
        skill_path.write_text("# Changed after baseline generation\n", encoding="utf-8")
        result = self.run_validator(self.payload_dir)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("OOTB baseline hash mismatch", result.stdout)

    def test_accepts_attested_full_sha_runtime_images(self):
        self.add_runtime_image_attestation()

        directory_result = self.run_validator(self.payload_dir)
        self.assertEqual(directory_result.returncode, 0, directory_result.stdout)
        archive_result = self.run_validator(self.make_zip())
        self.assertEqual(archive_result.returncode, 0, archive_result.stdout)

    def test_accepts_attested_release_build_runtime_image_tag(self):
        self.add_runtime_image_attestation(BUILD_ID)

        result = self.run_validator(self.payload_dir)

        self.assertEqual(result.returncode, 0, result.stdout)

    def test_rejects_attestation_provenance_drift(self):
        self.add_runtime_image_attestation()
        attestation_path = self.payload_dir / "runtime-image-attestation.json"
        attestation = json.loads(attestation_path.read_text(encoding="utf-8"))
        attestation["images"][0]["platforms"]["linux/arm64"]["revision"] = "a" * 40
        attestation_path.write_text(json.dumps(attestation), encoding="utf-8")

        result = self.run_validator(self.payload_dir)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("revision mismatch", result.stdout)

    def test_accepts_merge_request_runtime_image_tag(self):
        mr_tag = f"mr-123-{FULL_SHA}"
        self.add_runtime_image_attestation(mr_tag)

        result = self.run_validator(self.payload_dir)
        self.assertEqual(result.returncode, 0, result.stdout)

    def test_rejects_attested_unrelated_runtime_image_tag(self):
        self.add_runtime_image_attestation("06182026-cafebabe")

        result = self.run_validator(self.payload_dir)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("attested manifest dockerImageTag", result.stdout)

    def test_rejects_corrupt_zip(self):
        archive_path = self.make_zip()
        data = archive_path.read_bytes()
        archive_path.write_bytes(data[:-30])
        result = self.run_validator(archive_path)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("not a readable ZIP archive", result.stdout)

    def test_rejects_manifest_identity_mismatch(self):
        manifest_path = self.payload_dir / "release-manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["dockerImageTag"] = "06182026-cafebabe"
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        result = self.run_validator(self.payload_dir)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("dockerImageTag", result.stdout)

    def test_rejects_packaged_app_build_identity_mismatch(self):
        build_info_path = (
            self.payload_dir
            / "artifacts/apps/darwin-arm64/Portico.app/Contents/Resources/build-info.json"
        )
        build_info = json.loads(build_info_path.read_text(encoding="utf-8"))
        build_info["fullSha"] = "cafebabecafebabecafebabecafebabecafebabe"
        build_info_path.write_text(json.dumps(build_info), encoding="utf-8")
        result = self.run_validator(self.payload_dir)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("app fullSha does not match", result.stdout)

    def test_rejects_unsafe_archive_path_and_symlink_escape(self):
        archive_path = self.make_zip()
        with zipfile.ZipFile(archive_path, "a") as archive:
            archive.writestr("../escape", "bad")
        result = self.run_validator(archive_path)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("unsafe traversal path", result.stdout)

        archive_path.unlink()
        archive_path = self.make_zip()
        symlink = zipfile.ZipInfo("managed-root/escape-link")
        symlink.create_system = 3
        symlink.external_attr = (stat.S_IFLNK | 0o777) << 16
        with zipfile.ZipFile(archive_path, "a") as archive:
            archive.writestr(symlink, "../../outside")
        result = self.run_validator(archive_path)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("symlink escapes the payload", result.stdout)

    def test_accepts_well_formed_appledouble_metadata(self):
        archive_path = self.make_zip()
        with zipfile.ZipFile(archive_path, "a") as archive:
            archive.writestr(
                "__MACOSX/artifacts/apps/darwin-arm64/Portico.app/Contents/"
                "Resources/._build-info.json",
                b"appledouble-metadata",
            )

        result = self.run_validator(archive_path)
        self.assertEqual(result.returncode, 0, result.stdout)

    def test_accepts_archive_created_by_macos_ditto(self):
        ditto = shutil.which("ditto")
        if ditto is None:
            self.skipTest("macOS ditto is unavailable")

        build_info = (
            self.payload_dir
            / "artifacts/apps/darwin-arm64/Portico.app/Contents/Resources/build-info.json"
        )
        subprocess.run(
            ["xattr", "-w", "com.portico.ai-chat.release-test", "preserved", str(build_info)],
            check=True,
        )
        archive_path = self.temp_dir / FILENAME
        subprocess.run(
            [ditto, "-c", "-k", "--sequesterRsrc", str(self.payload_dir), str(archive_path)],
            check=True,
        )

        result = self.run_validator(archive_path)
        self.assertEqual(result.returncode, 0, result.stdout)

    def test_rejects_orphaned_or_malformed_appledouble_metadata(self):
        archive_path = self.make_zip()
        with zipfile.ZipFile(archive_path, "a") as archive:
            archive.writestr("__MACOSX/managed-root/._missing", b"orphan")
        result = self.run_validator(archive_path)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("has no matching payload entry", result.stdout)

        archive_path.unlink()
        archive_path = self.make_zip()
        with zipfile.ZipFile(archive_path, "a") as archive:
            archive.writestr("__MACOSX/managed-root/not-a-sidecar", b"malformed")
        result = self.run_validator(archive_path)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("malformed AppleDouble metadata", result.stdout)

    def test_rejects_missing_artifact_and_unexpected_architecture(self):
        next((self.payload_dir / "artifacts" / "dmg" / "darwin-arm64").glob("*.dmg")).unlink()
        result = self.run_validator(self.payload_dir)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("missing the darwin-arm64 DMG", result.stdout)

        shutil.rmtree(self.payload_dir)
        self.make_payload_tree(self.payload_dir)
        extra = self.payload_dir / "artifacts" / "apps" / "darwin-ppc" / "Old.app" / "file"
        extra.parent.mkdir(parents=True)
        extra.write_text("old", encoding="utf-8")
        result = self.run_validator(self.payload_dir)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("unexpected macOS architecture", result.stdout)

    def test_rejects_filename_mismatch(self):
        result = self.run_validator(self.make_zip("wrong.zip"))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(f"payload filename must be {FILENAME}", result.stdout)

    def test_zip_signature_and_notarization_validation_uses_extracted_artifacts(self):
        archive_path = self.make_zip()
        env, log_path = self.install_fake_macos_tools()
        result = self.run_validator(archive_path, "--verify-macos", env=env)
        self.assertEqual(result.returncode, 0, result.stdout)
        calls = log_path.read_text(encoding="utf-8").splitlines()
        self.assertEqual(sum(line.startswith("ditto -x -k ") for line in calls), 1)
        self.assertEqual(sum(line.startswith("codesign ") for line in calls), 4)
        self.assertEqual(sum(line.startswith("spctl ") for line in calls), 4)
        self.assertEqual(sum(line.startswith("xcrun stapler validate ") for line in calls), 4)
        self.assertTrue(any("darwin-arm64" in line for line in calls))
        self.assertTrue(any("darwin-x64" in line for line in calls))

    def test_notarization_failure_is_fatal(self):
        env, _ = self.install_fake_macos_tools(fail_dmg_stapler=True)
        result = self.run_validator(self.make_zip(), "--verify-macos", env=env)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("DMG notarization-ticket validation failed", result.stdout)

    def test_copied_app_signature_failure_is_fatal(self):
        env, _ = self.install_fake_macos_tools(fail_codesign=True)
        result = self.run_validator(self.make_zip(), "--verify-macos", env=env)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("app signature validation failed", result.stdout)

    def test_unsigned_dmg_is_fatal(self):
        env, _ = self.install_fake_macos_tools(fail_dmg_codesign=True)
        result = self.run_validator(self.make_zip(), "--verify-macos", env=env)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("DMG signature validation failed", result.stdout)

    def test_dmg_gatekeeper_failure_is_fatal(self):
        env, _ = self.install_fake_macos_tools(fail_dmg_gatekeeper=True)
        result = self.run_validator(self.make_zip(), "--verify-macos", env=env)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("DMG Gatekeeper validation failed", result.stdout)


if __name__ == "__main__":
    unittest.main()
