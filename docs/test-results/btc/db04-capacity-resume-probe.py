#!/usr/bin/env python3
"""DB-04 passive capacity probe; run once via pinned SSH, stdin, timeout 120s.

No writes, tuning, signals, relation scans, EXPLAIN/ANALYZE, or secret output.
Two snapshots separated by 30 seconds; internal total deadline 115 seconds.
Every SQL command uses read-only/statement_timeout=2s/lock_timeout=500ms.
Exit 1 preserves partial JSON and means incomplete collection, never acceptance.
"""
import datetime
import json
import os
import pathlib
import re
import signal
import subprocess
import sys
import time

ROOT = pathlib.Path('/opt/ganso-market')
SAMPLE_SECONDS = 30
TOTAL_SECONDS = 115
DC = ['docker', 'compose', '--env-file', 'deploy/server.env',
      '--profile', 'polymarket', '--profile', 'model']
STARTED = None
PG = None


def utc():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def remaining():
    left = TOTAL_SECONDS - (time.monotonic() - STARTED)
    if left <= 0:
        raise RuntimeError('global_deadline')
    return left


def deadline(_signum, _frame):
    raise RuntimeError('global_deadline')


def run(args, timeout=8):
    """Only caller-approved argv; never echo command stderr or environment."""
    result = subprocess.run(args, capture_output=True, text=True,
                            timeout=min(timeout, remaining()))
    if result.returncode:
        raise RuntimeError('command_failed:' + args[0] + ':exit=' + str(result.returncode))
    return result.stdout.strip()


def read(path, limit=262144):
    remaining()
    with open(path) as stream:
        data = stream.read(limit + 1)
    if len(data) > limit:
        raise RuntimeError('file_limit:' + pathlib.Path(path).name)
    return data


def numeric_lines(value):
    return {line.split()[0]: int(line.split()[1])
            for line in value.splitlines() if len(line.split()) == 2}


def sql_raw(query):
    if ';' in query or not re.match(r'^(SELECT|SHOW)\b', query.strip()):
        raise RuntimeError('sql_not_allowlisted_read')
    return run(['docker', 'exec',
                '-e', 'PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=2000 -c lock_timeout=500',
                '-e', 'PGAPPNAME=db04-capacity-passive', PG, 'psql', '-XAt',
                '-v', 'ON_ERROR_STOP=1', '-U', 'ganso_market', '-d', 'ganso_market',
                '-c', query], timeout=6)


def sql(query):
    return json.loads(sql_raw(query))


def inspect(cid):
    # Explicit allowlist: no Config.Env, command line, credentials or full inspect.
    fields = {
        'id': '.Id', 'name': '.Name',
        'service': '(index .Config.Labels "com.docker.compose.service")',
        'project': '(index .Config.Labels "com.docker.compose.project")',
        'image_id': '.Image', 'running': '.State.Running', 'pid': '.State.Pid',
        'started_at': '.State.StartedAt', 'oom_killed': '.State.OOMKilled',
        'restart_count': '.RestartCount', 'memory_limit_bytes': '.HostConfig.Memory',
        'memory_swap_bytes': '.HostConfig.MemorySwap', 'nano_cpus': '.HostConfig.NanoCpus',
        'cpu_quota': '.HostConfig.CpuQuota', 'cpu_period': '.HostConfig.CpuPeriod',
        'cpuset_cpus': '.HostConfig.CpusetCpus', 'mounts': '.Mounts',
    }
    template = '{' + ','.join(json.dumps(k) + ':{{json ' + v + '}}'
                              for k, v in fields.items()) + '}'
    value = json.loads(run(['docker', 'inspect', '--format', template, cid]))
    if not value['running'] or value['pid'] <= 0 or value['id'] != cid:
        raise RuntimeError('container_not_running_or_identity_changed')
    release = run(['docker', 'exec', cid, 'sh', '-c',
                   'if [ -f /etc/ganso/release-sha ]; then cat /etc/ganso/release-sha; fi'])
    if release and not re.fullmatch(r'[a-f0-9]{40}', release):
        raise RuntimeError('invalid_release_sha')
    value['release_sha'] = release or None
    return value


