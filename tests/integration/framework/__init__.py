"""
Agentic Integration Testing Framework

Uses Atlas Agent SDK to run test specifications defined in Markdown.
Each test instructs an agent to simulate chat interactions and verify
system behavior through Docker logs, Redis state, and chat transcripts.
"""

from .agent_runner import IntegrationTestRunner, TestResult, Assertion

__all__ = ["IntegrationTestRunner", "TestResult", "Assertion"]
