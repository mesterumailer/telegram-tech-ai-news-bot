def test_scaffold_has_safe_dry_run_default():
    # Production config should keep DRY_RUN=true until an end-to-end test is approved.
    from pathlib import Path
    env_example = Path(__file__).parents[1] / ".env.example"
    assert "DRY_RUN=true" in env_example.read_text()