def cgroup_path(container):
    rows = [line.split(':', 2) for line in
            read('/proc/' + str(container['pid']) + '/cgroup').splitlines()]
    unified = [p for _hierarchy, controllers, p in rows if controllers == '']
    if len(unified) != 1 or '..' in pathlib.PurePosixPath(unified[0]).parts:
        raise RuntimeError('cgroup_v2_coverage_ambiguous')
    result = pathlib.Path('/sys/fs/cgroup') / unified[0].lstrip('/')
    if not result.is_dir():
        raise RuntimeError('cgroup_missing')
    return result


def cgroup_snapshot(container, include_pss=False):
    started = utc()
    root = cgroup_path(container)
    result = {'start_utc': started, 'path': str(root)}
    for filename in ['cpu.stat', 'memory.stat', 'memory.events', 'memory.events.local']:
        try:
            result[filename] = numeric_lines(read(root / filename))
        except FileNotFoundError:
            if filename != 'memory.events.local':
                raise
            result[filename] = None
    for filename in ['memory.current', 'memory.max', 'pids.current', 'cpu.max', 'io.stat']:
        value = read(root / filename).strip()
        result[filename] = int(value) if value.isdigit() else value
    # Count the complete bounded subtree; no hidden omission of nested cgroups.
    procs = set()
    groups = 0
    for directory, _children, _files in os.walk(root):
        remaining()
        groups += 1
        if groups > 64:
            raise RuntimeError('cgroup_subtree_limit')
        procs.update(int(p) for p in read(pathlib.Path(directory) / 'cgroup.procs').split())
    if not include_pss:
        result['anonymous_pss'] = {'complete': False, 'reason': 'only_postgres_pss_requested'}
    elif len(procs) > 128:
        result['anonymous_pss'] = {'complete': False, 'reason': 'process_limit_128',
                                   'processes_seen': len(procs)}
    else:
        samples = []
        errors = []
        pss_started = time.monotonic()
        for pid in sorted(procs):
            if time.monotonic() - pss_started > 3:
                errors.append({'reason': 'pss_budget_3s'})
                break
            try:
                rows = numeric_lines(read('/proc/' + str(pid) + '/smaps_rollup')
                                     .replace(' kB', '').replace(':', ''))
                samples.append({'pid': pid, 'pss_kib': rows.get('Pss'),
                                'pss_anon_kib': rows.get('Pss_Anon'),
                                'pss_file_kib': rows.get('Pss_File'),
                                'pss_shmem_kib': rows.get('Pss_Shmem')})
            except (FileNotFoundError, ProcessLookupError, PermissionError):
                errors.append({'pid': pid, 'reason': 'process_exited_or_unreadable'})
        complete = not errors and len(samples) == len(procs) and all(
            s['pss_anon_kib'] is not None for s in samples)
        result['anonymous_pss'] = {
            'complete': complete, 'processes_seen': len(procs), 'samples': samples,
            'errors': errors, 'elapsed_seconds': time.monotonic() - pss_started,
            'sum_anon_kib': sum(s['pss_anon_kib'] for s in samples) if complete else None,
            'method': 'smaps_rollup, bounded 128 processes/3s; sequential, not atomic',
        }
    result['cgroup_process_count'] = len(procs)
    result['end_utc'] = utc()
    return result


def mount_unescape(value):
    return re.sub(r'\\([0-7]{3})', lambda m: chr(int(m.group(1), 8)), value)


def parse_mountinfo(value):
    output = []
    for line in value.splitlines():
        front, back = line.split(' - ', 1)
        parts, rest = front.split(), back.split()
        output.append({'id': int(parts[0]), 'parent_id': int(parts[1]),
                       'device': parts[2], 'root': mount_unescape(parts[3]),
                       'mountpoint': mount_unescape(parts[4]), 'options': parts[5],
                       'fstype': rest[0], 'source': mount_unescape(rest[1])})
    return output


def contains(path, prefix):
    path = pathlib.PurePosixPath(path)
    prefix = pathlib.PurePosixPath(prefix)
    return path == prefix or prefix in path.parents


def matching_mount(path, mounts):
    eligible = [m for m in mounts if contains(path, m['mountpoint'])]
    if not eligible:
        raise RuntimeError('filesystem_mount_not_found')
    length = max(len(m['mountpoint']) for m in eligible)
    selected = [m for m in eligible if len(m['mountpoint']) == length]
    if len(selected) != 1:
        raise RuntimeError('filesystem_mount_ambiguous')
    return selected[0]


