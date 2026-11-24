"""Local deployment-script regressions. Never invoke SSH, Git, Nginx or certbot."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / 'deploy-staging.sh'


class StagingScriptTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='asksales-staging-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        self.site = self.root / 'site'
        self.link = self.root / 'enabled'
        self.bootstrap = self.root / 'bootstrap'
        self.cert = self.root / 'cert'
        self.incoming = self.root / 'incoming'
        self.log = self.root / 'commands.log'
        self.site.write_text('PREVIOUS VALID CONFIG\n')
        self.site.chmod(0o640)
        self.link.symlink_to('site')
        self.cert.write_text('synthetic certificate placeholder')
        self.incoming.write_text('NEW VALID CONFIG\n')
        self.env = dict(os.environ, PATH=f'{self.bin}:{os.environ["PATH"]}',
                        TMPDIR=str(self.root), QA_ROOT=str(self.root))
        # These executables only inspect/write fixture files in this temp directory.
        self.stub('nginx', '''
root = Path(os.environ['QA_ROOT'])
with (root / 'commands.log').open('a') as log: log.write('nginx\\n')
entry = root / 'enabled'
invalid = entry.is_symlink() and not entry.exists()
invalid = invalid or (entry.exists() and 'INVALID' in entry.read_text())
if os.environ.get('QA_FAIL_RESTORE') and (root / 'reload-failed').exists(): invalid = True
sys.exit(1 if invalid else 0)
''')
        self.stub('systemctl', '''
root = Path(os.environ['QA_ROOT'])
with (root / 'commands.log').open('a') as log: log.write('reload\\n')
if os.environ.get('QA_FAIL_ALL_RELOAD'): sys.exit(1)
if os.environ.get('QA_FAIL_RELOAD') and not (root / 'reload-failed').exists():
    (root / 'reload-failed').touch()
    sys.exit(1)
''')
        self.stub('certbot', '''
root = Path(os.environ['QA_ROOT'])
with (root / 'commands.log').open('a') as log: log.write('certbot\\n')
sys.exit(1 if os.environ.get('QA_FAIL_CERTBOT') else 0)
''')
        for command in ('git', 'ssh', 'scp'):
            self.stub(command, '''
root = Path(os.environ['QA_ROOT'])
(root / 'FORBIDDEN_COMMAND').write_text(sys.argv[0])
sys.exit(99)
''')

    def stub(self, name, code):
        path = self.bin / name
        path.write_text(f'#!{sys.executable}\nimport os, sys\nfrom pathlib import Path\n' + code)
        path.chmod(0o755)

    def run_transaction(self):
        source = SCRIPT.read_text().split('# BEGIN STAGING NGINX TRANSACTION\n', 1)[1].split('# END STAGING NGINX TRANSACTION', 1)[0]
        source = source.replace('/etc/letsencrypt/live/dev.asksales.ai/fullchain.pem', str(self.cert))
        source = source.replace('/etc/nginx/sites-available/asksales-dev-bootstrap', str(self.bootstrap))
        source = source.replace('/var/www/letsencrypt', str(self.root / 'webroot'))
        # Positional arguments avoid evaluating fixture paths as shell source.
        source = 'set -euo pipefail\nnginx_site="$1"\nnginx_link="$2"\nremote_nginx="$3"\n' + source
        return subprocess.run(['bash', '-c', source, 'qa', str(self.site), str(self.link), str(self.incoming)],
                              env=self.env, capture_output=True, text=True, timeout=10)

    def assert_previous(self):
        self.assertEqual(self.site.read_text(), 'PREVIOUS VALID CONFIG\n')
        self.assertEqual(self.site.stat().st_mode & 0o777, 0o640)
        self.assertTrue(self.link.is_symlink())
        self.assertEqual(os.readlink(self.link), 'site')
        self.assertTrue(self.link.exists())
        self.assertFalse(self.bootstrap.exists())
        self.assertFalse(list(self.root.glob('asksales-nginx.*')))
        self.assertFalse((self.root / 'FORBIDDEN_COMMAND').exists())

    def test_rejects_every_non_staging_ref_before_publication(self):
        for ref in ('v7', 'main', 'production', 'refs/heads/staging', 'feature/qa', '', 'staging;bad'):
            with self.subTest(ref=ref):
                result = subprocess.run(['bash', str(SCRIPT)], env=dict(self.env, STAGING_REF=ref),
                                        capture_output=True, text=True, timeout=10)
                self.assertEqual(result.returncode, 1)
                self.assertIn('non-staging ref', result.stderr)
                self.assertFalse((self.root / 'FORBIDDEN_COMMAND').exists())

    def test_invalid_config_with_existing_certificate_restores_previous(self):
        self.incoming.write_text('INVALID NEW CONFIG')
        result = self.run_transaction()
        self.assertNotEqual(result.returncode, 0, result.stderr)
        self.assert_previous()
        self.assertEqual(self.log.read_text().splitlines(), ['nginx', 'nginx', 'nginx', 'reload'])

    def test_regular_enabled_file_is_restored(self):
        self.link.unlink()
        self.link.write_text('PREVIOUS ENABLED FILE')
        self.incoming.write_text('INVALID')
        self.assertNotEqual(self.run_transaction().returncode, 0)
        self.assertFalse(self.link.is_symlink())
        self.assertEqual(self.link.read_text(), 'PREVIOUS ENABLED FILE')

    def test_absent_entries_are_removed_on_failure(self):
        self.site.unlink()
        self.link.unlink()
        self.incoming.write_text('INVALID')
        self.assertNotEqual(self.run_transaction().returncode, 0)
        self.assertFalse(self.site.exists())
        self.assertFalse(self.link.exists())
        self.assertFalse(self.link.is_symlink())

    def test_certificate_failure_restores_prior_bootstrap_and_link(self):
        self.cert.unlink()
        self.bootstrap.write_text('PREVIOUS BOOTSTRAP')
        self.env['QA_FAIL_CERTBOT'] = '1'
        self.assertNotEqual(self.run_transaction().returncode, 0)
        self.assertEqual(self.bootstrap.read_text(), 'PREVIOUS BOOTSTRAP')
        self.assertEqual(self.site.read_text(), 'PREVIOUS VALID CONFIG\n')
        self.assertEqual(os.readlink(self.link), 'site')
        self.assertEqual(self.log.read_text().splitlines(), ['nginx', 'nginx', 'reload', 'certbot', 'nginx', 'reload'])

    def test_reload_failure_restores_previous(self):
        self.env['QA_FAIL_RELOAD'] = '1'
        self.assertNotEqual(self.run_transaction().returncode, 0)
        self.assert_previous()

    def test_failed_restore_retains_backup_and_reports_failure(self):
        self.env.update(QA_FAIL_RELOAD='1', QA_FAIL_RESTORE='1')
        result = self.run_transaction()
        self.assertNotEqual(result.returncode, 0)
        backups = list(self.root.glob('asksales-nginx.*'))
        self.assertEqual(len(backups), 1)
        self.assertEqual((backups[0] / '0').read_text(), 'PREVIOUS VALID CONFIG\n')
        self.assertIn('operator attention; backup retained', result.stderr)

    def test_certificate_failure_removes_new_bootstrap(self):
        self.cert.unlink()
        self.env['QA_FAIL_CERTBOT'] = '1'
        self.assertNotEqual(self.run_transaction().returncode, 0)
        self.assert_previous()

    def test_successful_certificate_setup_commits_final_site(self):
        self.cert.unlink()
        result = self.run_transaction()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.site.read_text(), 'NEW VALID CONFIG\n')
        self.assertEqual(os.readlink(self.link), str(self.site))
        self.assertEqual(self.log.read_text().splitlines(), ['nginx', 'nginx', 'reload', 'certbot', 'nginx', 'reload'])
        self.assertFalse(list(self.root.glob('asksales-nginx.*')))

    def test_invalid_final_site_after_certificate_setup_restores_previous(self):
        self.cert.unlink()
        self.incoming.write_text('INVALID')
        self.assertNotEqual(self.run_transaction().returncode, 0)
        self.assert_previous()

    def test_invalid_baseline_makes_no_configuration_changes(self):
        self.site.write_text('INVALID BASELINE')
        self.assertNotEqual(self.run_transaction().returncode, 0)
        self.assertEqual(self.site.read_text(), 'INVALID BASELINE')
        self.assertEqual(os.readlink(self.link), 'site')
        self.assertFalse(list(self.root.glob('asksales-nginx.*')))
        self.assertEqual(self.log.read_text().splitlines(), ['nginx'])

    def test_existing_site_symlink_does_not_overwrite_its_target(self):
        target = self.root / 'shared-site'
        target.write_text('PREVIOUS VALID CONFIG\n')
        self.site.unlink()
        self.site.symlink_to('shared-site')
        self.incoming.write_text('INVALID')
        self.assertNotEqual(self.run_transaction().returncode, 0)
        self.assertEqual(os.readlink(self.site), 'shared-site')
        self.assertEqual(target.read_text(), 'PREVIOUS VALID CONFIG\n')
        self.assertEqual(os.readlink(self.link), 'site')

    def test_rollback_reload_failure_retains_backup(self):
        self.incoming.write_text('INVALID')
        self.env['QA_FAIL_ALL_RELOAD'] = '1'
        result = self.run_transaction()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('operator attention; backup retained', result.stderr)
        self.assertEqual(len(list(self.root.glob('asksales-nginx.*'))), 1)
        self.assertEqual(self.site.read_text(), 'PREVIOUS VALID CONFIG\n')
        self.assertEqual(os.readlink(self.link), 'site')

    def test_valid_configuration_commits_after_validation_and_reload(self):
        result = self.run_transaction()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.site.read_text(), 'NEW VALID CONFIG\n')
        self.assertEqual(os.readlink(self.link), str(self.site))
        self.assertEqual(self.log.read_text().splitlines(), ['nginx', 'nginx', 'reload'])
        self.assertFalse(list(self.root.glob('asksales-nginx.*')))


if __name__ == '__main__':
    unittest.main()
