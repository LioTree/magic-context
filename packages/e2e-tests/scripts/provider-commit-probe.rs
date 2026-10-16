//! SQLite profiling for generated fixture stores, never live stores. The Bun
//! provider driver adds this module only to its generated Rust test workspace.
use crate::McStore;
use rusqlite::ffi;
use std::cell::RefCell;
use std::collections::BTreeMap;
use std::ffi::{c_int, c_void, CStr};
use std::sync::Arc;
use std::time::Instant;

#[derive(Default, serde::Serialize)]
pub struct Snapshot {
    pub milliseconds: BTreeMap<String, f64>,
    pub calls: BTreeMap<String, u64>,
    pub write_bytes: BTreeMap<String, u64>,
}
#[derive(Default)]
struct State {
    snapshot: Snapshot,
    statements: BTreeMap<usize, (Instant, String)>,
    checkpoint: Option<Instant>,
    sync_delay: Option<std::time::Duration>,
}
thread_local! {
    static STATE: RefCell<State> = RefCell::new(State::default());
}
pub fn take() -> Snapshot {
    STATE.with(|state| std::mem::take(&mut state.borrow_mut().snapshot))
}
pub fn delay_next_wal_sync(delay: std::time::Duration) {
    STATE.with(|state| state.borrow_mut().sync_delay = Some(delay));
}
fn record(name: String, elapsed: f64) {
    STATE.with(|state| {
        let mut state = state.borrow_mut();
        *state.snapshot.milliseconds.entry(name.clone()).or_default() += elapsed;
        *state.snapshot.calls.entry(name).or_default() += 1;
    });
}
unsafe extern "C" fn trace(
    event: u32,
    _: *mut c_void,
    statement: *mut c_void,
    _: *mut c_void,
) -> c_int {
    if event == ffi::SQLITE_TRACE_STMT as u32 {
        let sql = ffi::sqlite3_sql(statement.cast());
        if !sql.is_null() {
            let sql = CStr::from_ptr(sql).to_string_lossy();
            let name = sql.split_whitespace().collect::<Vec<_>>().join(" ");
            STATE.with(|state| {
                state
                    .borrow_mut()
                    .statements
                    .insert(statement as usize, (Instant::now(), name));
            });
        }
    } else if event == ffi::SQLITE_TRACE_PROFILE as u32 {
        let measured =
            STATE.with(|state| state.borrow_mut().statements.remove(&(statement as usize)));
        if let Some((started, sql)) = measured {
            record(
                format!("sql:{sql}"),
                started.elapsed().as_secs_f64() * 1000.0,
            );
        }
    }
    0
}

// The first member has the exact ABI SQLite expects. Each wrapper delegates to
// the original method, with the same file, flags and return value.
#[repr(C)]
struct Methods {
    methods: ffi::sqlite3_io_methods,
    original: *const ffi::sqlite3_io_methods,
    kind: &'static str,
}
unsafe fn methods(file: *mut ffi::sqlite3_file) -> &'static Methods {
    &*((*file).pMethods.cast::<Methods>())
}
unsafe extern "C" fn sync(file: *mut ffi::sqlite3_file, flags: c_int) -> c_int {
    let methods = methods(file);
    let started = Instant::now();
    if methods.kind == "wal" {
        STATE.with(|state| {
            let mut state = state.borrow_mut();
            let bytes = state.snapshot.write_bytes.get("wal").copied().unwrap_or(0);
            state
                .snapshot
                .write_bytes
                .insert("wal_written_before_sync".into(), bytes);
        });
        if let Some(delay) = STATE.with(|state| state.borrow_mut().sync_delay.take()) {
            std::thread::sleep(delay);
            record(
                "injected_wal_sync_delay".into(),
                delay.as_secs_f64() * 1000.0,
            );
        }
    }
    let result = ((*methods.original).xSync.unwrap())(file, flags);
    record(
        format!("{}_sync_flags_{flags}", methods.kind),
        started.elapsed().as_secs_f64() * 1000.0,
    );
    result
}
unsafe extern "C" fn write(
    file: *mut ffi::sqlite3_file,
    buffer: *const c_void,
    bytes: c_int,
    offset: i64,
) -> c_int {
    let methods = methods(file);
    let started = Instant::now();
    let result = ((*methods.original).xWrite.unwrap())(file, buffer, bytes, offset);
    record(
        format!("{}_write", methods.kind),
        started.elapsed().as_secs_f64() * 1000.0,
    );
    STATE.with(|state| {
        *state
            .borrow_mut()
            .snapshot
            .write_bytes
            .entry(methods.kind.into())
            .or_default() += bytes as u64
    });
    result
}
unsafe extern "C" fn truncate(file: *mut ffi::sqlite3_file, bytes: i64) -> c_int {
    let methods = methods(file);
    let started = Instant::now();
    let result = ((*methods.original).xTruncate.unwrap())(file, bytes);
    record(
        format!("{}_truncate", methods.kind),
        started.elapsed().as_secs_f64() * 1000.0,
    );
    result
}
unsafe extern "C" fn control(
    file: *mut ffi::sqlite3_file,
    operation: c_int,
    argument: *mut c_void,
) -> c_int {
    if operation == ffi::SQLITE_FCNTL_CKPT_START {
        STATE.with(|state| state.borrow_mut().checkpoint = Some(Instant::now()));
    }
    let result = ((*methods(file).original).xFileControl.unwrap())(file, operation, argument);
    if operation == ffi::SQLITE_FCNTL_CKPT_DONE {
        if let Some(started) = STATE.with(|state| state.borrow_mut().checkpoint.take()) {
            record(
                "checkpoint".into(),
                started.elapsed().as_secs_f64() * 1000.0,
            );
        }
    }
    result
}

