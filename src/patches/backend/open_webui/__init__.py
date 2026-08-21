"""Minimal package initializer for the Docker runtime.

The container starts Uvicorn directly against ``open_webui.main:app`` and does
not use Open WebUI's Typer CLI bootstrap. Keeping the package initializer empty
avoids pulling CLI-only dependencies into normal imports.
"""
