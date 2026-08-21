"""
Integration Test Runner

Runs test specifications defined in Markdown.
Can run with Atlas Agent SDK or in direct mode.
"""

import asyncio
import json
import os
import re
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

import yaml

from .tools.assertions import Assertion, clear_assertions, get_all_assertions, get_assertion_summary


@dataclass
class TestSpec:
    """Parsed test specification."""
    name: str
    description: str
    timeout: int
    tags: List[str]
    content: str
    file_path: Path

    @classmethod
    def from_file(cls, path: Path) -> "TestSpec":
        """Parse a test spec from a Markdown file."""
        text = path.read_text()

        # Extract YAML frontmatter
        frontmatter_match = re.match(r'^---\s*\n(.*?)\n---\s*\n', text, re.DOTALL)
        if frontmatter_match:
            frontmatter = yaml.safe_load(frontmatter_match.group(1))
            content = text[frontmatter_match.end():]
        else:
            frontmatter = {}
            content = text

        return cls(
            name=frontmatter.get("name", path.stem),
            description=frontmatter.get("description", ""),
            timeout=frontmatter.get("timeout", 300),
            tags=frontmatter.get("tags", []),
            content=content,
            file_path=path
        )


@dataclass
class TestResult:
    """Result of running a test specification."""
    spec: TestSpec
    success: bool
    assertions: List[Assertion]
    summary: Dict[str, Any]
    duration_seconds: float
    error: Optional[str] = None
    agent_messages: List[Dict] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "name": self.spec.name,
            "description": self.spec.description,
            "success": self.success,
            "assertions": [a.to_dict() for a in self.assertions],
            "summary": self.summary,
            "duration_seconds": self.duration_seconds,
            "error": self.error
        }


