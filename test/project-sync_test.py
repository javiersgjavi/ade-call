import contextlib
import importlib.util
import io
import sqlite3
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location(
    "sync_projects", Path(__file__).resolve().parents[1] / "scripts/sync-t3-projects.py"
)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class ProjectSyncTest(unittest.TestCase):
    def test_discovery_is_nonrecursive_and_respects_existing_and_archived(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "Projects"
            root.mkdir()
            base = Path(tmp) / "t3"
            (base / "userdata").mkdir(parents=True)
            for name in ["existing", "archived", "new project", "plain-folder", ".hidden"]:
                (root / name).mkdir()
            (root / "new project" / "nested").mkdir()
            (root / "alias").symlink_to(root / "new project", target_is_directory=True)
            dbpath = base / "userdata/statev2.sqlite"
            with sqlite3.connect(dbpath) as db:
                db.execute("CREATE TABLE projection_projects(workspace_root, archived_at)")
                db.executemany(
                    "INSERT INTO projection_projects VALUES (?,?)",
                    [(str(root / "existing"), None), (str(root / "archived"), "date")],
                )
            calls = []

            def run(args, **kwargs):
                calls.append(args)
                with sqlite3.connect(dbpath) as db:
                    db.execute("INSERT INTO projection_projects VALUES (?,NULL)", (args[3],))
                return SimpleNamespace(returncode=0)

            self.assertEqual(m.sync(root, base, Path("/fake/t3"), run), 0)
            self.assertEqual(
                [c[3] for c in calls], [str(root / "new project"), str(root / "plain-folder")]
            )
            self.assertEqual(m.sync(root, base, Path("/fake/t3"), run), 0)
            self.assertEqual(len(calls), 2)

    def test_failed_registration_continues_without_exposing_cli_output_or_writing_database(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "Projects"
            root.mkdir()
            base = Path(tmp) / "t3"
            (base / "userdata").mkdir(parents=True)
            for name in ["a-fails", "b-timeout", "c-ok"]:
                (root / name).mkdir()
            dbpath = base / "userdata/statev2.sqlite"
            with sqlite3.connect(dbpath) as db:
                db.execute("CREATE TABLE projection_projects(workspace_root)")
            before = dbpath.read_bytes()
            calls = []

            def run(args, **kwargs):
                calls.append(args)
                self.assertEqual(kwargs["timeout"], 60)
                self.assertTrue(kwargs["capture_output"])
                if len(calls) == 2:
                    raise subprocess.TimeoutExpired(args, 60, stderr="private-output")
                return SimpleNamespace(
                    returncode=1 if len(calls) == 1 else 0, stderr="private-output"
                )

            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                self.assertEqual(m.sync(root, base, Path("/fake/t3"), run), 2)
            self.assertEqual(len(calls), 3)
            self.assertNotIn("private-output", output.getvalue())
            self.assertEqual(dbpath.read_bytes(), before)

    def test_missing_database_fails_without_creating_it_or_sending(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with self.assertRaises(sqlite3.OperationalError):
                m.missing_projects(root, root / "missing.sqlite")
            self.assertFalse((root / "missing.sqlite").exists())


if __name__ == "__main__":
    unittest.main()
