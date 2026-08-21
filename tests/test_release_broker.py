import datetime as dt
import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


PROJECT_ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = PROJECT_ROOT / "ci/release-broker-project/scripts/cleanup-mr-releases.py"
SPEC = importlib.util.spec_from_file_location("cleanup_mr_releases", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class ReleaseBrokerCleanupTests(unittest.TestCase):
    def package(self, iid, version, age_days):
        uploaded = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=age_days)
        name = f"portico_mr-{iid}"
        return MODULE.Package(
            name=name,
            version=version,
            slug=f"slug-{iid}-{version}",
            filename=f"{name}-{version}.zip",
            uploaded_at=uploaded,
            iid=iid,
        )

    def test_open_mr_keeps_latest_and_deletes_only_old_superseded_builds(self):
        newest = self.package(42, "06242026-aaaaaaaa", 1)
        recent = self.package(42, "06232026-bbbbbbbb", 3)
        old = self.package(42, "06102026-cccccccc", 14)
        cutoff = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=7)
        candidates = MODULE.select_deletion_candidates(
            [old, newest, recent], cutoff, mr_lookup=lambda _iid: {"state": "opened"}
        )
        self.assertEqual(candidates, [old])

    def test_closed_mr_is_retained_for_seven_days_then_fully_deleted(self):
        packages = [self.package(7, "06242026-aaaaaaaa", 20)]
        cutoff = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=7)
        old_close = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=8)).isoformat()
        recent_close = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=2)).isoformat()
        self.assertEqual(
            MODULE.select_deletion_candidates(
                packages, cutoff, mr_lookup=lambda _iid: {"state": "closed", "closed_at": old_close}
            ),
            packages,
        )
        self.assertEqual(
            MODULE.select_deletion_candidates(
                packages, cutoff, mr_lookup=lambda _iid: {"state": "closed", "closed_at": recent_close}
            ),
            [],
        )

    def test_harbor_tag_resolution_fails_closed_on_ambiguity(self):
        package = self.package(9, "06242026-deadbeef", 10)
        completed = mock.Mock(returncode=0, stdout="\n".join([
            f"mr-9-deadbeef{'a' * 32}",
            f"mr-9-deadbeef{'b' * 32}",
        ]))
        with mock.patch.object(MODULE.subprocess, "run", return_value=completed):
            with self.assertRaisesRegex(MODULE.CleanupError, "expected one Harbor tag"):
                MODULE.resolve_image_tag("harbor.example/portico", package)


if __name__ == "__main__":
    unittest.main()
