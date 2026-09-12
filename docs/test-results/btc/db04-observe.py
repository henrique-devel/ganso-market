import subprocess,json,os,time,datetime,pathlib,collections,re
os.chdir('/opt/ganso-market')
def run(args,timeout=20):
 p=subprocess.run(args,capture_output=True,text=True,timeout=timeout)
 if p.returncode: raise RuntimeError(str(args[:4])+': exit '+str(p.returncode))
 return p.stdout.strip()
def utc(): return datetime.datetime.now(datetime.timezone.utc).isoformat()
dc=['docker','compose','--env-file','deploy/server.env','--profile','polymarket','--profile','model']
ids=run(dc+['ps','--quiet']).splitlines()
info=[]
for cid in ids:
 obj=json.loads(run(['docker','inspect','--format','{{json .}}',cid]))
 service=obj['Config']['Labels'].get('com.docker.compose.service','')
 release=run(['docker','exec',cid,'sh','-c','if [ -f /etc/ganso/release-sha ]; then cat /etc/ganso/release-sha; fi'])
 info.append({'id':cid,'service':service,'image_id':obj['Image'],'memory_limit':obj['HostConfig']['Memory'],'nano_cpus':obj['HostConfig']['NanoCpus'],'oom_killed':obj['State']['OOMKilled'],'restart_count':obj['RestartCount'],'started_at':obj['State']['StartedAt'],'release':release})
pg=next(x['id'] for x in info if x['service']=='postgres')
rec=next(x['id'] for x in info if x['service']=='polymarket-recorder')
def sql(q):
 return json.loads(run(['docker','exec','-e','PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=2000 -c lock_timeout=500 -c application_name=db04-observer',pg,'psql','-XAt','-v','ON_ERROR_STOP=1','-U','ganso_market','-d','ganso_market','-c',q],10))
settings=sql("SELECT json_agg(row_to_json(s)) FROM (SELECT name,setting,unit,source,context,pending_restart FROM pg_settings WHERE name = ANY(ARRAY['max_connections','superuser_reserved_connections','reserved_connections','shared_buffers','work_mem','hash_mem_multiplier','maintenance_work_mem','autovacuum_work_mem','autovacuum_max_workers','max_worker_processes','max_parallel_workers','max_parallel_workers_per_gather','max_parallel_maintenance_workers','effective_cache_size','wal_buffers','shared_memory_size','shared_preload_libraries','track_io_timing','track_wal_io_timing']))s")
catalog=sql("SELECT json_agg(row_to_json(s)) FROM (SELECT t.relname table_name,t.reltuples,pg_table_size(t.oid) table_bytes,c.relname index_name,i.indisvalid,i.indisready,i.indislive,i.indisunique,pg_relation_size(c.oid) index_bytes,pg_get_indexdef(c.oid) definition FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_class t ON t.oid=i.indrelid WHERE i.indrelid = ANY(ARRAY['public.polymarket_trades'::regclass,'public.polymarket_rtds_prices'::regclass,'public.polymarket_book_snapshots'::regclass]) ORDER BY t.relname,c.relname)s")
def cg(cid):
 return {f:run(['docker','exec',cid,'cat','/sys/fs/cgroup/'+f]) for f in ['cpu.stat','memory.current','memory.events','io.stat']}
def snap():
 return {'utc':utc(),'pg':cg(pg),'recorder':cg(rec),'db':sql("SELECT row_to_json(d) FROM (SELECT clock_timestamp() utc,xact_commit,xact_rollback,blks_read,blks_hit,temp_files,temp_bytes,deadlocks,stats_reset FROM pg_stat_database WHERE datname=current_database())d"),'wal':sql('SELECT row_to_json(w) FROM (SELECT clock_timestamp() utc,wal_records,wal_fpi,wal_bytes,stats_reset FROM pg_stat_wal)w'),'tables':sql("SELECT json_agg(row_to_json(t)) FROM (SELECT clock_timestamp() utc,relname,n_tup_ins,n_tup_upd,n_tup_del,n_live_tup,n_dead_tup,last_autovacuum FROM pg_stat_user_tables WHERE relname IN ('polymarket_trades','polymarket_rtds_prices','polymarket_book_snapshots','polymarket_book_deltas'))t"),'activity':sql("SELECT json_agg(row_to_json(a)) FROM (SELECT backend_type,application_name,state,wait_event_type,wait_event,count(*) n,max(extract(epoch FROM (clock_timestamp()-query_start))) max_query_age_s FROM pg_stat_activity WHERE datname=current_database() GROUP BY 1,2,3,4,5)a"),'builds':sql('SELECT COALESCE(json_agg(row_to_json(p)),\'[]\'::json) FROM (SELECT pid,relid::regclass::text,command,phase FROM pg_stat_progress_create_index)p')}
start=utc(); a=snap(); time.sleep(30); b=snap()
stats=[json.loads(x) for x in run(['docker','stats','--no-stream','--format','{"name":"{{.Name}}","memory":"{{.MemUsage}}","cpu":"{{.CPUPerc}}","pids":"{{.PIDs}}"}',*ids]).splitlines()]
logs={}
for x in info:
 if x['service'] not in ('api','postgres') and not x['service'].startswith('polymarket-'): continue
 p=subprocess.run(['docker','logs','--since',start,'--tail','1000',x['id']],capture_output=True,text=True,timeout=10)
 lines=(p.stdout+'\n'+p.stderr).splitlines(); counts=collections.Counter(); reasons=collections.Counter()
 for line in lines:
  try:
   o=json.loads(line)
   message=o.get('message',o.get('msg',o.get('event','')))
   if isinstance(message,str) and re.fullmatch(r'[A-Za-z0-9_ .:-]{1,120}',message): counts[message]+=1
   reason=o.get('reason',o.get('error_code',o.get('code','')))
   if isinstance(reason,str) and re.fullmatch(r'[A-Z0-9_]{1,80}',reason): reasons[reason]+=1
  except (ValueError,AttributeError): pass
 logs[x['service']]={'lines':len(lines),'cap':1000,'timeout_mentions':sum(bool(re.search(r'timeout|timed.out|57014',l,re.I)) for l in lines),'messages':dict(counts),'reasons':dict(reasons)}
mem={line.split(':')[0]:line.split(':')[1].strip() for line in pathlib.Path('/proc/meminfo').read_text().splitlines() if line.startswith(('MemTotal:','MemAvailable:','SwapTotal:'))}
fs=os.statvfs('/opt/ganso-market')
checks={}
for script in ['scripts/check_compose_policy.py','scripts/check_runtime_memory.py']:
 p=subprocess.run(['python3',script],capture_output=True,text=True,timeout=30)
 checks[script]={'exit':p.returncode,'stdout':p.stdout.strip(),'stderr_lines':len(p.stderr.splitlines())}
print(json.dumps({'start_utc':start,'end_utc':utc(),'host':run(['hostname']),'cpus':os.cpu_count(),'meminfo':mem,'disk':{'total_bytes':fs.f_blocks*fs.f_frsize,'available_bytes':fs.f_bavail*fs.f_frsize},'checkout_release':pathlib.Path('deploy/release-sha').read_text().strip(),'containers':info,'settings':settings,'catalog':catalog,'a':a,'b':b,'stats':stats,'logs':logs,'checks':checks},indent=2))
