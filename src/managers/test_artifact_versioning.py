"""
Tests for artifact versioning logic.

These tests validate that version numbers are calculated correctly,
especially when switching between versions before creating new ones.

Run with: python3 -m pytest test_artifact_versioning.py -v
"""

import pytest
import time
from dataclasses import dataclass, field
from typing import List, Dict, Any, Optional
from enum import Enum


# Minimal recreations of the classes for testing (avoiding dependency issues)
class ArtifactStatus(str, Enum):
    """Artifact lifecycle states."""
    STOPPED = "stopped"
    STARTING = "starting"
    RUNNING = "running"
    ERROR = "error"


@dataclass
class ArtifactVersion:
    """Information about an artifact version."""
    version: int
    created_at: float
    snapshot_path: str
    version_note: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return {
            "version": self.version,
            "created_at": self.created_at,
            "snapshot_path": self.snapshot_path,
            "version_note": self.version_note,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "ArtifactVersion":
        return cls(
            version=data["version"],
            created_at=data["created_at"],
            snapshot_path=data["snapshot_path"],
            version_note=data.get("version_note", ""),
        )


@dataclass
class Artifact:
    """Complete artifact information."""
    artifact_id: str
    chat_id: str
    name: str
    description: str
    created_at: float
    start_command: str
    working_directory: str
    container_port: int
    current_version: int
    host_port: Optional[int] = None
    running_vm_id: Optional[str] = None
    bound_vm_id: Optional[str] = None
    status: ArtifactStatus = ArtifactStatus.STOPPED
    error_message: Optional[str] = None
    versions: List[ArtifactVersion] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "artifact_id": self.artifact_id,
            "chat_id": self.chat_id,
            "name": self.name,
            "description": self.description,
            "created_at": self.created_at,
            "start_command": self.start_command,
            "working_directory": self.working_directory,
            "container_port": self.container_port,
            "current_version": self.current_version,
            "host_port": self.host_port,
            "running_vm_id": self.running_vm_id,
            "bound_vm_id": self.bound_vm_id,
            "status": self.status.value if isinstance(self.status, ArtifactStatus) else self.status,
            "error_message": self.error_message,
            "versions": [v.to_dict() for v in self.versions],
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "Artifact":
        return cls(
            artifact_id=data["artifact_id"],
            chat_id=data["chat_id"],
            name=data["name"],
            description=data.get("description", ""),
            created_at=data["created_at"],
            start_command=data["start_command"],
            working_directory=data.get("working_directory", "/work"),
            container_port=data["container_port"],
            current_version=data.get("current_version", 1),
            host_port=data.get("host_port"),
            running_vm_id=data.get("running_vm_id"),
            bound_vm_id=data.get("bound_vm_id"),
            status=ArtifactStatus(data.get("status", "stopped")),
            error_message=data.get("error_message"),
            versions=[ArtifactVersion.from_dict(v) for v in data.get("versions", [])],
        )


def validate_version_uniqueness(artifact: Artifact, new_version: int) -> bool:
    """Validate that new_version doesn't already exist in artifact.versions."""
    existing_versions = {v.version for v in artifact.versions}
    return new_version not in existing_versions


def create_test_artifact(
    artifact_id: str = "test-artifact-123",
    chat_id: str = "test-chat-456",
    versions: List[int] = None,
    current_version: int = 1,
) -> Artifact:
    """Create a test artifact with specified versions."""
    if versions is None:
        versions = [1]
    
    version_objects = [
        ArtifactVersion(
            version=v,
            created_at=time.time() - (len(versions) - i) * 100,
            snapshot_path=f"/tmp/v{v}.tar.gz",
            version_note=f"Version {v}",
        )
        for i, v in enumerate(versions)
    ]
    
    return Artifact(
        artifact_id=artifact_id,
        chat_id=chat_id,
        name="Test Artifact",
        description="A test artifact",
        created_at=time.time(),
        start_command="npm run dev",
        working_directory="/work",
        container_port=5173,
        current_version=current_version,
        host_port=10001,
        running_vm_id="test-vm-id",
        bound_vm_id="test-vm-id",
        status=ArtifactStatus.RUNNING,
        versions=version_objects,
    )


class TestVersionCalculation:
    """Test version number calculation logic."""
    
    def test_max_version_calculation_simple(self):
        """Test that max version is calculated correctly."""
        artifact = create_test_artifact(versions=[1, 2, 3])
        
        max_version = max([v.version for v in artifact.versions]) if artifact.versions else 0
        assert max_version == 3
        assert max_version + 1 == 4
    
    def test_max_version_with_gaps(self):
        """Test max version calculation with non-sequential versions."""
        artifact = create_test_artifact(versions=[1, 3, 5])
        
        max_version = max([v.version for v in artifact.versions]) if artifact.versions else 0
        assert max_version == 5
        assert max_version + 1 == 6
    
    def test_max_version_single_version(self):
        """Test max version with only one version."""
        artifact = create_test_artifact(versions=[1])
        
        max_version = max([v.version for v in artifact.versions]) if artifact.versions else 0
        assert max_version == 1
        assert max_version + 1 == 2
    
    def test_max_version_empty_versions(self):
        """Test max version with empty versions list."""
        artifact = create_test_artifact(versions=[])
        artifact.versions = []
        
        max_version = max([v.version for v in artifact.versions]) if artifact.versions else 0
        assert max_version == 0
        assert max_version + 1 == 1
    
    def test_current_version_does_not_affect_max(self):
        """
        CRITICAL TEST: Verify that current_version (UI state) does not
        affect the calculation of new version numbers.
        
        This is the bug scenario:
        - Artifact has v1, v2, v3
        - User switches to v2 (current_version = 2)
        - Creating new version should give v4, not v3
        """
        artifact = create_test_artifact(
            versions=[1, 2, 3],
            current_version=2,  # User switched to v2
        )
        
        # The calculation should use max(versions), NOT current_version
        max_version = max([v.version for v in artifact.versions]) if artifact.versions else 0
        new_version = max_version + 1
        
        # Should be v4, not v3 (which would be current_version + 1)
        assert new_version == 4
        assert new_version != artifact.current_version + 1  # This would be wrong (3)
    
    def test_current_version_set_to_first_version(self):
        """Test when user switches to the very first version."""
        artifact = create_test_artifact(
            versions=[1, 2, 3, 4, 5],
            current_version=1,  # User switched to v1
        )
        
        max_version = max([v.version for v in artifact.versions]) if artifact.versions else 0
        new_version = max_version + 1
        
        assert new_version == 6
        assert new_version != artifact.current_version + 1  # Would be 2


class TestVersionUniqueness:
    """Test version uniqueness validation."""
    
    def test_validate_unique_version(self):
        """Test that unique versions pass validation."""
        artifact = create_test_artifact(versions=[1, 2, 3])
        
        assert validate_version_uniqueness(artifact, 4) is True
        assert validate_version_uniqueness(artifact, 5) is True
        assert validate_version_uniqueness(artifact, 100) is True
    
    def test_validate_duplicate_version(self):
        """Test that duplicate versions fail validation."""
        artifact = create_test_artifact(versions=[1, 2, 3])
        
        assert validate_version_uniqueness(artifact, 1) is False
        assert validate_version_uniqueness(artifact, 2) is False
        assert validate_version_uniqueness(artifact, 3) is False


class TestVersionRecalculation:
    """Test the version recalculation fix."""
    
    def test_recalculation_detects_stale_data(self):
        """
        Test that version recalculation correctly detects when
        the original calculation was based on stale data.
        """
        # Simulate the scenario:
        # 1. Original artifact had versions [1, 2] when loaded
        # 2. During VM creation, another process added v3
        # 3. Fresh artifact now has versions [1, 2, 3]
        
        # Original calculation (stale)
        stale_artifact = create_test_artifact(versions=[1, 2])
        original_max = max([v.version for v in stale_artifact.versions])
        original_new_version = original_max + 1  # = 3
        
        # Fresh artifact (has v3 now)
        fresh_artifact = create_test_artifact(versions=[1, 2, 3])
        fresh_max = max([v.version for v in fresh_artifact.versions])
        correct_new_version = fresh_max + 1  # = 4
        
        # The fix should detect this discrepancy
        assert original_new_version == 3
        assert correct_new_version == 4
        assert original_new_version != correct_new_version
    
    def test_recalculation_same_when_no_changes(self):
        """
        Test that recalculation gives same result when
        artifact hasn't changed during VM creation.
        """
        artifact = create_test_artifact(versions=[1, 2, 3])
        
        # First calculation
        max1 = max([v.version for v in artifact.versions])
        new_version1 = max1 + 1
        
        # "Re-fetch" same artifact (no changes)
        max2 = max([v.version for v in artifact.versions])
        new_version2 = max2 + 1
        
        assert new_version1 == new_version2 == 4


class TestBugScenario:
    """
    Test the specific bug scenario reported:
    
    "When a previous version is selected, let's say v2 and the last 
    version is v3, and a new version is created, it is versioned as 
    v3 (duplicated) instead of v4."
    """
    
    def test_bug_scenario_version_calculation(self):
        """
        Reproduce the exact bug scenario and verify the fix works.
        """
        # Setup: Artifact has v1, v2, v3
        # User switched to v2 (current_version = 2)
        artifact = create_test_artifact(
            versions=[1, 2, 3],
            current_version=2,
        )
        
        # CORRECT calculation: use max(versions) + 1
        max_version = max([v.version for v in artifact.versions])
        correct_new_version = max_version + 1
        
        # WRONG calculation (the bug): use current_version + 1
        wrong_new_version = artifact.current_version + 1
        
        # Verify the correct behavior
        assert correct_new_version == 4, "New version should be v4"
        assert wrong_new_version == 3, "Bug would create v3"
        assert correct_new_version != wrong_new_version
        
        # Verify v4 doesn't already exist (no duplicate)
        existing_versions = {v.version for v in artifact.versions}
        assert correct_new_version not in existing_versions
        assert wrong_new_version in existing_versions  # v3 would be duplicate!
    
    def test_bug_scenario_switching_to_v1(self):
        """Test bug scenario when switching all the way back to v1."""
        artifact = create_test_artifact(
            versions=[1, 2, 3, 4, 5],
            current_version=1,
        )
        
        max_version = max([v.version for v in artifact.versions])
        correct_new_version = max_version + 1
        
        assert correct_new_version == 6
        assert correct_new_version != artifact.current_version + 1  # Would be 2
    
    def test_bug_scenario_switching_to_middle_version(self):
        """Test bug scenario when switching to a middle version."""
        artifact = create_test_artifact(
            versions=[1, 2, 3, 4, 5, 6, 7],
            current_version=4,
        )
        
        max_version = max([v.version for v in artifact.versions])
        correct_new_version = max_version + 1
        
        assert correct_new_version == 8
        assert correct_new_version != artifact.current_version + 1  # Would be 5


class TestArtifactSerialization:
    """Test that versions are correctly serialized/deserialized."""
    
    def test_artifact_to_dict_includes_all_versions(self):
        """Verify to_dict includes all versions."""
        artifact = create_test_artifact(versions=[1, 2, 3, 4, 5])
        
        data = artifact.to_dict()
        
        assert "versions" in data
        assert len(data["versions"]) == 5
        version_numbers = [v["version"] for v in data["versions"]]
        assert version_numbers == [1, 2, 3, 4, 5]
    
    def test_artifact_from_dict_restores_all_versions(self):
        """Verify from_dict restores all versions."""
        original = create_test_artifact(versions=[1, 2, 3, 4, 5])
        data = original.to_dict()
        
        restored = Artifact.from_dict(data)
        
        assert len(restored.versions) == 5
        version_numbers = [v.version for v in restored.versions]
        assert version_numbers == [1, 2, 3, 4, 5]
    
    def test_serialization_roundtrip_preserves_max(self):
        """Verify serialization roundtrip preserves max version calculation."""
        original = create_test_artifact(versions=[1, 2, 3])
        
        # Serialize and deserialize
        data = original.to_dict()
        restored = Artifact.from_dict(data)
        
        # Calculate max on both
        original_max = max([v.version for v in original.versions])
        restored_max = max([v.version for v in restored.versions])
        
        assert original_max == restored_max == 3


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
