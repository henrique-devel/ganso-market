"""DATA-01 passive inventory. Run via SSH stdin; no remote files/writes.

Catalog/stats only, plus bounded primary-key endpoint/audit reads. Each SQL
statement has read-only mode, 2s timeout, 500ms lock timeout and no parallelism.
Output deliberately excludes secrets, configuration values and row payloads.
"""
import datetime
import glob
import json
import os
import pathlib
import subprocess
import time


def utc():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def run(args, timeout=15):
    p = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    if p.returncode:
        raise RuntimeError(f"{args[0]} exit {p.returncode}")
    return p.stdout.strip()


os.chdir('/opt/ganso-market')
start = utc()
containers = []
for cid in run(['docker', 'ps', '-aq', '--filter', 'label=com.docker.compose.project=ganso-market']).splitlines():
    o = json.loads(run(['docker', 'inspect', '--format', '{{json .}}', cid]))
    logs = []
    for path in sorted(glob.glob(o.get('LogPath', '') + '*')) if o.get('LogPath') else []:
        s = os.stat(path)
        logs.append({'path': path, 'bytes': s.st_size, 'allocated_bytes': s.st_blocks * 512,
                     'mtime_utc': datetime.datetime.fromtimestamp(s.st_mtime, datetime.timezone.utc).isoformat()})
    release = ''
    if o['State']['Running']:
        release = run(['docker', 'exec', cid, 'sh', '-c',
                       'if [ -f /etc/ganso/release-sha ]; then cat /etc/ganso/release-sha; fi'])
    containers.append({'id': cid, 'service': o['Config']['Labels'].get('com.docker.compose.service'),
                       'image_id': o['Image'], 'created': o['Created'], 'status': o['State']['Status'],
                       'release': release, 'logging': o['HostConfig']['LogConfig'], 'logs': logs,
                       'mounts': [{'type': m['Type'], 'source': m['Source'], 'destination': m['Destination']}
                                  for m in o['Mounts'] if '/secrets' not in m['Destination']]})
pg = next(c['id'] for c in containers if c['service'] == 'postgres')
queries = []


def sql(label, q):
    t = time.monotonic()
    args = ['docker', 'exec', '-e',
            'PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=2000 -c lock_timeout=500 -c max_parallel_workers_per_gather=0 -c application_name=data01-observer',
            pg, 'psql', '-XAt', '-v', 'ON_ERROR_STOP=1', '-U', 'ganso_market', '-d', 'ganso_market', '-c', q]
    p = subprocess.run(args, capture_output=True, text=True, timeout=10)
    queries.append({'label': label, 'utc': utc(), 'elapsed_s': time.monotonic() - t,
                    'exit': p.returncode, 'sql': q,
                    'error': p.stderr.strip() if p.returncode else None})
    return json.loads(p.stdout) if p.returncode == 0 else None


def rows(label, q):
    return sql(label, "SELECT COALESCE(json_agg(row_to_json(x)), '[]'::json) FROM (" + q + ') x')


def snap(label):
    fs = os.statvfs('/opt/ganso-market')
    return {'utc': utc(), 'disk': {'total_bytes': fs.f_blocks * fs.f_frsize,
                                  'available_bytes': fs.f_bavail * fs.f_frsize},
            'cpu': run(['docker', 'exec', pg, 'cat', '/sys/fs/cgroup/cpu.stat']),
            'memory_current': int(run(['docker', 'exec', pg, 'cat', '/sys/fs/cgroup/memory.current'])),
            'memory_events': run(['docker', 'exec', pg, 'cat', '/sys/fs/cgroup/memory.events']),
            'db': rows(label + '_db', "SELECT clock_timestamp() utc, pg_database_size(oid) bytes, stats_reset, temp_bytes, xact_commit FROM pg_stat_database JOIN pg_database ON datname=pg_database.datname WHERE pg_database.datname=current_database()".replace('ON datname=', 'ON pg_stat_database.datname=')),
            'tables': rows(label + '_tables', "SELECT clock_timestamp() utc,s.relname,pg_total_relation_size(s.relid) total_bytes,n_live_tup,n_dead_tup,n_tup_ins,n_tup_upd,n_tup_del,last_vacuum,last_autovacuum,last_analyze,last_autoanalyze FROM pg_stat_user_tables s ORDER BY s.relname")}


a = snap('a')
catalog = rows('catalog', """SELECT c.relname,c.reltuples,c.relpages,
 pg_relation_size(c.oid) heap_bytes,pg_table_size(c.oid) table_bytes,
 pg_indexes_size(c.oid) indexes_bytes,pg_total_relation_size(c.oid) total_bytes,
 CASE WHEN c.reltoastrelid=0 THEN 0 ELSE pg_total_relation_size(c.reltoastrelid) END toast_total_bytes,
 s.n_live_tup,s.n_dead_tup,ts.n_live_tup toast_live_tup,
 w.heap_width,ix.index_count,ix.index_key_width,
 s.seq_scan,s.idx_scan,s.last_seq_scan,s.last_idx_scan,s.n_mod_since_analyze
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 LEFT JOIN pg_stat_all_tables s ON s.relid=c.oid
 LEFT JOIN pg_stat_all_tables ts ON ts.relid=c.reltoastrelid
 LEFT JOIN LATERAL (SELECT sum(avg_width)::float8 heap_width FROM pg_stats
 WHERE schemaname=n.nspname AND tablename=c.relname) w ON true
 LEFT JOIN LATERAL (SELECT count(DISTINCT i.indexrelid)::float8 index_count,
 COALESCE(sum(st.avg_width),0)::float8 index_key_width FROM pg_index i
 CROSS JOIN LATERAL unnest(i.indkey::int2[]) k(attnum)
 LEFT JOIN pg_attribute aa ON aa.attrelid=c.oid AND aa.attnum=k.attnum
 LEFT JOIN pg_stats st ON st.schemaname=n.nspname AND st.tablename=c.relname AND st.attname=aa.attname
 WHERE i.indrelid=c.oid AND i.indisvalid) ix ON true
 WHERE n.nspname='public' AND c.relkind='r' ORDER BY total_bytes DESC""")