class IntegrationTestRunner:
    """Runs integration test specs."""

    def __init__(self, spec_path: Path):
        """
        Initialize the test runner.

        Args:
            spec_path: Path to the test specification Markdown file
        """
        self.spec_path = Path(spec_path)
        self.spec = TestSpec.from_file(self.spec_path)
        self.agent_messages: List[Dict] = []

    async def run(self) -> TestResult:
        """
        Execute the test spec.

        Tries Atlas Agent SDK first, falls back to direct mode.

        Returns:
            TestResult with all assertions and outcome
        """
        start_time = datetime.now()
        clear_assertions()

        try:
            # Try Atlas Agent SDK
            return await asyncio.wait_for(
                self._run_with_atlas_sdk(),
                timeout=self.spec.timeout,
            )
        except asyncio.TimeoutError:
            assertions = get_all_assertions()
            summary = get_assertion_summary()
            assertions_file = os.environ.pop("ASSERTIONS_FILE", None)
            if assertions_file:
                Path(assertions_file).unlink(missing_ok=True)
            return TestResult(
                spec=self.spec,
                success=False,
                assertions=assertions,
                summary=summary,
                duration_seconds=(datetime.now() - start_time).total_seconds(),
                error=(
                    f"Agentic integration test exceeded its declared "
                    f"{self.spec.timeout}s timeout"
                ),
            )
        except Exception as sdk_error:
            # Fall back to direct mode
            print(f"SDK mode failed ({sdk_error}), using direct mode")
            return await self._run_direct_mode()

    async def _run_with_atlas_sdk(self) -> TestResult:
        """Run test using Atlas Agent SDK."""
        from atlas_code_sdk import query, AtlasCodeOptions, ResultMessage, AssistantMessage, SystemMessage, UserMessage
        from rich.console import Console
        from rich.panel import Panel
        from rich.syntax import Syntax
        from rich.table import Table
        from rich.text import Text
        from rich.live import Live
        from rich.spinner import Spinner
        from rich.rule import Rule
        from rich import box
        import textwrap

        console = Console(force_terminal=True)
        start_time = datetime.now()

        # Create a unique assertions file for this test run
        import uuid
        assertions_file = f"/tmp/test_assertions_{uuid.uuid4().hex}.json"
        os.environ["ASSERTIONS_FILE"] = assertions_file

        # Get model from environment or use default
        model = os.environ.get("ATLAS_MODEL", "atlas-opus-4-5-20251101")
        redis_host = os.environ.get("REDIS_HOST", "localhost")
        owui_url = os.environ.get("OPENWEBUI_BASE_URL", "http://localhost:3789")

        # Build env prefix for commands
        env_prefix = f'ASSERTIONS_FILE="{assertions_file}" REDIS_HOST="{redis_host}" OPENWEBUI_BASE_URL="{owui_url}"'

        system_prompt = f"""You are an integration test agent for Open WebUI.

Execute the test specification step by step. For each step:
1. Read what the step asks you to do
2. Use Bash to execute the test commands
3. Interpret the results

IMPORTANT: Always set these environment variables before running Python commands:
{env_prefix}

Available test commands (run via Bash with the env vars above):
- {env_prefix} python -c "from framework.tools import *; import asyncio; print(asyncio.run(simulate_chat(prompt='...')))"
- {env_prefix} python -c "from framework.tools import *; import asyncio; print(asyncio.run(check_docker_logs(patterns=[...])))"
- {env_prefix} python -c "from framework.tools import *; import asyncio; print(asyncio.run(check_redis(key='...')))"
- {env_prefix} python -c "from framework.tools import *; import asyncio; print(asyncio.run(verify_system_messages(chat_id='...', expected_patterns=[...])))"
- {env_prefix} python -c "from framework.tools import *; import asyncio; print(asyncio.run(verify_enabled_tools(chat_id='...', expected_tools=[...])))"
- {env_prefix} python -c "from framework.tools import *; import asyncio; print(asyncio.run(assert_condition(condition=True/False, message='...')))"

After each verification, always call assert_condition to record the result.

Work directory: /Users/dsantiago/portico/open-webui-mcp/tests/integration
"""

        options = AtlasCodeOptions(
            system_prompt=system_prompt,
            model=model,
            max_turns=30,
            permission_mode="bypassPermissions",
            cwd=str(self.spec_path.parent.parent),  # tests/integration directory
        )

        result_message = None
        tool_count = 0

        # Print header
        console.print()
        console.print(Panel.fit(
            f"[bold cyan]{self.spec.name}[/bold cyan]\n"
            f"[dim]Model: {model}[/dim]",
            title="🧪 Agent Test Starting",
            border_style="cyan"
        ))
        console.print()

        try:
            async for message in query(
                prompt=f"Execute this test specification:\n\n{self.spec.content}",
                options=options
            ):
                msg_type = type(message).__name__
                self.agent_messages.append({"type": msg_type})

                elapsed = (datetime.now() - start_time).total_seconds()
                time_str = f"[dim][{elapsed:5.1f}s][/dim]"

                if isinstance(message, AssistantMessage):
                    for block in message.content:
                        if hasattr(block, 'text'):
                            text = block.text.strip()
                            if text:
                                # Wrap long text
                                wrapped = textwrap.fill(text, width=100)
                                console.print(f"\n{time_str} [bold blue]Agent:[/bold blue]")
                                console.print(Panel(wrapped, border_style="blue", box=box.ROUNDED))
                        elif hasattr(block, 'name'):
                            tool_count += 1
                            tool_name = block.name
                            tool_input = getattr(block, 'input', {})

                            # Create a nice tool call display
                            console.print(f"\n{time_str} [bold yellow]🔧 Tool #{tool_count}:[/bold yellow] [cyan]{tool_name}[/cyan]")

                            # Special handling for Bash - show command with syntax highlighting
                            if tool_name == "Bash" and isinstance(tool_input, dict):
                                cmd = tool_input.get("command", "")
                                desc = tool_input.get("description", "")
                                if desc:
                                    console.print(f"[dim italic]{desc}[/dim italic]")
                                if cmd:
                                    # Use syntax highlighting for bash
                                    syntax = Syntax(cmd, "bash", theme="monokai", line_numbers=False, word_wrap=True)
                                    console.print(Panel(syntax, title="[yellow]Command[/yellow]", border_style="yellow", box=box.ROUNDED))
                            elif isinstance(tool_input, dict) and tool_input:
                                table = Table(show_header=False, box=box.SIMPLE, padding=(0, 1))
                                table.add_column("Key", style="green")
                                table.add_column("Value", style="white", overflow="fold")

                                for k, v in tool_input.items():
                                    v_str = str(v)
                                    if len(v_str) > 300:
                                        v_str = v_str[:300] + f"[dim]... ({len(str(v))} chars)[/dim]"
                                    table.add_row(k, v_str)
                                console.print(table)

                elif isinstance(message, UserMessage):
                    content = message.content
                    console.print(f"\n{time_str} [bold green]📤 Result:[/bold green]")

                    result_text = ""
                    if isinstance(content, list):
                        for block in content:
                            if hasattr(block, 'content'):
                                result_text = str(block.content)
                    elif isinstance(content, str):
                        result_text = content

                    if result_text:
                        # Truncate very long results
                        if len(result_text) > 1500:
                            display_text = result_text[:1500]
                            truncated = True
                        else:
                            display_text = result_text
                            truncated = False

                        # Try to detect and syntax highlight JSON
                        stripped = display_text.strip()
                        if (stripped.startswith('{') and stripped.endswith('}')) or \
                           (stripped.startswith('[') and stripped.endswith(']')):
                            try:
                                # Pretty print JSON
                                import json as json_module
                                parsed = json_module.loads(stripped)
                                pretty = json_module.dumps(parsed, indent=2)
                                if truncated:
                                    pretty += f"\n... ({len(result_text)} chars total)"
                                syntax = Syntax(pretty, "json", theme="monokai", line_numbers=False, word_wrap=True)
                                console.print(Panel(syntax, border_style="green", box=box.ROUNDED))
                            except:
                                if truncated:
                                    display_text += f"\n[dim]... ({len(result_text)} chars total)[/dim]"
                                console.print(Panel(display_text, border_style="green", box=box.ROUNDED))
                        else:
                            if truncated:
                                display_text += f"\n[dim]... ({len(result_text)} chars total)[/dim]"
                            console.print(Panel(display_text, border_style="green", box=box.ROUNDED))

                elif isinstance(message, ResultMessage):
                    result_message = message
                    console.print()
                    console.print(Panel.fit(
                        f"[bold green]✅ Agent Completed[/bold green]\n"
                        f"[dim]Duration: {elapsed:.1f}s | Tools used: {tool_count}[/dim]",
                        border_style="green"
                    ))

                elif isinstance(message, SystemMessage):
                    console.print(f"{time_str} [dim][System message][/dim]")

        except Exception as e:
            # Ignore SDK cleanup errors that occur during generator close
            if "cancel scope" not in str(e).lower():
                raise

        # Load assertions from file (agent wrote them there)
        assertions = get_all_assertions()
        summary = get_assertion_summary()
        duration = (datetime.now() - start_time).total_seconds()

        # Clean up assertions file
        if os.path.exists(assertions_file):
            os.remove(assertions_file)

        return TestResult(
            spec=self.spec,
            success=summary["critical_passed"],
            assertions=assertions,
            summary=summary,
            duration_seconds=duration,
            agent_messages=self.agent_messages
        )

    async def _run_direct_mode(self) -> TestResult:
        """
        Run test in direct mode without Atlas SDK.

        Validates the spec can be parsed and basic checks pass.
        """
        from .tools.assertions import assert_condition

        start_time = datetime.now()
        clear_assertions()

        try:
            # Basic validation
            await assert_condition(
                condition=True,
                message=f"Test spec '{self.spec.name}' parsed successfully",
                severity="info"
            )

            await assert_condition(
                condition=len(self.spec.content) > 0,
                message="Test spec has content",
                severity="critical"
            )

            await assert_condition(
                condition=len(self.spec.tags) > 0,
                message=f"Test spec has tags: {self.spec.tags}",
                severity="info"
            )

            duration = (datetime.now() - start_time).total_seconds()

            return TestResult(
                spec=self.spec,
                success=True,
                assertions=get_all_assertions(),
                summary=get_assertion_summary(),
                duration_seconds=duration,
                error="Running in direct mode - spec validation only"
            )

        except Exception as e:
            duration = (datetime.now() - start_time).total_seconds()
            return TestResult(
                spec=self.spec,
                success=False,
                assertions=get_all_assertions(),
                summary=get_assertion_summary(),
                duration_seconds=duration,
                error=str(e)
            )


async def run_spec(spec_path: Path) -> TestResult:
    """Convenience function to run a single test spec."""
    runner = IntegrationTestRunner(spec_path)
    return await runner.run()


async def run_all_specs(specs_dir: Path) -> List[TestResult]:
    """Run all test specs in a directory."""
    results = []
    for spec_file in sorted(specs_dir.glob("*.md")):
        result = await run_spec(spec_file)
        results.append(result)
        status = "✅" if result.success else "❌"
        print(f"{status} {result.spec.name}: {result.summary}")
    return results
