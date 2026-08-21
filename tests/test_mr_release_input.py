import importlib.util
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace


PROJECT_ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = PROJECT_ROOT / "src/scripts/ci/mr-release-input.py"
SPEC = importlib.util.spec_from_file_location("mr_release_input", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


class MrReleaseInputTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        for arch in ("arm64", "x64"):
            archive = self.root / f"apps/darwin-{arch}/Portico.app.zip"
            archive.parent.mkdir(parents=True)
            archive.write_bytes(f"{arch}-app".encode())
        managed = self.root / "managed-root/cloudsmith.env"
        managed.parent.mkdir(parents=True)
        managed.write_text("CLOUDSMITH_API_KEY=\"mr-preview-disabled\"\n", encoding="utf-8")
        for target in (
            "aarch64-apple-darwin",
            "aarch64-unknown-linux-gnu",
            "x86_64-apple-darwin",
            "x86_64-unknown-linux-gnu",
        ):
            binary = self.root / "host-mcp-binaries" / target / "mcp-orc"
            binary.parent.mkdir(parents=True)
            binary.write_text(target, encoding="utf-8")

    def tearDown(self):
        self.temporary.cleanup()

    def arguments(self):
        return SimpleNamespace(
            project_id=77,
            project_path="portico/portico",
            mr_iid=42,
            target_branch="feature/target",
            source_revision="a" * 40,
            build_number="06242026-aaaaaaaa",
            release_timestamp="2026-06-24T12:34:56.000Z",
        )

    def test_contract_derives_exact_channel_and_image_tag(self):
        contract = MODULE.expected_contract(self.arguments(), self.root)
        self.assertEqual(contract["channel"], "mr-42")
        self.assertEqual(contract["channelPackageName"], "portico_mr-42")
        self.assertEqual(contract["runtimeImageTag"], f"mr-42-{'a' * 40}")
        self.assertEqual(set(contract["apps"]), {"darwin-arm64", "darwin-x64"})

    def test_tree_hash_rejects_escaping_symlink(self):
        outside = self.root.parent / "outside-secret"
        outside.write_text("secret", encoding="utf-8")
        link = self.root / "managed-root/escape"
        link.symlink_to(outside)
        with self.assertRaisesRegex(MODULE.ContractError, "unsafe target|escapes staging root"):
            MODULE.sha256_tree(self.root / "managed-root")
        outside.unlink()

    def test_build_number_must_match_source_revision(self):
        arguments = self.arguments()
        arguments.build_number = "06242026-bbbbbbbb"
        with self.assertRaisesRegex(MODULE.ContractError, "does not match"):
            MODULE.validate_arguments(arguments)


if __name__ == "__main__":
    unittest.main()
