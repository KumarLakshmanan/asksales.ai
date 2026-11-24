"""Extracted remote release against fake commands; no SSH or real Docker/DB access."""
from pathlib import Path
import os
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / 'deploy.sh'
RELEASE = ROOT / 'scripts' / 'deploy-production-release.sh'
SHA = 'a' * 40
# Each fake Docker, SSH, and database command starts a Python process. Give
# the fixtures room to finish on the production runner under its CPU limit.
FIXTURE_TIMEOUT_SECONDS = 45


class ProductionReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='asksales-release-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for name in ['bin', 'server', 'nginx', 'backups', 'sites']:
            (self.root / name).mkdir()
        (self.root / 'server/.env').write_text('DB_USER=fixture\nDB_PASSWORD=synthetic\nDB_NAME=fixture\nSUPPORT_NOTIFICATION_HMAC_KEY=synthetic\n')
        (self.root / 'nginx/asksales.conf').write_text('NEW\n')
        (self.root / 'sites/asksales').write_text('PREVIOUS\n')
        (self.root / 'bundle').write_text('synthetic bundle')
        self.env = {'PATH': f'{self.root}/bin:/usr/bin:/bin', 'HOME': str(self.root),
                    'QA_ROOT': str(self.root), 'QA_SHA': SHA}
        self.stub('git', '''
if 'status' in sys.argv: print(' M changed' if os.environ.get('QA_DIRTY') else '')
elif '--show-current' in sys.argv: print('v8')
elif '--show-toplevel' in sys.argv: print(os.environ['QA_ROOT'])
elif 'symbolic-ref' in sys.argv: print(os.environ.get('QA_BRANCH', 'main'))
elif 'merge-base' in sys.argv and os.environ.get('QA_DIVERGENT'): sys.exit(1)
elif 'show-ref' in sys.argv and os.environ.get('QA_NEW_BRANCH'): sys.exit(1)
elif 'rev-parse' in sys.argv: print(os.environ['QA_SHA'])
''')
        self.stub('awk', "print('16777216' if 'SwapTotal' not in sys.argv[1] else '8388608')")
        self.stub('pgrep', 'sys.exit(1)')
        self.stub('docker', '''
args = ' '.join(sys.argv[1:])
if 'migrate.mjs status' in args: print('Total: 2 | Applied: 0 | Pending: 2')
elif 'migrate.mjs up' in args and os.environ.get('QA_MIGRATE_FAIL'): sys.exit(23)
elif 'config --format json' in args: print('{"name":"salesmarketing"}')
elif 'image inspect' in args:
    print('b'*40 if os.environ.get('QA_BAD_PREBUILT') and 'asksales-security-' in args else os.environ['QA_SHA'])
elif 'inspect' in args: print('sha256:synthetic')
''')
        self.stub('pg_dump', '''
if os.environ.get('QA_BACKUP_FAIL'): sys.exit(24)
target = next(arg.split('=',1)[1] for arg in sys.argv if arg.startswith('--file='))
Path(target).write_text('synthetic backup')
''')
        for command in ['pg_restore', 'curl', 'systemctl', 'nginx']:
            self.stub(command, '')
        for command in ['ssh', 'scp']:
            self.stub(command, 'raise RuntimeError("Forbidden external command")')

    def stub(self, name, code):
        target = self.root / 'bin' / name
        target.write_text(f'#!{sys.executable}\nimport sys,os\nfrom pathlib import Path\n'
                          "with (Path(os.environ['QA_ROOT'])/'commands').open('a') as f: f.write(Path(sys.argv[0]).name+' '+' '.join(sys.argv[1:])+'\\n')\n" + code)
        target.chmod(0o755)

    def release(self, *, bundle=None, cutover_from=''):
        source = RELEASE.read_text()
        source = source.replace('/var/lock/asksales-release.lock', str(self.root / 'release.lock'))
        source = source.replace('/var/backups/asksales', str(self.root / 'backups'))
        source = source.replace('/etc/nginx/sites-available/asksales', str(self.root / 'sites/asksales'))
        return subprocess.run(['bash', '-c', source, 'qa', str(self.root), 'fixture.yml', SHA, bundle or str(self.root/'bundle'), self.env.get('QA_PREBUILT', '0'), cutover_from],
                              env=self.env, capture_output=True, text=True, timeout=FIXTURE_TIMEOUT_SECONDS)

    def test_failed_migration_leaves_writers_stopped(self):
        self.env['QA_MIGRATE_FAIL'] = '1'
        result = self.release()
        self.assertEqual(result.returncode, 23, result.stderr)
        commands = (self.root / 'commands').read_text()
        self.assertIn(' stop api worker-1 worker-2', commands)
        self.assertNotIn(' start api worker-1 worker-2', commands)
        self.assertNotIn(' up -d ', commands)
        self.assertLess(commands.index(' stop api'), commands.index('pg_dump '))
        self.assertLess(commands.index('pg_dump '), commands.index('migrate.mjs up'))

    def test_backup_failure_never_migrates_or_restarts(self):
        self.env['QA_BACKUP_FAIL'] = '1'
        self.assertEqual(self.release().returncode, 24)
        commands = (self.root / 'commands').read_text()
        self.assertNotIn('migrate.mjs up', commands)
        self.assertNotIn(' up -d ', commands)

    def test_dirty_remote_is_preserved_before_fetch(self):
        self.env['QA_DIRTY'] = '1'
        self.assertNotEqual(self.release().returncode, 0)
        self.assertNotIn('git fetch', (self.root/'commands').read_text())

    def test_divergent_production_checkout_is_preserved(self):
        self.env['QA_DIVERGENT'] = '1'
        result = self.release()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('does not descend', result.stderr)
        self.assertNotIn('git switch', (self.root/'commands').read_text())

    def test_public_cutover_accepts_only_the_configured_private_revision(self):
        self.env.update(QA_DIVERGENT='1', QA_NEW_BRANCH='1')
        blocked = self.release(bundle='-', cutover_from='b' * 40)
        self.assertNotEqual(blocked.returncode, 0)
        self.assertIn('does not descend', blocked.stderr)
        result = self.release(bundle='-', cutover_from=SHA)
        self.assertEqual(result.returncode, 0, result.stderr)
        commands = (self.root/'commands').read_text()
        self.assertIn('git switch --no-track -c main FETCH_HEAD', commands)

    def test_initial_production_main_checkout_is_created_before_merge(self):
        self.env['QA_NEW_BRANCH'] = '1'
        result = self.release()
        self.assertEqual(result.returncode, 0, result.stderr)
        commands = (self.root/'commands').read_text()
        self.assertLess(commands.index('git switch --no-track -c main'), commands.index('git merge --ff-only'))

    def test_shared_lock_rejects_other_release_before_checkout(self):
        import fcntl
        with (self.root / 'release.lock').open('w') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assertNotEqual(self.release().returncode, 0)
        self.assertFalse((self.root / 'commands').exists())

    def test_verified_release_records_commit_and_image_manifest(self):
        result = self.release()
        self.assertEqual(result.returncode, 0, result.stderr)
        manifest = next((self.root/'backups').glob('*.manifest')).read_text()
        self.assertIn(f'release_sha={SHA}', manifest)
        self.assertIn('state=verified', manifest)
        self.assertIn('image_worker-1=sha256:synthetic', manifest)

    def test_unverified_sha_is_rejected_before_publication(self):
        result = subprocess.run(['bash', str(SCRIPT)], env=self.env, capture_output=True, text=True,
                                timeout=FIXTURE_TIMEOUT_SECONDS)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('RELEASE_VERIFIED_SHA', result.stderr)
        commands = (self.root/'commands').read_text()
        self.assertNotIn('git push', commands)
        self.assertNotIn('ssh ', commands)

    def test_prebuilt_release_verifies_images_and_never_builds(self):
        self.env['QA_PREBUILT'] = '1'
        result = self.release()
        self.assertEqual(result.returncode, 0, result.stderr)
        commands = (self.root / 'commands').read_text()
        self.assertNotIn(' build ', commands)
        self.assertIn(f'image tag asksales-security-worker:{SHA} salesmarketing-worker-2:latest', commands)
        self.assertLess(commands.index(f'asksales-security-client:{SHA}'), commands.index(' stop api'))

    def test_wrong_prebuilt_revision_never_stops_writers_or_migrates(self):
        self.env.update(QA_PREBUILT='1', QA_BAD_PREBUILT='1')
        result = self.release()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Prebuilt image revision mismatch', result.stderr)
        commands = (self.root / 'commands').read_text()
        self.assertNotIn(' stop api', commands)
        self.assertNotIn('migrate.mjs up', commands)
        self.assertNotIn(' up -d ', commands)

    def test_verified_non_production_branches_cannot_publish(self):
        for branch in ['v7', 'staging', 'v8', '']:
            with self.subTest(branch=branch):
                self.env.update(RELEASE_VERIFIED_SHA=SHA, QA_BRANCH=branch)
                result = subprocess.run(['bash', str(SCRIPT)], env=self.env,
                                        capture_output=True, text=True, timeout=FIXTURE_TIMEOUT_SECONDS)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('Production deployment requires the main branch', result.stderr)
                commands = (self.root / 'commands').read_text()
                self.assertNotIn('git push', commands)
                self.assertNotIn('git bundle', commands)
                self.assertNotIn('ssh ', commands)
                self.assertNotIn('scp ', commands)


if __name__ == '__main__':
    unittest.main()
