"""Real Docker ignore matching using a scratch-only, synthetic, network-disabled build."""
from pathlib import Path
import os
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(os.environ.get('ASKSALES_BUILD_CONTEXT_ROOT', Path(__file__).resolve().parents[2]))


@unittest.skipUnless(shutil.which('docker'), 'Docker CLI is unavailable; context integration unrun')
class BuildSecretExclusionTests(unittest.TestCase):
    def test_nested_private_files_are_absent_but_allowed_source_remains(self):
        with tempfile.TemporaryDirectory(prefix='asksales-context-test-') as directory:
            work = Path(directory)
            context = work / 'context'
            (context / 'server').mkdir(parents=True)
            (context / 'client').mkdir()
            (context / '.dockerignore').write_text((ROOT / '.dockerignore').read_text())
            (context / 'Dockerfile').write_text('FROM scratch\nCOPY . /\n')
            forbidden = ['.env', 'server/.env', 'server/.env.development', 'client/.env.local',
                         'server/fixture.key', 'client/fixture.pem',
                         'server/data/service-accounts/fixture.json', 'server/config/google-service-account.json',
                         'server/config/provider-credentials.json']
            for name in forbidden:
                (context / name).parent.mkdir(parents=True, exist_ok=True)
                (context / name).write_text('SYNTHETIC_SECRET_SENTINEL')
            (context / 'server/allowed.js').write_text('synthetic source')
            output = work / 'output'
            environment = dict(os.environ, DOCKER_CONFIG=str(work / 'docker-config'))
            result = subprocess.run(['docker', 'buildx', 'build', '--network=none', '--progress=plain',
                                     '--output', f'type=local,dest={output}', str(context)],
                                    env=environment, capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue((output / 'server/allowed.js').is_file())
            for name in forbidden:
                self.assertFalse((output / name).exists(), name)


if __name__ == '__main__':
    unittest.main()
