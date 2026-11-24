"""Exercise staging's exact backup validation with a stdin-aware Compose fake."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


@unittest.skipIf(os.name == 'nt', 'Requires POSIX shell stdin semantics')
class StagingBackupInputTests(unittest.TestCase):
    def validate(self, content, close_stdin=False):
        source = (ROOT / 'deploy-staging.sh').read_text()
        validation = source.split('test -s "$staging_backup"\n', 1)[1].split(
            "echo 'Applying staging database migrations.'", 1)[0]
        if close_stdin:
            validation = validation.replace('--interactive=true', '--interactive=false')
        harness = r'''set -euo pipefail
compose() {
  [[ " $* " == *" exec -T "* ]]
  [[ " $* " == *" db pg_restore --list "* ]]
  if [[ " $* " == *" --interactive=false "* ]]; then
    return 42
  fi
  [[ "$(cat)" == 'synthetic PostgreSQL archive' ]] || return 43
}
staging_backup="$1"
'''
        with tempfile.TemporaryDirectory(prefix='asksales-backup-input-') as directory:
            dump = Path(directory) / 'retained.dump'
            dump.write_text(content)
            return subprocess.run(['bash', '-c', harness + validation, 'qa', str(dump)],
                                  capture_output=True, text=True, timeout=5)

    def test_retained_archive_reaches_pg_restore_without_a_tty(self):
        result = self.validate('synthetic PostgreSQL archive')
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_closed_compose_stdin_cannot_pass_validation(self):
        self.assertEqual(self.validate('synthetic PostgreSQL archive', close_stdin=True).returncode, 42)

    def test_truncated_archive_cannot_pass_validation(self):
        self.assertEqual(self.validate('').returncode, 43)


if __name__ == '__main__':
    unittest.main()