def host_filesystem(path, mounts):
    real = os.path.realpath(path)
    stat = os.stat(real)
    fs = os.statvfs(real)
    mount = matching_mount(real, mounts)
    device = str(os.major(stat.st_dev)) + ':' + str(os.minor(stat.st_dev))
    if device != mount['device']:
        raise RuntimeError('filesystem_device_mismatch')
    total = fs.f_blocks * fs.f_frsize
    available = fs.f_bavail * fs.f_frsize
    return {'path': path, 'realpath': real, 'device': device, 'mount': mount,
            'total_bytes': total, 'available_bytes': available,
            'free_bytes_including_root_reserve': fs.f_bfree * fs.f_frsize,
            'available_percent': 100 * available / total if total else None,
            'floor_25_percent_passed': available * 4 >= total if total else False,
            'df_posix': run(['df', '-P', '-k', '--', real])}


def storage(container, datadir, tablespaces):
    host_mounts = parse_mountinfo(read('/proc/self/mountinfo'))
    namespace_mounts = parse_mountinfo(read('/proc/' + str(container['pid']) + '/mountinfo'))
    checkout = host_filesystem(str(ROOT), host_mounts)
    targets = [('data_directory', datadir), ('pg_wal', datadir.rstrip('/') + '/pg_wal')]
    for row in tablespaces:
        if row['location']:
            path = row['location']
        elif row['spcname'] == 'pg_default':
            path = datadir.rstrip('/') + '/base'
        elif row['spcname'] == 'pg_global':
            path = datadir.rstrip('/') + '/global'
        else:
            raise RuntimeError('empty_custom_tablespace_location')
        targets.append(('tablespace:' + str(row['oid']) + ':' + row['spcname'], path))
    mappings = []
    for kind, path in targets:
        if not path.startswith('/'):
            raise RuntimeError('non_absolute_pg_storage')
        resolved = run(['docker', 'exec', container['id'], 'readlink', '-f', '--', path])
        eligible = [m for m in container['mounts'] if contains(resolved, m['Destination'])]
        if not eligible:
            raise RuntimeError('pg_storage_not_backed_by_explicit_docker_mount')
        length = max(len(m['Destination']) for m in eligible)
        exact = [m for m in eligible if len(m['Destination']) == length]
        if len(exact) != 1 or exact[0]['Type'] not in ('bind', 'volume'):
            raise RuntimeError('pg_storage_docker_mapping_ambiguous')
        docker_mount = exact[0]
        relative = pathlib.PurePosixPath(resolved).relative_to(docker_mount['Destination'])
        host_path = str(pathlib.Path(docker_mount['Source']) / str(relative))
        host = host_filesystem(host_path, host_mounts)
        inside_mount = matching_mount(resolved, namespace_mounts)
        if host['device'] != inside_mount['device']:
            raise RuntimeError('docker_namespace_host_device_mismatch')
        host_internal = str(pathlib.PurePosixPath(host['mount']['root']) /
                            pathlib.PurePosixPath(host['realpath']).relative_to(host['mount']['mountpoint']))
        container_internal = str(pathlib.PurePosixPath(inside_mount['root']) /
                                 pathlib.PurePosixPath(resolved).relative_to(inside_mount['mountpoint']))
        if host_internal != container_internal:
            raise RuntimeError('docker_namespace_host_mount_root_mismatch')
        mappings.append({'kind': kind, 'container_path': path,
                         'container_realpath': resolved,
                         'is_symlink_or_parent_symlink': path != resolved,
                         'docker_mount': docker_mount, 'container_mount': inside_mount,
                         'verified_filesystem_internal_path': host_internal,
                         'host_filesystem': host,
                         'same_device_as_checkout': host['device'] == checkout['device']})
    return {'utc': utc(), 'coverage_complete': True, 'checkout': checkout, 'targets': mappings,
            'note': 'Space is reported per actual filesystem; repeated devices are not summed.'}


