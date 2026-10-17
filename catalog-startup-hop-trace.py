#!/usr/bin/env python3
"""Temporary pinned-dependency reply-hop instrumentation; not a dependency fix."""
import collections
import json
import os
import pathlib
import shutil
import subprocess

root = pathlib.Path.cwd()
print(subprocess.check_output(['cargo', '--version'], text=True).strip(), flush=True)
lock = (root / 'Cargo.lock').read_bytes()
manifest = (root / 'Cargo.toml').read_bytes()
client = root / 'instrumented-subc-client'
daemon = root / 'instrumented-subc-daemon'
for name, dst in [('subc-client-rs-0.26.1', client), ('subc-daemon-0.31.2', daemon)]:
    src = next((pathlib.Path(os.environ['CARGO_HOME']) / 'registry/src').glob('*/' + name))
    shutil.copytree(src, dst, dirs_exist_ok=True)


def replace(path, old, new):
    text = path.read_text()
    assert text.count(old) == 1, (path, old, text.count(old))
    path.write_text(text.replace(old, new))


p = client / 'src/lib.rs'
replace(p, 'let _ = send_handler_outcome(&ctx, outcome).await;', '''eprintln!("HOP {:?} SDK outcome channel={} epoch={} corr={}", std::time::SystemTime::now(), ctx.handle.channel, ctx.handle.epoch, ctx.corr);
        let result = send_handler_outcome(&ctx, outcome).await;
        eprintln!("HOP {:?} SDK queued channel={} epoch={} corr={} result={:?}", std::time::SystemTime::now(), ctx.handle.channel, ctx.handle.epoch, ctx.corr, result);''')
replace(p, 'while let Some(frame) = rx.recv().await {', '''while let Some(frame) = rx.recv().await {
        eprintln!("HOP {:?} SDK writer {:?}", std::time::SystemTime::now(), frame.header);''')
replace(p, 'while let Ok(frame) = rx.try_recv() {', '''while let Ok(frame) = rx.try_recv() {
            eprintln!("HOP {:?} SDK writer batch {:?}", std::time::SystemTime::now(), frame.header);''')
replace(p, 'writer.flush().await.map_err(FrameIoError::Io)?;\n    }', '''writer.flush().await.map_err(FrameIoError::Io)?;
        eprintln!("HOP {:?} SDK flushed", std::time::SystemTime::now());
    }''')
p = client / 'src/consumer.rs'
replace(p, 'Ok(Some(frame)) => {\n                if !dispatch_frame', '''Ok(Some(frame)) => {
                eprintln!("HOP {:?} CONSUMER read gen={} {:?}", std::time::SystemTime::now(), generation, frame.header);
                if !dispatch_frame''')
replace(p, '&& !shared.validate_ingress_handle(generation, frame.header.channel, frame.header.epoch)\n    {', '''&& !shared.validate_ingress_handle(generation, frame.header.channel, frame.header.epoch)
    {
        eprintln!("HOP {:?} CONSUMER invalid ingress {:?}", std::time::SystemTime::now(), frame.header);''')
replace(p, 'fn settle_pending(self: &Arc<Self>, key: PendingKey, terminal: PendingTerminal) {\n        let entry = self.lock_inner().pending.remove(&key);', '''fn settle_pending(self: &Arc<Self>, key: PendingKey, terminal: PendingTerminal) {
        let entry = self.lock_inner().pending.remove(&key);
        eprintln!("HOP {:?} CONSUMER settle gen={} channel={} epoch={} corr={} found={}", std::time::SystemTime::now(), key.generation, key.channel, key.epoch, key.corr, entry.is_some());''')
p = daemon / 'src/server.rs'
replace(p, 'if let Some(target_module_id) = router.route_open_target(&frame) {', '''eprintln!("HOP {:?} DAEMON read conn={} {:?}", std::time::SystemTime::now(), ctx.connection_id.get(), frame.header);
        if let Some(target_module_id) = router.route_open_target(&frame) {''')
replace(p, 'if let Err(err) = route_result {', '''eprintln!("HOP {:?} DAEMON routed conn={} result={:?}", std::time::SystemTime::now(), ctx.connection_id.get(), route_result);
        if let Err(err) = route_result {''')
replace(p, 'let frame = outbound.frame;', '''let frame = outbound.frame;
    eprintln!("HOP {:?} DAEMON writer queued={:?} {:?}", std::time::SystemTime::now(), queued, frame.header);''')
replace(p, 'writer.flush().await.map_err(FrameIoError::Io)?;\n    }\n    writer.flush()', '''writer.flush().await.map_err(FrameIoError::Io)?;
        eprintln!("HOP {:?} DAEMON flushed", std::time::SystemTime::now());
    }
    writer.flush()''')
p = daemon / 'src/router.rs'
for variant in ['EpochMismatch', 'Reserved', 'Absent']:
    old = f'DataRoute::Module(DataRouteState::{variant}) => {{'
    replace(p, old, old + f'\n                eprintln!("HOP {{:?}} DAEMON DROP {variant} conn={{}} channel={{}} epoch={{}} corr={{}}", std::time::SystemTime::now(), ctx.connection_id.get(), channel, epoch, corr);')
replace(p, 'if let Err(err) = route.client_sink.try_send(frame) {', '''let delivery = route.client_sink.try_send(frame);
                eprintln!("HOP {:?} DAEMON delivery conn={} channel={} epoch={} corr={} result={:?}", std::time::SystemTime::now(), route.client_connection_id.get(), route.client_channel, route.client_epoch, corr, delivery);
                if let Err(err) = delivery {''')
configs = ['--config', f'patch.crates-io.subc-client-rs.path="{client}"', '--config', f'patch.crates-io.subc-daemon.path="{daemon}"']
try:
    replace(root / 'Cargo.toml', 'subc-daemon = { version = "=0.31.2" }', f'subc-daemon = {{ path = "{daemon}" }}')
    b = subprocess.run(['cargo', *configs, 'test', '-p', 'mc-module', '--lib', '-j', '4', '--no-run', '--message-format=json'], text=True, stdout=subprocess.PIPE, check=True)
    binary = next(a['executable'] for a in map(json.loads, b.stdout.splitlines()) if a.get('executable') and a.get('target', {}).get('name') == 'mc_module')
    p = subprocess.Popen([binary, '--test-threads=4', '--nocapture'], text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    lines = collections.deque(maxlen=1500)
    passed = False
    try:
        for line in p.stdout:
            lines.append(line)
            if 'CATALOG STRESS' in line or 'panicked at' in line or 'FAILED' in line:
                print(line, end='', flush=True)
            if 'test aaa_catalog_startup_loaded_repetition ...' in line:
                passed = '... ok' in line
                break
    finally:
        p.terminate()
        p.wait(timeout=30)
        print('LAST HOP TRACE:\n' + ''.join(lines), flush=True)
    print('loaded repetition passed:', passed, flush=True)
    raise SystemExit(0 if passed else 1)
finally:
    (root / 'Cargo.lock').write_bytes(lock)
    (root / 'Cargo.toml').write_bytes(manifest)
    shutil.rmtree(client)
    shutil.rmtree(daemon)