indexes = rows('indexes', "SELECT t.relname table_name,c.relname index_name,i.indisprimary,i.indisvalid,i.indisready,pg_relation_size(c.oid) bytes,pg_get_indexdef(c.oid) definition FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_class t ON t.oid=i.indrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public' ORDER BY t.relname,c.relname")
fks = rows('fks', "SELECT conrelid::regclass::text table_name,conname,confrelid::regclass::text referenced_table,pg_get_constraintdef(oid) definition,convalidated FROM pg_constraint WHERE contype='f' AND connamespace='public'::regnamespace ORDER BY 1,2")
triggers = rows('triggers', "SELECT tgrelid::regclass::text table_name,tgname,tgenabled,pg_get_triggerdef(oid) definition FROM pg_trigger WHERE NOT tgisinternal AND tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace='public'::regnamespace) ORDER BY 1,2")
ages = rows('timestamp_histograms', "SELECT st.tablename,st.attname,st.null_frac,st.n_distinct,st.histogram_bounds::text histogram_bounds FROM pg_stats st JOIN pg_class c ON c.relname=st.tablename AND c.relnamespace='public'::regnamespace JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname=st.attname WHERE st.schemaname='public' AND a.atttypid IN ('timestamptz'::regtype,'timestamp'::regtype) ORDER BY st.tablename,st.attname")
retention = rows('retention_latest_200', 'SELECT retention_log_id,table_name,cause,pruned_before,rows_deleted,at FROM polymarket_retention_log ORDER BY retention_log_id DESC LIMIT 200')
schema = rows('schema', 'SELECT component,version,checksum_sha256 FROM schema_versions ORDER BY component,version')
settings = rows('settings', "SELECT name,setting,unit FROM pg_settings WHERE name IN ('default_transaction_read_only','statement_timeout','lock_timeout','max_parallel_workers_per_gather','server_version','max_connections','max_wal_size','min_wal_size')")
endpoints = {}
for table, pk, ts in [
    ('polymarket_book_deltas','delta_id','received_at'),
    ('polymarket_book_snapshots_full','snapshot_id','received_at'),
    ('polymarket_book_snapshots','snapshot_id','received_at'),
    ('polymarket_trades','trade_id','received_at'),
    ('polymarket_rtds_prices','rtds_price_id','received_at'),
    ('paper_ledger_events','event_id','received_at'),
    ('domain_events','event_id','received_at')]:
    # Only execute if a verified single-column primary-key index exists.
    if any(i['table_name'] == table and i['indisprimary'] and
           i['definition'].endswith('(' + pk + ')') for i in indexes or []):
        endpoints[table] = {}
        for direction in ['ASC','DESC']:
            endpoints[table][direction] = rows('endpoint_' + table + '_' + direction,
                f'SELECT {pk} id,{ts} ts FROM public.{table} ORDER BY {pk} {direction} LIMIT 1')
    else:
        endpoints[table] = {'unavailable': 'single-column PK not verified'}
time.sleep(30)
b = snap('b')
images = []
for iid in dict.fromkeys(run(['docker','image','ls','-aq','--no-trunc']).splitlines()):
    o = json.loads(run(['docker','image','inspect','--format','{{json .}}',iid]))
    images.append({'id':o['Id'],'tags':o.get('RepoTags',[]),'created':o['Created'],'bytes':o['Size'],
                   'used_by':[c['service'] for c in containers if c['image_id']==o['Id']]})
artifacts = []
checked_roots = ['/opt/ganso-market/deploy','/opt/ganso-market/exports','/opt/ganso-market/backups',
                 '/opt/ganso-market/artifacts','/opt/ganso-market/logs','/home/ganso/ganso-bot','/home/ganso/ganso-market']
for root in checked_roots:
    p = pathlib.Path(root)
    if not p.exists():
        artifacts.append({'path':root,'exists':False})
        continue
    artifacts.append({'path':root,'exists':True})
    for f in sorted(p.iterdir())[:200]:
        if f.is_file() and f.suffix.lower() in ('.tar','.gz','.zst','.zip','.sql','.dump','.parquet','.csv','.jsonl','.bak'):
            s=f.stat()
            artifacts.append({'path':str(f),'bytes':s.st_size,'allocated_bytes':s.st_blocks*512,
                              'mtime_utc':datetime.datetime.fromtimestamp(s.st_mtime,datetime.timezone.utc).isoformat()})
print(json.dumps({'start_utc':start,'end_utc':utc(),'checkout_release':pathlib.Path('deploy/release-sha').read_text().strip(),
                  'containers':containers,'a':a,'b':b,'catalog':catalog,'indexes':indexes,'fks':fks,'triggers':triggers,
                  'ages':ages,'retention_latest_200':retention,'schema':schema,'settings':settings,'endpoints':endpoints,
                  'images':images,'artifacts':artifacts,'artifact_scope':'root existence + first 200 immediate files per listed root; no recursive/global scan',
                  'journal_usage':run(['journalctl','--disk-usage']), 'queries':queries},indent=2))
