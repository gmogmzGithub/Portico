#!/usr/bin/env bash

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

ruby - "$PROJECT_ROOT/.gitlab-ci.yml" <<'RUBY'
require "yaml"

config = YAML.safe_load(File.read(ARGV.fetch(0)), aliases: true)
raise "public CI must define a test stage" unless config.fetch("stages") == ["test"]
raise "public CI must define merge-request workflow rules" unless
  config.dig("workflow", "rules").any? { |rule| rule["if"]&.include?("merge_request_event") }
test_job = config.fetch("test")
raise "public CI test job must run the repository gate" unless test_job.fetch("script") == ["./run-tests.sh"]
raise "public CI must not ship release-broker jobs by default" if config.key?("release")
puts "PASS: public GitLab CI contract"
RUBY