SETTINGS = """SELECT json_agg(row_to_json(s)) FROM (
 SELECT name,setting,unit,source,context,pending_restart FROM pg_settings WHERE name = ANY(ARRAY[
 'max_connections','superuser_reserved_connections','reserved_connections','shared_buffers',
 'work_mem','hash_mem_multiplier','maintenance_work_mem','autovacuum_work_mem',
 'autovacuum_max_workers','autovacuum_worker_slots','max_worker_processes',
 'max_parallel_workers','max_parallel_workers_per_gather','max_parallel_maintenance_workers',
 'effective_cache_size','wal_buffers','shared_memory_size','track_io_timing',
 'track_wal_io_timing','max_wal_size','min_wal_size','wal_keep_size','max_slot_wal_keep_size',
 'checkpoint_timeout','checkpoint_completion_target','temp_file_limit','fsync',
 'full_page_writes','synchronous_commit','statement_timeout','lock_timeout']) ORDER BY name)s"""

SNAPSHOT = """SELECT json_build_object(
 'utc',clock_timestamp(),
 'scope','cluster-wide pg_stat_activity, pg_locks, pg_stat_database and WAL',
 'observer_pid',pg_backend_pid(),
 'client_backends',(SELECT count(*) FROM pg_stat_activity WHERE backend_type='client backend'),
 'activity',(SELECT COALESCE(json_agg(row_to_json(a)),'[]'::json) FROM (
   SELECT pid,datname,usename,backend_type,application_name,state,wait_event_type,wait_event,
     extract(epoch FROM clock_timestamp()-backend_start) backend_age_s,
     extract(epoch FROM clock_timestamp()-xact_start) transaction_age_s,
     CASE WHEN state='active' THEN extract(epoch FROM clock_timestamp()-query_start) END active_query_age_s
   FROM pg_stat_activity ORDER BY pid)a),
 'locks',(SELECT COALESCE(json_agg(row_to_json(l)),'[]'::json) FROM (
   SELECT locktype,mode,granted,count(*) n FROM pg_locks GROUP BY 1,2,3 ORDER BY 1,2,3)l),
 'waiting_locks',(SELECT COALESCE(json_agg(row_to_json(l)),'[]'::json) FROM (
   SELECT pid,locktype,mode,database,relation,waitstart FROM pg_locks WHERE NOT granted)l),
 'databases',(SELECT COALESCE(json_agg(row_to_json(d)),'[]'::json) FROM (
   SELECT datid,datname,numbackends,xact_commit,xact_rollback,blks_read,blks_hit,temp_files,
     temp_bytes,deadlocks,blk_read_time,blk_write_time,sessions,sessions_abandoned,
     sessions_fatal,sessions_killed,stats_reset FROM pg_stat_database ORDER BY datid)d),
 'wal',(SELECT row_to_json(w) FROM pg_stat_wal w),
 'checkpointer',(SELECT row_to_json(c) FROM pg_stat_checkpointer c),
 'bgwriter',(SELECT row_to_json(b) FROM pg_stat_bgwriter b),
 'table_counters',(SELECT COALESCE(json_agg(row_to_json(t)),'[]'::json) FROM (
   SELECT relid,schemaname,relname,n_tup_ins,n_tup_upd,n_tup_del,n_live_tup,n_dead_tup,
     last_autovacuum,last_autoanalyze,autovacuum_count,autoanalyze_count
   FROM pg_stat_user_tables WHERE schemaname='public' AND relname IN
     ('polymarket_rtds_prices','polymarket_rtds_1m','polymarket_trades',
      'polymarket_book_snapshots','polymarket_book_deltas') ORDER BY relname)t),
 'builds',(SELECT COALESCE(json_agg(row_to_json(p)),'[]'::json) FROM (
   SELECT pid,datid,datname,relid,index_relid,command,phase FROM pg_stat_progress_create_index)p),
 'replication_slots',(SELECT COALESCE(json_agg(row_to_json(s)),'[]'::json) FROM (
   SELECT slot_type,database,active,restart_lsn,wal_status,safe_wal_size FROM pg_replication_slots)s)
)"""


