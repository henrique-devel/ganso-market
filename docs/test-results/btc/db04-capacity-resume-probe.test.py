#!/usr/bin/env python3
"""Ten offline checks for the passive capacity collector.

No probe main(), SSH, Docker or SQL is executed. The optional argument selects
the collector under test; default is the adjacent db04-capacity-resume-probe.py.
"""
import ast
import importlib.util
import pathlib
import sys
import time

sys.dont_write_bytecode = True
p = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else pathlib.Path(__file__).with_name('db04-capacity-resume-probe.py')
ast.parse(p.read_text())
spec = importlib.util.spec_from_file_location('probe', p)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
m.STARTED = time.monotonic()
checks = []


def check(name, condition):
    assert condition, name
    checks.append(name)


check('component_prefix', m.contains('/data/pg/base', '/data/pg') and not m.contains('/data/pg2', '/data/pg'))
mounts = m.parse_mountinfo('23 1 8:1 / / rw,relatime - ext4 /dev/sda1 rw\n24 23 8:2 / /data\\040pg rw - ext4 /dev/sdb1 rw\n')
check('mountinfo_escape', mounts[1]['mountpoint'] == '/data pg')
check('longest_mount', m.matching_mount('/data pg/base', mounts)['device'] == '8:2')
try:
    m.matching_mount('/x', [mounts[0], mounts[0]])
except RuntimeError:
    checks.append('ambiguous_mount_refused')
else:
    raise AssertionError('ambiguous_mount_refused')
check('memory_stat', m.numeric_lines('anon 123\nfile 456\ninactive_file 400\n') == {'anon': 123, 'file': 456, 'inactive_file': 400})
check('pss_rollup', m.numeric_lines('Pss_Anon: 123 kB\nPss_File: 4 kB\n'.replace(' kB', '').replace(':', ''))['Pss_Anon'] == 123)
for query in ['DELETE FROM x', 'SELECT 1; SELECT 2', 'VACUUM x', 'ANALYZE x', 'CREATE INDEX x ON t(a)']:
    try:
        m.sql_raw(query)
    except RuntimeError as error:
        assert str(error) == 'sql_not_allowlisted_read'
    else:
        raise AssertionError(query)
checks.append('non_read_or_multistatement_refused')
check('no_raw_inspect_or_env', 'Config.Env' not in p.read_text().replace('# Explicit allowlist: no Config.Env', '') and "'{{json .}}'" not in p.read_text())
check('cluster_snapshot_not_filtered_database', 'FROM pg_stat_activity WHERE datname' not in m.SNAPSHOT and "'client_backends'" in m.SNAPSHOT)
check('deadline_and_sample', m.SAMPLE_SECONDS == 30 and m.TOTAL_SECONDS == 115)
print('PASS', len(checks), 'offline checks:', ', '.join(checks))
print('lines', len(p.read_text().splitlines()))
print('remote execution: none')
