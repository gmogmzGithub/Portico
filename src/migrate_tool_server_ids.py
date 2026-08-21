#!/usr/bin/env python3
"""
One-time migration script for transitioning from numeric to stable tool server IDs.

This script runs during the transition from old builds (server:0, server:1) to new builds
(server:glean, server:gitlab-mcp). It uses Levenshtein distance to match old numeric IDs
to new stable IDs based on server names.

After all user-created agents/models are migrated, this becomes a no-op.
"""

import logging
import difflib
import time
import os
from datetime import datetime
from typing import Dict, List, Any, Tuple

from src.managers.filter_manager import OpenWebUIApiError, coerce_open_webui_api_client

logger = logging.getLogger(__name__)


def generate_migration_report(migration_data: Dict[str, Any]) -> str:
    """Generate a human-readable migration report.

    Args:
        migration_data: Dict containing:
            - numeric_to_stable: Mapping of old numeric IDs to new stable IDs
            - unmappable_ids: List of numeric IDs that couldn't be matched
            - models_migrated: List of {model_id, model_name, old_ids, new_ids}
            - models_skipped: List of {model_id, model_name, reason}

    Returns:
        Path to the generated report file
    """
    timestamp = int(time.time())
    report_filename = f"migration_report_{timestamp}.txt"
    report_path = os.path.join("/app/backup", report_filename)

    numeric_to_stable = migration_data.get('numeric_to_stable', {})
    unmappable_ids = migration_data.get('unmappable_ids', {})
    models_migrated = migration_data.get('models_migrated', [])
    models_skipped = migration_data.get('models_skipped', [])

    with open(report_path, 'w') as f:
        f.write("=" * 80 + "\n")
        f.write("TOOL SERVER ID MIGRATION REPORT\n")
        f.write("=" * 80 + "\n")
        f.write(f"Generated: {datetime.utcfromtimestamp(timestamp).isoformat()}Z\n")
        f.write(f"Timestamp: {timestamp}\n")
        f.write("\n")

        # Section 1: ID Mapping
        f.write("=" * 80 + "\n")
        f.write("NUMERIC ID → STABLE ID MAPPING\n")
        f.write("=" * 80 + "\n")
        f.write(f"Total mappings created: {len(numeric_to_stable)}\n")
        f.write("\n")

        if numeric_to_stable:
            for old_id, new_id in sorted(numeric_to_stable.items()):
                f.write(f"  • {old_id} → {new_id}\n")
        else:
            f.write("  (No numeric IDs found - all tool servers already using stable IDs)\n")
        f.write("\n")

        # Section 2: Unmappable IDs
        if unmappable_ids:
            f.write("=" * 80 + "\n")
            f.write("UNMAPPABLE NUMERIC IDS (Skipped)\n")
            f.write("=" * 80 + "\n")
            f.write(f"Total unmappable IDs: {len(unmappable_ids)}\n")
            f.write("\n")
            f.write("These numeric IDs could not be matched to any discovered MCP server.\n")
            f.write("Models using these IDs will have them REMOVED from their tool lists.\n")
            f.write("\n")

            for old_id, info in unmappable_ids.items():
                f.write(f"  • {old_id}\n")
                f.write(f"      Name: {info['name']}\n")
                f.write(f"      Best match score: {info['best_score']:.2f} (threshold: 0.60)\n")
                f.write(f"      Action: SKIPPED (ID removed from models)\n")
                f.write("\n")

        # Section 3: Models Migrated
        f.write("=" * 80 + "\n")
        f.write("MODELS MIGRATED\n")
        f.write("=" * 80 + "\n")
        f.write(f"Total models migrated: {len(models_migrated)}\n")
        f.write("\n")

        if models_migrated:
            for model_info in models_migrated:
                f.write(f"Model: {model_info['model_name']} (ID: {model_info['model_id']})\n")
                f.write(f"  OLD tool IDs: {model_info['old_ids']}\n")
                f.write(f"  NEW tool IDs: {model_info['new_ids']}\n")
                f.write(f"  Status: {model_info['status']}\n")
                f.write("\n")
        else:
            f.write("  (No models needed migration)\n")
        f.write("\n")

        # Section 4: Models with Unmappable IDs
        models_with_unmappable = migration_data.get('models_with_unmappable', [])
        if models_with_unmappable:
            f.write("=" * 80 + "\n")
            f.write("MODELS WITH UNMAPPABLE IDS\n")
            f.write("=" * 80 + "\n")
            f.write(f"Total models affected: {len(models_with_unmappable)}\n")
            f.write("\n")
            f.write("These models had numeric IDs that couldn't be matched. The unmappable\n")
            f.write("IDs were REMOVED from these models' tool lists.\n")
            f.write("\n")

            for model_info in models_with_unmappable:
                f.write(f"Model: {model_info['model_name']} (ID: {model_info['model_id']})\n")
                f.write(f"  Skipped IDs: {model_info['skipped_ids']}\n")
                f.write("\n")

        # Section 5: Models Skipped
        if models_skipped:
            f.write("=" * 80 + "\n")
            f.write("MODELS SKIPPED\n")
            f.write("=" * 80 + "\n")
            f.write(f"Total models skipped: {len(models_skipped)}\n")
            f.write("\n")

            for model_info in models_skipped:
                f.write(f"Model: {model_info['model_name']} (ID: {model_info['model_id']})\n")
                f.write(f"  Reason: {model_info['reason']}\n")
                f.write("\n")

        # Section 6: Summary
        f.write("=" * 80 + "\n")
        f.write("MIGRATION SUMMARY\n")
        f.write("=" * 80 + "\n")
        f.write(f"  ✅ Numeric IDs successfully mapped: {len(numeric_to_stable)}\n")
        f.write(f"  ⚠️  Numeric IDs unmappable (skipped): {len(unmappable_ids)}\n")
        f.write(f"  ✅ Models successfully migrated: {len([m for m in models_migrated if m['status'] == 'SUCCESS'])}\n")
        f.write(f"  ❌ Models failed migration: {len([m for m in models_migrated if m.get('status', '').startswith('FAILED')])}\n")
        f.write(f"  ⚠️  Models with unmappable IDs: {len(migration_data.get('models_with_unmappable', []))}\n")
        f.write(f"  ⏭️  Models skipped (other reasons): {len(models_skipped)}\n")
        f.write("\n")
        f.write("NOTES:\n")
        f.write("  • This migration only runs once\n")
        f.write("  • Unmappable IDs (similarity < 0.60) were removed from models\n")
        f.write("  • Tool server IDs are now stable and based on folder names\n")
        f.write("  • Future health check runs will be no-ops for migration\n")
        f.write("\n")
        f.write("=" * 80 + "\n")
        f.write("END OF REPORT\n")
        f.write("=" * 80 + "\n")

    logger.info(f"📄 Migration report generated: {report_path}")
    return report_path


