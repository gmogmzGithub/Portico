"""Fixture tests for sync_ootb_marketplaces.sh seed-lifecycle bookkeeping.

Each test builds a throwaway repo root (live registry + payload dirs +
previous committed bundle), runs the real script against it, and asserts on
the emitted bundle registry, exit codes, and the printed migration plan.
"""

import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = PROJECT_ROOT / "sync_ootb_marketplaces.sh"

SKILL_MD = "---\nmetadata:\n  version: 1.2.3\n---\n# Skill\n"


def sha256_text(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


class SyncOotbMarketplacesTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="sync-ootb-test."))
        (self.root / "marketplaces-ootb").mkdir()
        # Preflight only checks existence of the release packager.
        (self.root / "package_for_release.sh").write_text("#!/bin/sh\n")

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    # ── fixture builders ────────────────────────────────────────────────

    def live_record(self, marketplace_id, skill_id, plugin=None, skill_path=None):
        key_parts = [marketplace_id] + ([plugin] if plugin else []) + [skill_id]
        record = {
            "skillId": skill_id,
            "marketplaceId": marketplace_id,
            "pluginName": plugin,
            "skillPath": skill_path
            or f"./community/{plugin or skill_id}/skills/{skill_id}",
            "skillSource": None,
            "installedAt": "2026-07-24T00:00:00.000Z",
            "installedVersion": "1.2.3",
            "localPath": "skills-marketplace/" + "/".join(key_parts),
        }
        return record

    def write_payload(self, record, files=None):
        skill_dir = self.root / record["localPath"]
        skill_dir.mkdir(parents=True, exist_ok=True)
        (skill_dir / "SKILL.md").write_text(SKILL_MD)
        for name, content in (files or {}).items():
            target = skill_dir / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content)

    def write_live(self, records, marketplace_ids=("mp1",)):
        payload = {
            "version": "1.0",
            "marketplaces": [
                {"id": mp_id, "name": mp_id, "ootb": True} for mp_id in marketplace_ids
            ],
            "installedSkills": records,
        }
        (self.root / "marketplaces.json").write_text(
            json.dumps(payload, indent=2) + "\n"
        )

    def write_prev_bundle(self, records, migrations=None, marketplace_ids=("mp1",)):
        payload = {
            "version": "1.0",
            "marketplaces": [
                {"id": mp_id, "name": mp_id, "ootb": True} for mp_id in marketplace_ids
            ],
            "installedSkills": records,
        }
        if migrations is not None:
            payload["seedMigrations"] = migrations
        (self.root / "marketplaces-ootb" / "marketplaces.json").write_text(
            json.dumps(payload, indent=2) + "\n"
        )

    def prev_seed(self, marketplace_id, skill_id, plugin=None, skill_path=None, shas=None):
        record = self.live_record(marketplace_id, skill_id, plugin, skill_path)
        record["baseline"] = {
            "files": [
                {"path": f"file-{index}", "sha256": sha}
                for index, sha in enumerate(shas or [sha256_text(SKILL_MD)])
            ],
            "generatedAt": "2026-07-21T00:00:00.000Z",
            "sourceRef": "main",
            "version": "1.2.3",
        }
        return record

    def run_script(self, *args, stdin=None):
        return subprocess.run(
            ["bash", str(SCRIPT), *args],
            cwd=self.root,
            input=stdin,
            capture_output=True,
            text=True,
        )

    def emitted_bundle(self):
        return json.loads(
            (self.root / "marketplaces-ootb" / "marketplaces.json").read_text()
        )

    # ── same-key identity drift ─────────────────────────────────────────

    def test_plugin_rename_emits_automatic_migration(self):
        self.write_prev_bundle([self.prev_seed("mp1", "a11y", plugin="ux-beta")])
        record = self.live_record("mp1", "a11y", plugin="ux")
        self.write_payload(record)
        self.write_live([record])

        result = self.run_script("--yes")
        self.assertEqual(result.returncode, 0, result.stderr)

        bundle = self.emitted_bundle()
        self.assertEqual(
            bundle["seedMigrations"],
            [
                {
                    "from": {"marketplaceId": "mp1", "skillId": "a11y", "pluginName": "ux-beta"},
                    "to": {"marketplaceId": "mp1", "skillId": "a11y", "pluginName": "ux"},
                }
            ],
        )
        self.assertIn("[new] mp1/ux-beta/a11y  →  mp1/ux/a11y", result.stdout)

    def test_skillpath_only_drift_emits_discriminated_migration(self):
        self.write_prev_bundle(
            [self.prev_seed("mp1", "a11y", plugin="ux", skill_path="./community/ux/skills/a11y")]
        )
        record = self.live_record(
            "mp1", "a11y", plugin="ux", skill_path="./plugins/ux/skills/a11y"
        )
        self.write_payload(record)
        self.write_live([record])

        result = self.run_script("--yes")
        self.assertEqual(result.returncode, 0, result.stderr)

        migration = self.emitted_bundle()["seedMigrations"][0]
        self.assertEqual(migration["from"]["skillPath"], "community/ux/skills/a11y")
        self.assertEqual(migration["from"]["pluginName"], "ux")
        self.assertEqual(migration["to"]["pluginName"], "ux")

    # ── vanished keys need disposition ──────────────────────────────────

    def test_vanished_key_hard_fails_in_yes_mode(self):
        self.write_prev_bundle([self.prev_seed("mp1", "gone-skill", plugin="ux")])
        record = self.live_record("mp1", "other-skill", plugin="ux")
        self.write_payload(record)
        self.write_live([record])

        result = self.run_script("--yes")
        self.assertEqual(result.returncode, 2)
        self.assertIn("vanished seeds need an explicit disposition", result.stderr)
        self.assertIn("--rename mp1/ux/gone-skill=", result.stderr)
        self.assertIn("--acknowledge-removal mp1/gone-skill", result.stderr)

    def test_declared_rename_and_removal(self):
        self.write_prev_bundle(
            [
                self.prev_seed("mp1", "old-name", plugin="ux"),
                self.prev_seed("mp1", "dead-skill", plugin="ux"),
            ]
        )
        record = self.live_record("mp1", "new-name", plugin="ux")
        self.write_payload(record)
        self.write_live([record])

        result = self.run_script(
            "--yes",
            "--rename",
            "mp1/ux/old-name=mp1/ux/new-name",
            "--acknowledge-removal",
            "mp1/dead-skill",
        )
        self.assertEqual(result.returncode, 0, result.stderr)

        bundle = self.emitted_bundle()
        self.assertEqual(
            bundle["seedMigrations"],
            [
                {
                    "from": {"marketplaceId": "mp1", "skillId": "old-name", "pluginName": "ux"},
                    "to": {"marketplaceId": "mp1", "skillId": "new-name", "pluginName": "ux"},
                }
            ],
        )
        self.assertIn("Removals acknowledged (1)", result.stdout)
        self.assertIn("mp1/ux/dead-skill", result.stdout)

        # A second run against the fresh bundle has no vanished keys: no
        # flags needed, alias carried forward untouched.
        rerun = self.run_script("--yes")
        self.assertEqual(rerun.returncode, 0, rerun.stderr)
        self.assertEqual(self.emitted_bundle()["seedMigrations"], bundle["seedMigrations"])
        self.assertIn("[carried] mp1/ux/old-name  →  mp1/ux/new-name", rerun.stdout)

    def test_rename_target_must_be_an_emitted_seed(self):
        self.write_prev_bundle([self.prev_seed("mp1", "old-name", plugin="ux")])
        record = self.live_record("mp1", "new-name", plugin="ux")
        self.write_payload(record)
        self.write_live([record])

        result = self.run_script("--yes", "--rename", "mp1/ux/old-name=mp1/ux/nonexistent")
        self.assertEqual(result.returncode, 2)
        self.assertIn("not an emitted seed", result.stderr)

    # ── alias roll-forward ──────────────────────────────────────────────

    def test_alias_roll_forward_repoints_chains_flat(self):
        self.write_prev_bundle(
            [self.prev_seed("mp1", "s1", plugin="pb")],
            migrations=[
                {
                    "from": {"marketplaceId": "mp1", "skillId": "s1", "pluginName": "pa"},
                    "to": {"marketplaceId": "mp1", "skillId": "s1", "pluginName": "pb"},
                }
            ],
        )
        record = self.live_record("mp1", "s1", plugin="pc")
        self.write_payload(record)
        self.write_live([record])

        result = self.run_script("--yes")
        self.assertEqual(result.returncode, 0, result.stderr)

        migrations = self.emitted_bundle()["seedMigrations"]
        as_pairs = {
            (entry["from"].get("pluginName"), entry["to"].get("pluginName"))
            for entry in migrations
        }
        self.assertEqual(as_pairs, {("pa", "pc"), ("pb", "pc")})
        self.assertIn("Aliases repointed through new renames (1)", result.stdout)

    def test_reappeared_identity_retires_alias(self):
        self.write_prev_bundle(
            [self.prev_seed("mp1", "s1", plugin="pb")],
            migrations=[
                {
                    "from": {"marketplaceId": "mp1", "skillId": "s0", "pluginName": "pa"},
                    "to": {"marketplaceId": "mp1", "skillId": "s1", "pluginName": "pb"},
                }
            ],
        )
        revived = self.live_record("mp1", "s0", plugin="pa")
        surviving = self.live_record("mp1", "s1", plugin="pb")
        self.write_payload(revived)
        self.write_payload(surviving)
        self.write_live([revived, surviving])

        result = self.run_script("--yes")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Aliases RETIRED (1)", result.stdout)
        self.assertNotIn("seedMigrations", self.emitted_bundle())

    def test_dead_target_alias_pruned(self):
        self.write_prev_bundle(
            [self.prev_seed("mp1", "s1", plugin="pb")],
            migrations=[
                {
                    "from": {"marketplaceId": "mp1", "skillId": "s0", "pluginName": "pa"},
                    "to": {"marketplaceId": "mp1", "skillId": "s1", "pluginName": "pb"},
                }
            ],
        )
        record = self.live_record("mp1", "other", plugin="ux")
        self.write_payload(record)
        self.write_live([record])

        result = self.run_script("--yes", "--acknowledge-removal", "mp1/s1")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Aliases pruned (1)", result.stdout)
        self.assertNotIn("seedMigrations", self.emitted_bundle())

    # ── interactive pairing ─────────────────────────────────────────────

    def test_interactive_rename_proposal_accepted_on_baseline_evidence(self):
        content = {"notes.txt": "shared-content"}
        record = self.live_record("mp1", "renamed-leaf", plugin="ux")
        self.write_payload(record, files=content)
        skill_sha = sha256_text(SKILL_MD)
        notes_sha = sha256_text("shared-content")
        self.write_prev_bundle(
            [self.prev_seed("mp1", "old-leaf", plugin="ux", shas=[skill_sha, notes_sha])]
        )
        self.write_live([record])

        result = self.run_script(stdin="y\nsync\n")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("baseline overlap 100%", result.stdout)

        migration = self.emitted_bundle()["seedMigrations"][0]
        self.assertEqual(migration["from"]["skillId"], "old-leaf")
        self.assertEqual(migration["to"]["skillId"], "renamed-leaf")

    # ── preflight ───────────────────────────────────────────────────────

    def test_duplicate_seed_pair_across_plugins_fails_preflight(self):
        first = self.live_record("mp1", "shared-leaf", plugin="plugin-a")
        second = self.live_record("mp1", "shared-leaf", plugin="plugin-b")
        self.write_payload(first)
        self.write_payload(second)
        self.write_live([first, second])
        self.write_prev_bundle([])

        result = self.run_script("--yes")
        self.assertEqual(result.returncode, 2)
        self.assertIn("duplicate (marketplaceId, skillId) across plugins", result.stderr)


if __name__ == "__main__":
    unittest.main()
