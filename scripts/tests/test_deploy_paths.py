from __future__ import annotations

import importlib.util
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

MODULE_PATH = Path(__file__).parents[2] / "deploy" / "deploy_paths.py"
SPEC = importlib.util.spec_from_file_location("deploy_paths", MODULE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("could not load deploy path classifier")
deploy_paths = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(deploy_paths)


WORKFLOW = Path(__file__).parents[2] / ".github" / "workflows" / "ci-cd.yml"

# Steps of the deploy job that must never run when the classifier says "skip".
# "Configure the restricted deploy identity" is the one that matters most: it
# is what writes the restricted key to disk, and journalctl on the server
# counts one sshd login from that key per deploy.
GUARDED_STEPS = (
    "Configure the restricted deploy identity",
    "Build the immutable release archive",
    "Deploy through the forced server command",
    "Note on health verification",
)

GUARD = "if: steps.paths.outputs.deploy == 'true'"


class WorkflowWiringTests(unittest.TestCase):
    """The classifier only matters if the workflow actually asks it.

    Text assertions rather than a YAML parse, matching test_nginx_perimeter.py:
    the repository ships no YAML dependency, and what these guard is the literal
    shape a reviewer reads in the diff.
    """

    def setUp(self) -> None:
        self.text = WORKFLOW.read_text(encoding="utf-8")
        self.deploy_job = self.text[self.text.index("\n  deploy:") :]

    def test_the_deploy_job_asks_the_classifier(self) -> None:
        self.assertIn("id: paths", self.deploy_job)
        self.assertIn("python3 deploy/deploy_paths.py", self.deploy_job)
        self.assertIn("DEPLOY_PATHS_BEFORE: ${{ github.event.before }}", self.deploy_job)

    def test_the_deploy_checkout_has_full_history(self) -> None:
        # Without this the diff cannot be computed and every push deploys.
        self.assertIn("fetch-depth: 0", self.deploy_job)

    def test_every_acting_step_is_guarded(self) -> None:
        for step in GUARDED_STEPS:
            with self.subTest(step=step):
                index = self.deploy_job.index(f"- name: {step}")
                nextline = (
                    self.deploy_job.index("- name: ", index + 1)
                    if ("- name: " in self.deploy_job[index + 1 :])
                    else len(self.deploy_job)
                )
                self.assertIn(GUARD, self.deploy_job[index:nextline])

    def test_the_classifier_step_itself_is_not_guarded(self) -> None:
        # It must always run, so the job ends in success with a line in the log
        # rather than as a silent skip.
        index = self.deploy_job.index("- name: Decide whether this revision needs a deploy")
        following = self.deploy_job.index("- name: ", index + 1)

        self.assertNotIn(GUARD, self.deploy_job[index:following])

    def test_the_push_trigger_is_untouched(self) -> None:
        # D2 filters inside the job, never at the trigger: verify and
        # integration must keep running on every push.
        trigger = self.text[self.text.index("on:") : self.text.index("permissions:")]

        self.assertIn("branches:\n      - main", trigger)
        self.assertNotIn("paths:", trigger)
        self.assertNotIn("paths-ignore:", trigger)


class TextPathTests(unittest.TestCase):
    def test_documentation_and_agent_trees_are_text(self) -> None:
        for path in (
            "docs/HANDOFF.md",
            "docs/rfcs/RFC-020-deploy-sem-derrubar-o-banco.md",
            "prompts/roadmap/README.md",
            ".claude/settings.json",
            "README.md",
        ):
            with self.subTest(path=path):
                self.assertTrue(deploy_paths.is_text_path(path))

    def test_everything_that_can_reach_a_container_is_not_text(self) -> None:
        for path in (
            "apps/api/src/database.ts",
            "Makefile",
            "docker-compose.yml",
            ".github/workflows/ci-cd.yml",
            "deploy/remote-deploy.sh",
            ".gitignore",
            # config/ is bind-mounted into the running services, so a Markdown
            # file there is not a document as far as production is concerned.
            "config/runtime.json",
            "apps/api/src/notes.md",
            "",
        ):
            with self.subTest(path=path):
                self.assertFalse(deploy_paths.is_text_path(path))


class ClassifyTests(unittest.TestCase):
    def test_a_text_only_list_skips_the_deploy(self) -> None:
        deploy, reason = deploy_paths.classify(
            ["docs/HANDOFF.md", "prompts/roadmap/README.md", "README.md"]
        )

        self.assertFalse(deploy)
        self.assertIn(deploy_paths.SKIP_MESSAGE, reason)

    def test_one_source_file_is_enough_to_deploy(self) -> None:
        deploy, reason = deploy_paths.classify(["docs/HANDOFF.md", "apps/api/src/x.ts"])

        self.assertTrue(deploy)
        self.assertIn("apps/api/src/x.ts", reason)

    def test_documentation_next_to_the_makefile_still_deploys(self) -> None:
        deploy, reason = deploy_paths.classify(["docs/HANDOFF.md", "Makefile"])

        self.assertTrue(deploy)
        self.assertIn("Makefile", reason)

    def test_an_empty_list_deploys(self) -> None:
        # Absence of measurement, not evidence of no change.
        deploy, reason = deploy_paths.classify([])

        self.assertTrue(deploy)
        self.assertIn("vazia", reason)

    def test_whitespace_only_entries_count_as_empty(self) -> None:
        deploy, _ = deploy_paths.classify(["", "   ", "\t"])

        self.assertTrue(deploy)


class ChangedFilesTests(unittest.TestCase):
    def test_a_zeroed_before_has_no_base_and_raises(self) -> None:
        with self.assertRaises(ValueError):
            deploy_paths.changed_files(deploy_paths.NULL_SHA, "abc1234")

    def test_a_missing_before_raises(self) -> None:
        with self.assertRaises(ValueError):
            deploy_paths.changed_files("", "abc1234")

    def test_a_failing_git_diff_raises(self) -> None:
        failure = subprocess.CompletedProcess(
            args=["git", "diff"], returncode=128, stdout="", stderr="fatal: bad object"
        )
        with mock.patch.object(deploy_paths.subprocess, "run", return_value=failure):
            self.assertRaises(RuntimeError, deploy_paths.changed_files, "aaaaaaa", "bbbbbbb")

    def test_it_reads_a_real_git_range(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self._git(root, "init", "--quiet", "--initial-branch=main")
            self._git(root, "config", "user.email", "test@example.invalid")
            self._git(root, "config", "user.name", "test")
            (root / "README.md").write_text("one\n", encoding="utf-8")
            self._git(root, "add", "README.md")
            self._git(root, "commit", "--quiet", "-m", "first")
            before = self._git(root, "rev-parse", "HEAD").strip()
            (root / "docs").mkdir()
            (root / "docs" / "HANDOFF.md").write_text("two\n", encoding="utf-8")
            self._git(root, "add", "docs/HANDOFF.md")
            self._git(root, "commit", "--quiet", "-m", "second")
            sha = self._git(root, "rev-parse", "HEAD").strip()

            paths = deploy_paths.changed_files(before, sha, repository_root=str(root))

        self.assertEqual(paths, ["docs/HANDOFF.md"])
        self.assertEqual(deploy_paths.classify(paths)[0], False)

    @staticmethod
    def _git(root: Path, *arguments: str) -> str:
        result = subprocess.run(
            ["git", *arguments],
            check=True,
            capture_output=True,
            text=True,
            cwd=str(root),
        )
        return result.stdout


class DecideTests(unittest.TestCase):
    def test_workflow_dispatch_is_never_skipped(self) -> None:
        deploy, reason = deploy_paths.decide("workflow_dispatch", deploy_paths.NULL_SHA, "abc1234")

        self.assertTrue(deploy)
        self.assertIn("nunca é pulado", reason)

    def test_an_unknown_event_deploys(self) -> None:
        deploy, _ = deploy_paths.decide("", "aaaaaaa", "bbbbbbb")

        self.assertTrue(deploy)

    def test_an_unexpected_exception_deploys(self) -> None:
        with mock.patch.object(deploy_paths, "changed_files", side_effect=OSError("git is gone")):
            deploy, reason = deploy_paths.decide("push", "aaaaaaa", "bbbbbbb")

        self.assertTrue(deploy)
        self.assertIn("OSError", reason)

    def test_a_push_of_documentation_skips(self) -> None:
        with mock.patch.object(deploy_paths, "changed_files", return_value=["docs/HANDOFF.md"]):
            deploy, reason = deploy_paths.decide("push", "aaaaaaa", "bbbbbbb")

        self.assertFalse(deploy)
        self.assertIn(deploy_paths.SKIP_MESSAGE, reason)


class MainTests(unittest.TestCase):
    def test_it_writes_the_step_output_and_prints_the_reason(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "github_output"
            with mock.patch.object(deploy_paths, "changed_files", return_value=["docs/HANDOFF.md"]):
                code = deploy_paths.main(
                    [
                        "--event-name",
                        "push",
                        "--before",
                        "aaaaaaa",
                        "--sha",
                        "bbbbbbb",
                        "--output",
                        str(output),
                    ]
                )
            written = output.read_text(encoding="utf-8")

        self.assertEqual(code, 0)
        self.assertIn("deploy=false", written)

    def test_a_code_push_writes_deploy_true(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "github_output"
            with mock.patch.object(
                deploy_paths, "changed_files", return_value=["apps/api/src/database.ts"]
            ):
                deploy_paths.main(
                    [
                        "--event-name",
                        "push",
                        "--before",
                        "aaaaaaa",
                        "--sha",
                        "bbbbbbb",
                        "--output",
                        str(output),
                    ]
                )
            written = output.read_text(encoding="utf-8")

        self.assertIn("deploy=true", written)


if __name__ == "__main__":
    unittest.main()