def is_numeric_tool_id(tool_id: str) -> bool:
    """Check if a tool server ID is numeric (old format) vs stable (new format).

    Args:
        tool_id: Tool server ID to check

    Returns:
        True if numeric (e.g., server:0, server:123), False if stable (e.g., server:glean)
    """
    if not tool_id.startswith("server:"):
        return False

    suffix = tool_id[7:]  # Remove "server:" prefix
    return suffix.isdigit()


def find_best_match(target_name: str, candidate_names: List[str], threshold: float = 0.6) -> Tuple[str, float]:
    """Find the best matching name using fuzzy string matching.

    Args:
        target_name: Name to match (e.g., "Glean")
        candidate_names: List of candidate names from discovered servers
        threshold: Minimum similarity score (0.0-1.0)

    Returns:
        Tuple of (best_match_name, similarity_score) or (None, 0.0) if no good match
    """
    if not candidate_names:
        return None, 0.0

    # Normalize names for comparison (lowercase, strip whitespace)
    target_normalized = target_name.lower().strip()

    best_match = None
    best_score = 0.0

    for candidate in candidate_names:
        candidate_normalized = candidate.lower().strip()

        # Use difflib's SequenceMatcher for similarity (similar to Levenshtein)
        similarity = difflib.SequenceMatcher(None, target_normalized, candidate_normalized).ratio()

        if similarity > best_score:
            best_score = similarity
            best_match = candidate

    if best_score >= threshold:
        return best_match, best_score
    else:
        return None, best_score


