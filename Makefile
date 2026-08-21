# Portico — repro/verification targets (PORTICO-402/403 defect suite)

REPRO_PYTHON_TESTS = \
	tests.test_steer_seam_replay_continuity \
	tests.test_tool_result_overflow_replay \
	tests.test_replay_reasoning_policy

REPRO_ARTIFACT_DIR ?= tests/repro-artifacts/$(shell date -u +%Y-%m-%dT%H-%M-%SZ)

.PHONY: chat-repro-report chat-repro-unit chat-repro-rust chat-repro-integration

# Full reproduce-or-prove-fixed report. Known-red markers are disabled
# (portico_REPRO_STRICT=1) so unfixed defects fail loudly; the output directory is
# the dated evidence artifact. Run once on the unfixed baseline (red), once
# after each fix lands (green) — the diff of the two reports is the proof.
chat-repro-report:
	mkdir -p $(REPRO_ARTIFACT_DIR)
	@echo "== Tier 1: python unit repro (strict) =="
	-portico_REPRO_STRICT=1 python3 -m unittest $(REPRO_PYTHON_TESTS) -v \
		2>&1 | tee $(REPRO_ARTIFACT_DIR)/tier1-strict.txt
	@echo "== Tier 1: rust known-red repro =="
	-cd src/bifrost-bridge-rust && cargo test -- --ignored \
		2>&1 | tee ../../$(REPRO_ARTIFACT_DIR)/rust-ignored.txt
	@echo "== Tier 2: headless real-chat integration =="
	-node tests/integration-chat/run.mjs --report $(REPRO_ARTIFACT_DIR) \
		2>&1 | tee $(REPRO_ARTIFACT_DIR)/tier2-run.txt
	@echo "Artifacts: $(REPRO_ARTIFACT_DIR)"

chat-repro-unit:
	portico_REPRO_STRICT=1 python3 -m unittest $(REPRO_PYTHON_TESTS) -v

chat-repro-rust:
	cd src/bifrost-bridge-rust && cargo test -- --ignored

chat-repro-integration:
	node tests/integration-chat/run.mjs