/// Keeps the connection alive until all method pointers have been restored.
/// Install between requests on a generated fixture store, never on a live store.
/// Do not nest guards or install another SQLite trace callback: dropping this
/// guard removes that callback and restores the original file-method tables.
pub struct Guard {
    store: Arc<McStore>,
    files: Vec<(*mut ffi::sqlite3_file, Box<Methods>)>,
    _thread: std::marker::PhantomData<std::rc::Rc<()>>,
}
impl Guard {
    pub fn install(store: Arc<McStore>) -> Self {
        let mut guard = Self {
            store,
            files: Vec::new(),
            _thread: Default::default(),
        };
        guard
            .store
            .inner
            .with_conn(|conn| {
                // SQLite owns each file; the guard owns only the replacement method
                // table, whose address is stable until restoration under this lock.
                unsafe {
                    for (operation, kind) in [
                        (ffi::SQLITE_FCNTL_FILE_POINTER, "db"),
                        (ffi::SQLITE_FCNTL_JOURNAL_POINTER, "wal"),
                    ] {
                        let mut file: *mut ffi::sqlite3_file = std::ptr::null_mut();
                        let code = ffi::sqlite3_file_control(
                            conn.handle(),
                            c"main".as_ptr(),
                            operation,
                            (&mut file as *mut *mut ffi::sqlite3_file).cast(),
                        );
                        assert_eq!(code, ffi::SQLITE_OK);
                        assert!(
                            !file.is_null() && !(*file).pMethods.is_null(),
                            "{kind} must already be open"
                        );
                        let original = (*file).pMethods;
                        let mut replacement = Box::new(Methods {
                            methods: std::ptr::read(original),
                            original,
                            kind,
                        });
                        replacement.methods.xSync = Some(sync);
                        replacement.methods.xWrite = Some(write);
                        replacement.methods.xTruncate = Some(truncate);
                        replacement.methods.xFileControl = Some(control);
                        (*file).pMethods = &replacement.methods;
                        guard.files.push((file, replacement));
                    }
                    assert_eq!(
                        ffi::sqlite3_trace_v2(
                            conn.handle(),
                            (ffi::SQLITE_TRACE_STMT | ffi::SQLITE_TRACE_PROFILE) as u32,
                            Some(trace),
                            std::ptr::null_mut()
                        ),
                        ffi::SQLITE_OK
                    );
                }
                Ok(())
            })
            .unwrap();
        guard
    }
}
impl Drop for Guard {
    fn drop(&mut self) {
        self.store
            .inner
            .with_conn(|conn| {
                unsafe {
                    ffi::sqlite3_trace_v2(conn.handle(), 0, None, std::ptr::null_mut());
                    for (file, replacement) in &self.files {
                        (**file).pMethods = replacement.original;
                    }
                }
                Ok(())
            })
            .unwrap();
    }
}