async def build_migration_mapping(page_or_client, discovered_mcp_servers: Dict[str, Any]) -> Tuple[Dict[str, List[str]], Dict[str, Any]]:
    """Build migration mapping from old numeric tool IDs to new stable IDs.

    Args:
        page_or_client: Playwright page object or Open WebUI API client
        discovered_mcp_servers: Dict mapping tool names to metadata (from MCP discovery)

    Returns:
        Tuple of:
        - migration_mapping: Dict mapping model_id to list of new stable tool IDs
        - migration_data: Dict with data for report generation (numeric_to_stable, unmappable_ids, etc.)
    """
    logger.info("=" * 60)
    logger.info("🔄 ONE-TIME MIGRATION: Checking for numeric tool server IDs")
    logger.info("=" * 60)
    client = coerce_open_webui_api_client(page_or_client)

    # Step 1: Fetch existing tool servers from OWUI
    logger.info("📋 Fetching existing tool servers from OWUI...")

    try:
        existing_tools = await client.get_json("/api/v1/tools/")
    except OpenWebUIApiError as exc:
        logger.warning(f"  ⚠️  Could not fetch existing tool servers: {exc}")
        logger.info("  ℹ️  Skipping migration (probably first run)")
        return {}, {}
    logger.info(f"  ✅ Found {len(existing_tools)} existing tool servers")

    # Step 2: Identify numeric IDs and build mapping
    numeric_id_to_stable = {}
    unmappable_ids = {}  # Track IDs that couldn't be matched
    has_numeric_ids = False

    discovered_names = list(discovered_mcp_servers.keys())

    for tool in existing_tools:
        tool_id = tool.get('id', '')
        tool_name = tool.get('name', '')

        if is_numeric_tool_id(tool_id):
            has_numeric_ids = True
            logger.info(f"  🔍 Found numeric ID: {tool_id} → {tool_name}")

            # SPECIAL CASE: Always map Glean to server:glean (even if not discovered)
            if 'glean' in tool_name.lower():
                stable_id = "server:glean"
                numeric_id_to_stable[tool_id] = stable_id
                logger.info(f"    ✅ Hardcoded mapping (Glean exception): {stable_id}")
                logger.info(f"    ℹ️  Glean is always mapped regardless of discovery status")
            else:
                # Try to match this name to a discovered MCP server
                best_match, score = find_best_match(tool_name, discovered_names)

                if best_match:
                    stable_id = f"server:{best_match}"
                    numeric_id_to_stable[tool_id] = stable_id
                    logger.info(f"    ✅ Matched to: {stable_id} (similarity: {score:.2f})")
                else:
                    # Track unmappable IDs for reporting
                    unmappable_ids[tool_id] = {
                        'name': tool_name,
                        'best_score': score
                    }
                    logger.warning(f"    ⚠️  No good match found for '{tool_name}' (best score: {score:.2f})")
                    logger.warning(f"    ⚠️  This ID will be SKIPPED in model migrations")
        else:
            logger.debug(f"  ✅ Already stable: {tool_id}")

    if not has_numeric_ids:
        logger.info("  ✅ All tool servers already using stable IDs - no migration needed!")
        return {}, {}

    logger.info(f"  📋 Built mapping for {len(numeric_id_to_stable)} numeric IDs:")
    for old_id, new_id in numeric_id_to_stable.items():
        logger.info(f"    • {old_id} → {new_id}")

    # Step 3: Fetch all models to find which ones need migration
    logger.info("📋 Fetching all models to identify migration candidates...")

    try:
        all_models = await client.get_json("/api/v1/models")
    except OpenWebUIApiError:
        logger.error("  ❌ Failed to fetch models for migration")
        return {}, {}

    logger.info(f"  ✅ Fetched {len(all_models)} total models")

    # Step 4: Build migration mapping for non-base models with numeric tool IDs
    migration_mapping = {}
    models_needing_migration = 0
    models_with_unmappable_ids = []  # Track which models have unmappable IDs

    for model in all_models:
        model_id = model.get('id', '')
        model_name = model.get('name', model_id)
        base_model_id = model.get('base_model_id')

        # Skip base models (they get core_tool_ids set explicitly)
        if base_model_id is None:
            continue

        # Get current toolIds
        current_tool_ids = model.get('meta', {}).get('toolIds', [])

        if not current_tool_ids:
            continue  # No tools configured

        # Check if ANY tool IDs are numeric
        has_numeric = any(is_numeric_tool_id(tid) for tid in current_tool_ids)

        if not has_numeric:
            continue  # Already using stable IDs

        # Migrate numeric IDs to stable IDs (SKIP unmappable IDs)
        new_tool_ids = []
        migrated = False
        skipped_ids = []

        for old_id in current_tool_ids:
            if is_numeric_tool_id(old_id):
                new_id = numeric_id_to_stable.get(old_id)
                if new_id:
                    # Successfully mapped - add to new list
                    new_tool_ids.append(new_id)
                    migrated = True
                    logger.info(f"    🔄 {model_name}: {old_id} → {new_id}")
                else:
                    # Unmappable - SKIP this ID (don't add to new_tool_ids)
                    skipped_ids.append(old_id)
                    logger.warning(f"    ⚠️  {model_name}: Skipping unmappable {old_id}")
            else:
                # Already stable, keep it
                new_tool_ids.append(old_id)

        if skipped_ids:
            models_with_unmappable_ids.append({
                'model_id': model_id,
                'model_name': model_name,
                'skipped_ids': skipped_ids
            })

        if migrated or skipped_ids:
            migration_mapping[model_id] = new_tool_ids
            models_needing_migration += 1
            logger.info(f"  📝 Migration plan for {model_name}:")
            logger.info(f"    OLD: {current_tool_ids}")
            logger.info(f"    NEW: {new_tool_ids}")
            if skipped_ids:
                logger.info(f"    SKIPPED: {skipped_ids} (unmappable)")

    logger.info("=" * 60)
    logger.info(f"✅ Migration analysis complete:")
    logger.info(f"  • Models needing migration: {models_needing_migration}")
    logger.info(f"  • Total models scanned: {len(all_models)}")
    logger.info(f"  • Models with unmappable IDs: {len(models_with_unmappable_ids)}")
    if models_needing_migration == 0:
        logger.info(f"  ✅ No migrations needed - all models already using stable IDs!")
    logger.info("=" * 60)

    # Build migration data for report generation
    migration_data = {
        'numeric_to_stable': numeric_id_to_stable,
        'unmappable_ids': unmappable_ids,
        'models_with_unmappable': models_with_unmappable_ids
    }

    return migration_mapping, migration_data