def snapshot(pg, recorder, containers):
    result = {'start_utc': utc()}
    result['host'] = {'cpu_stat_ticks': read('/proc/stat').splitlines()[0],
                      'meminfo': {line.split(':')[0]: line.split(':')[1].strip()
                                  for line in read('/proc/meminfo').splitlines()
                                  if line.startswith(('MemTotal:', 'MemAvailable:', 'SwapTotal:', 'SwapFree:'))},
                      'pressure': {name: read('/proc/pressure/' + name).strip()
                                   for name in ['cpu', 'memory', 'io']}}
    groups = {c['service']: cgroup_snapshot(c, include_pss=c['id'] == pg['id'])
              for c in containers}
    result.update({'postgres': groups['postgres'], 'recorder': groups['polymarket-recorder'],
                   'other_service_cgroups': {name: value for name, value in groups.items()
                                            if name not in ('postgres', 'polymarket-recorder')},
                   'postgresql': sql(SNAPSHOT)})
    data = result['postgresql']
    clients = [a for a in data['activity'] if a['backend_type'] == 'client backend']
    if len(clients) != data['client_backends'] or any(a['state'] is None for a in clients):
        raise RuntimeError('cluster_client_visibility_ambiguous')
    if not any(a['pid'] == data['observer_pid'] and
               a['application_name'] == 'db04-capacity-passive' for a in clients):
        raise RuntimeError('observer_identity_not_visible')
    result['end_utc'] = utc()
    return result


def main():
    global STARTED, PG
    STARTED = time.monotonic()
    signal.signal(signal.SIGALRM, deadline)
    signal.alarm(TOTAL_SECONDS)
    output = {'schema_version': 1, 'start_utc': utc(), 'complete': False,
              'protocol': {'sample_separation_seconds': SAMPLE_SECONDS,
                           'internal_deadline_seconds': TOTAL_SECONDS,
                           'required_external_timeout_seconds': 120,
                           'sql_statement_timeout_ms': 2000, 'sql_lock_timeout_ms': 500,
                           'read_only': True, 'retries': 0},
              'limitations': ['Passive 30-second pair is not peak capacity, SQL latency, integrated load or soak.',
                              'Global WAL includes all current workloads; it is not marginal candidate WAL.',
                              'Anonymous PSS and cgroup cache measurements are not an acceptance of memory headroom.',
                              'No raw queries, logs, environment, data rows or secrets are collected.',
                              'Collection commands add small CPU/connection overhead; all samples are sequential.']}
    code = 1
    try:
        os.chdir(ROOT)
        output['host'] = {'hostname': run(['hostname']), 'kernel': run(['uname', '-sr']),
                          'cpus': os.cpu_count(), 'docker_version': run(['docker', 'version', '--format', '{{.Server.Version}}']),
                          'compose_version': run(['docker', 'compose', 'version', '--short']),
                          'meminfo': {line.split(':')[0]: line.split(':')[1].strip()
                                      for line in read('/proc/meminfo').splitlines()
                                      if line.startswith(('MemTotal:', 'MemAvailable:', 'SwapTotal:', 'SwapFree:'))}}
        if output['host']['hostname'] != 'ubuntu-16gb-fsn1-2-bot':
            raise RuntimeError('unexpected_hostname')
        ids = run(DC + ['ps', '--quiet']).splitlines()
        if not ids or len(ids) > 20 or len(ids) != len(set(ids)):
            raise RuntimeError('compose_container_coverage_ambiguous')
        containers = [inspect(cid) for cid in ids]
        output['containers'] = containers
        services = [c['service'] for c in containers]
        if len(services) != len(set(services)) or services.count('postgres') != 1 or services.count('polymarket-recorder') != 1:
            raise RuntimeError('compose_service_coverage_ambiguous')
        pg = next(c for c in containers if c['service'] == 'postgres')
        recorder = next(c for c in containers if c['service'] == 'polymarket-recorder')
        PG = pg['id']
        identity = sql("""SELECT json_build_object('utc',clock_timestamp(),'database',current_database(),
          'user',current_user,'version',version(),'server_version_num',current_setting('server_version_num'),
          'read_only',current_setting('default_transaction_read_only'),
          'statement_timeout',current_setting('statement_timeout'),'lock_timeout',current_setting('lock_timeout'),
          'superuser',(SELECT rolsuper FROM pg_roles WHERE rolname=current_user),
          'read_all_stats',pg_has_role(current_user,'pg_read_all_stats','MEMBER'))""")
        output['postgresql_identity'] = identity
        if not (identity['superuser'] or identity['read_all_stats']):
            raise RuntimeError('cluster_activity_full_visibility_not_proven')
        if identity['read_only'] != 'on' or identity['statement_timeout'] != '2s' or identity['lock_timeout'] != '500ms':
            raise RuntimeError('observer_session_guard_mismatch')
        output['settings'] = sql(SETTINGS)
        output['retention_catalog'] = sql("""SELECT json_build_object(
          'utc',clock_timestamp(),
          'policy_function',(SELECT row_to_json(p) FROM (
            SELECT p.oid,n.nspname,p.proname,p.provolatile,p.proparallel,l.lanname,
              trim(p.prosrc)='SELECT ''data-02-v1''::text' definition_matches_0023,
              md5(p.prosrc) definition_md5
            FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
            JOIN pg_language l ON l.oid=p.prolang
            WHERE n.nspname='public' AND p.proname='retention_evidence_policy_version'
              AND p.pronargs=0)p),
          'triggers',(SELECT COALESCE(json_agg(row_to_json(t)),'[]'::json) FROM (
            SELECT n.nspname,c.relname,t.tgname,t.tgenabled,p.proname
            FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
            JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_proc p ON p.oid=t.tgfoid
            WHERE n.nspname='public' AND c.relname IN
              ('polymarket_rtds_prices','polymarket_rtds_1m','polymarket_trades')
              AND NOT t.tgisinternal ORDER BY c.relname,t.tgname)t))""")
        policy = output['retention_catalog']['policy_function']
        # Invoke only the exact immutable constant function from migration 0023.
        if (policy and policy['lanname'] == 'sql' and policy['provolatile'] == 'i'
                and policy['definition_matches_0023']):
            output['retention_catalog']['policy_version'] = sql(
                "SELECT to_json(public.retention_evidence_policy_version())")
        else:
            output['retention_catalog']['policy_version'] = None
            output['retention_catalog']['policy_unavailable_reason'] = 'function_absent_or_not_exact_constant_0023'
        datadir = sql_raw('SHOW data_directory')
        tablespaces = sql("SELECT json_agg(row_to_json(t)) FROM (SELECT oid,spcname,pg_tablespace_location(oid) location FROM pg_tablespace ORDER BY oid)t")
        output['storage'] = storage(pg, datadir, tablespaces)
        release = read(ROOT / 'deploy/release-sha').strip()
        if not re.fullmatch(r'[a-f0-9]{40}', release):
            raise RuntimeError('checkout_release_invalid')
        output['checkout_release_sha'] = release
        output['configured_pool_reference'] = {
            'source': 'DB-04 audited application source; pool maxima are not PostgreSQL session GUCs or live pool occupancy',
            'api': 4, 'polymarket-recorder': 10, 'polymarket-estimator': 4,
            'polymarket-resolution': 4, 'polymarket-portfolio': 4, 'polymarket-paper': 2,
            'persistent_maximum_sum': 28, 'operational_client_ceiling_cluster_including_observer': 32,
            'live_maxima_verified': False,
        }
        output['a'] = snapshot(pg, recorder, containers)
        if remaining() < SAMPLE_SECONDS + 10:
            raise RuntimeError('insufficient_budget_for_sample_pair')
        output['sleep_start_utc'] = utc()
        time.sleep(SAMPLE_SECONDS)
        output['sleep_end_utc'] = utc()
        output['b'] = snapshot(pg, recorder, containers)
        # Reconcile both container/process identity and Compose coverage at end.
        final_ids = run(DC + ['ps', '--quiet']).splitlines()
        if sorted(final_ids) != sorted(ids):
            raise RuntimeError('compose_container_set_changed')
        output['identity_after'] = []
        for before in containers:
            after = inspect(before['id'])
            output['identity_after'].append({k: after[k] for k in
                                            ('id', 'service', 'pid', 'started_at', 'restart_count', 'release_sha')})
            if any(before[k] != after[k] for k in ('pid', 'started_at', 'restart_count', 'release_sha')):
                raise RuntimeError('container_restarted_or_release_changed')
        output['complete'] = True
        code = 0
    except Exception as error:
        # Only class and our fixed reason; raw subprocess stderr is never exposed.
        output['error'] = {'type': type(error).__name__,
                           'reason': str(error) if isinstance(error, RuntimeError) else 'probe_failed_no_raw_error_output'}
    finally:
        signal.alarm(0)
        output['end_utc'] = utc()
        output['elapsed_seconds'] = time.monotonic() - STARTED
        output['exit_code'] = code
        print(json.dumps(output, indent=2))
    return code


if __name__ == '__main__':
    sys.exit(main())
