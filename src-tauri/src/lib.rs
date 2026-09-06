mod engine;

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::Result;
use ort::session::Session;
use serde::Serialize;
use tauri::{Manager, State};
use tauri_plugin_dialog::DialogExt;

/// Shared, process-wide state. One ONNX `Session` per model is built lazily and
/// cached; cancellation flags are keyed by the opaque `job_id` from the frontend.
struct AppState {
    /// `(model id, path)` pairs discovered at startup from the bundled models dir.
    models: Vec<(String, PathBuf)>,
    /// Lazily-built, cached ONNX sessions keyed by model id. Wrapped in `Mutex`
    /// because `Session::run` requires `&mut self`.
    sessions: Mutex<HashMap<String, Arc<Mutex<Session>>>>,
    /// Cancellation flags keyed by job id.
    cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

#[derive(Serialize)]
struct Capabilities {
    available: bool,
    backend: String,
    models: Vec<String>,
    max_dimension: u32,
}

#[derive(Serialize)]
struct EnhanceResult {
    destination_uri: String,
    width: u32,
    height: u32,
    model: String,
    scale: u32,
}

#[derive(Serialize)]
struct CancelResult {
    cancelled: bool,
}

/// Process-wide concurrency guard for `enhance_page`. The command is `async` but
/// the ONNX inference is CPU-bound; Tauri's async runtime will otherwise run
/// many IPC calls at once, saturating the CPU so no single page finishes. Only
/// one upscale runs at a time — matching the JS single-slot contract and keeping
/// each page's latency predictable. `acquire().await` (not a blocking std lock)
/// so waiting calls don't pin a runtime worker.
static ENHANCE_SLOT: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);

/// One entry returned by `list_directory`. `kind` is `dir | image | archive |
/// other`; `is_book` marks folders that themselves contain readable images
/// (so the UI can open them as a book) and archive files the reader can open.
#[derive(Serialize)]
struct FsEntry {
    name: String,
    path: String,
    kind: String,
    is_book: bool,
}

/// Result of `open_archive`: a temp dir holding extracted image entries.
#[derive(Serialize)]
struct ArchiveInfo {
    temp_dir: String,
    entries: Vec<ArchiveEntry>,
}

#[derive(Serialize)]
struct ArchiveEntry {
    name: String,
    path: String,
}

/// Load (or return cached) ONNX session for `model`.
fn load_session(state: &AppState, model: &str) -> Result<Arc<Mutex<Session>>> {
    if let Some(s) = state.sessions.lock().unwrap().get(model) {
        return Ok(s.clone());
    }
    let path = state
        .models
        .iter()
        .find(|(id, _)| id == model)
        .map(|(_, p)| p.clone())
        .ok_or_else(|| anyhow::anyhow!("model '{model}' is not bundled"))?;
    let session = Session::builder()
        .map_err(|e| anyhow::anyhow!(e.to_string()))?
        .commit_from_file(&path)
        .map_err(|e| anyhow::anyhow!(e.to_string()))?;
    let arc = Arc::new(Mutex::new(session));
    state
        .sessions
        .lock()
        .unwrap()
        .insert(model.to_string(), arc.clone());
    Ok(arc)
}

#[tauri::command]
fn get_capabilities(state: State<AppState>) -> Capabilities {
    let models: Vec<String> = state.models.iter().map(|(id, _)| id.clone()).collect();
    println!("[enhance] get_capabilities → models: {:?}", models);
    Capabilities {
        available: !models.is_empty(),
        backend: "cpu".into(),
        models,
        max_dimension: 4096,
    }
}

#[tauri::command]
async fn enhance_page(
    source_uri: String,
    destination_uri: String,
    model: String,
    scale: u32,
    #[allow(unused_variables)] tile_size: u32,
    #[allow(unused_variables)] denoise: u32,
    job_id: String,
    state: State<'_, AppState>,
) -> Result<EnhanceResult, String> {
    // Register/clear the cancellation flag for this job.
    let cancel = {
    let mut map = state.cancels.lock().unwrap();
        map.entry(job_id.clone())
            .or_insert_with(|| Arc::new(AtomicBool::new(false)))
            .clone()
    };
    cancel.store(false, Ordering::SeqCst);

    // Serialize CPU-bound inference: only one page upscales at a time across all
    // callers, so we never pile 12 pages onto the CPU at once.
    let _permit = ENHANCE_SLOT.acquire().await;

    let session = load_session(&state, &model).map_err(|e| e.to_string())?;
    let mut guard = session
        .lock()
        .map_err(|_| "session lock poisoned".to_string())?;

    println!("[enhance] enhance_page → model={} source={} dest={}", model, source_uri, destination_uri);
    let input = std::fs::read(&source_uri).map_err(|e| e.to_string())?;
    println!("[enhance] enhance_page → read source OK ({} bytes)", input.len());
    let (buf, w, h) = engine::enhance_image(&mut *guard, &input, scale as usize, &cancel).map_err(|e| {
        // Surface cancellation distinctly so the JS layer can drop partial output.
        if e.to_string() == "cancelled" {
            "cancelled".to_string()
        } else {
            e.to_string()
        }
    })?;

    // The JS side passes a real sibling path (e.g. `<book>/.enhanced/<hash>.png`);
    // create the parent dir so the write cannot fail on a missing folder.
    if let Some(parent) = Path::new(&destination_uri).parent() {
        if !parent.as_os_str().is_empty() {
            let _ = std::fs::create_dir_all(parent);
        }
    }
    std::fs::write(&destination_uri, &buf).map_err(|e| e.to_string())?;
    println!("[enhance] enhance_page → wrote {} ({} bytes)", destination_uri, buf.len());

    Ok(EnhanceResult {
        destination_uri,
        width: w,
        height: h,
        model,
        scale,
    })
}

#[tauri::command]
fn cancel_page(job_id: String, state: State<AppState>) -> CancelResult {
    let map = state.cancels.lock().unwrap();
    match map.get(&job_id) {
        Some(flag) => {
            flag.store(true, Ordering::SeqCst);
            CancelResult { cancelled: true }
        }
        None => CancelResult { cancelled: false },
    }
}

/// Read a directory and classify its entries. Folders that contain at least one
/// readable image are flagged `is_book` so the UI can open them as a comic.
#[tauri::command]
fn list_directory(path: String) -> Result<Vec<FsEntry>, String> {
    let base = Path::new(&path);
    let mut out: Vec<FsEntry> = Vec::new();
    let entries = fs::read_dir(&base).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let p = entry.path();
        let name = p
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if meta.is_dir() {
            let is_book = dir_has_images(&p);
            out.push(FsEntry {
                name,
                path: p.to_string_lossy().to_string(),
                kind: "dir".into(),
                is_book,
            });
        } else if let Some(kind) = file_kind(&p) {
            let is_book = kind == "archive";
            out.push(FsEntry {
                name,
                path: p.to_string_lossy().to_string(),
                kind,
                is_book,
            });
        }
    }
    out.sort_by(|a, b| match (a.kind.as_str(), b.kind.as_str()) {
        ("dir", "dir") => a.name.cmp(&b.name),
        ("dir", _) => std::cmp::Ordering::Less,
        (_, "dir") => std::cmp::Ordering::Greater,
        _ => a.name.cmp(&b.name),
    });
    Ok(out)
}

/// Whole-file bytes for a single image (folder-of-images case).
#[tauri::command]
fn read_file(path: String) -> Result<Vec<u8>, String> {
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    Ok(bytes)
}

/// Byte size of a file, used to estimate how much space upscaled derivatives
/// will occupy. Returns `null` when the file cannot be stat'ed.
#[tauri::command]
fn stat_file(path: String) -> Option<u64> {
    std::fs::metadata(&path).ok().map(|m| m.len())
}

/// Native folder picker. Returns the chosen directory path, or `null`.
/// Uses the callback-based (non-blocking) dialog so it never freezes the
/// webview/Gtk event loop — the result is bridged back via a oneshot.
#[tauri::command]
async fn pick_directory(app: tauri::AppHandle) -> Option<String> {
    let (tx, rx) = tokio::sync::oneshot::channel::<Option<String>>();
    app.dialog().file().pick_folder(move |path| {
        let _ = tx.send(path.map(|p| p.to_string()));
    });
    rx.await.ok().flatten()
}

/// Extract a comic archive into a temp dir and return the image entries.
/// v1 supports CBZ (zip). CBR/7Z are rejected with an explicit message —
/// the rar/7z crates are not wired up yet.
#[tauri::command]
fn open_archive(path: String) -> Result<ArchiveInfo, String> {
    let src = Path::new(&path);
    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    if ext != "cbz" && ext != "zip" {
        return Err(format!(
            "Unsupported archive '{ext}' — only CBZ/zip open in this build"
        ));
    }

    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let temp_dir = std::env::temp_dir().join(format!("openviewer-archive-{stamp}"));
    fs::create_dir_all(&temp_dir).map_err(|e| e.to_string())?;

    let file = File::open(src).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    let mut entries: Vec<ArchiveEntry> = Vec::new();
    for i in 0..archive.len() {
        let mut item = archive.by_index(i).map_err(|e| e.to_string())?;
        if item.is_dir() {
            continue;
        }
        let name = item.name().to_string();
        if !is_image_name(&name) {
            continue;
        }
        let base = Path::new(&name)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| format!("page-{i}"));
        let out_path = temp_dir.join(&base);
        let mut out = File::create(&out_path).map_err(|e| e.to_string())?;
        let mut buf = Vec::with_capacity(item.size() as usize);
        item.read_to_end(&mut buf).map_err(|e| e.to_string())?;
        out.write_all(&buf).map_err(|e| e.to_string())?;
        entries.push(ArchiveEntry {
            name: base,
            path: out_path.to_string_lossy().to_string(),
        });
    }
    entries.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(ArchiveInfo {
        temp_dir: temp_dir.to_string_lossy().to_string(),
        entries,
    })
}

/// Remove an extracted-archive temp dir. Called on book close.
#[tauri::command]
fn cleanup_archive(temp_dir: String) -> Result<(), String> {
    let _ = fs::remove_dir_all(&temp_dir);
    Ok(())
}

fn dir_has_images(dir: &Path) -> bool {
    if let Ok(rd) = fs::read_dir(dir) {
        for e in rd.flatten() {
            let p = e.path();
            if p.is_file() && is_image_name(p.file_name().and_then(|n| n.to_str()).unwrap_or("")) {
                return true;
            }
        }
    }
    false
}

fn is_image_name(name: &str) -> bool {
    matches!(
        Path::new(name)
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .as_deref(),
        Some("jpg") | Some("jpeg") | Some("png") | Some("webp") | Some("gif") | Some("bmp")
            | Some("tiff") | Some("tif")
    )
}

fn file_kind(path: &Path) -> Option<String> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "cbz" | "cbr" | "zip" | "7z" | "rar" => Some("archive".into()),
        "jpg" | "jpeg" | "png" | "webp" | "gif" | "bmp" | "tif" | "tiff" => Some("image".into()),
        _ => Some("other".into()),
    }
}

/// Discover bundled `.onnx` models at `resources/models` (relative to the
/// resource dir, which Tauri resolves for both dev and bundled runs).
///
/// Models are ordered so the faster 2× net is preferred (listed first): an
/// id containing `x2`/`2x`/`v2` sorts before `x4`/`4x`. `get_capabilities`
/// reports them in this order, and the frontend snaps its default to the first
/// bundled model — so 2× becomes the out-of-the-box default when present.
fn discover_models(resource_dir: &Path) -> Vec<(String, PathBuf)> {
    let models_dir = resource_dir.join("resources").join("models");
    let mut models: Vec<(String, PathBuf)> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&models_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) == Some("onnx") {
                if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                    models.push((stem.to_string(), path));
                }
            }
        }
    }
    models.sort_by_key(|(id, _)| {
        let prefers_2x = id.contains("x2") || id.contains("2x") || id.contains("v2");
        if prefers_2x {
            0u8
        } else {
            1u8
        }
    });
    models
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let resource_dir = app
                .path()
                .resource_dir()
                .unwrap_or_else(|_| PathBuf::from("."));
            let models = discover_models(&resource_dir);
            app.manage(AppState {
                models,
                sessions: Mutex::new(HashMap::new()),
                cancels: Mutex::new(HashMap::new()),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_capabilities,
            enhance_page,
            cancel_page,
            pick_directory,
            list_directory,
            read_file,
            stat_file,
            open_archive,
            cleanup_archive
        ])
        .run(tauri::generate_context!())
        .expect("error while running OpenViewer");
}

#[cfg(test)]
mod engine_tests {
    use super::*;
    use image::{Rgb, RgbImage};
    use std::sync::atomic::AtomicBool;

    /// Sanity-check the engine end-to-end against the real bundled model: it
    /// must run inference and emit a larger PNG. Catches "no output / hang"
    /// regressions without a device.
    #[test]
    fn engine_produces_upscaled_png() {
        let models_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources").join("models");
        let mut model_path: Option<PathBuf> = None;
        if let Ok(entries) = std::fs::read_dir(&models_dir) {
            for e in entries.flatten() {
                let p = e.path();
                if p.extension().and_then(|s| s.to_str()) == Some("onnx") {
                    model_path = Some(p);
                    break;
                }
            }
        }
        let model_path = model_path.expect("a bundled .onnx must exist for this test");
        println!("[test] using model {:?}", model_path);

        let session = Session::builder()
            .unwrap()
            .commit_from_file(&model_path)
            .expect("model must load");

        // 64×64 opaque gradient PNG in memory.
        let src = {
            let img = RgbImage::from_pixel(64, 64, Rgb([128u8, 64, 200]));
            let mut buf = Vec::new();
            img.write_to(&mut std::io::Cursor::new(&mut buf), image::ImageFormat::Png)
                .unwrap();
            buf
        };

        let cancel = AtomicBool::new(false);
        let (out, w, h) = engine::enhance_image(&mut { session }, &src, 4, &cancel)
            .expect("enhance_image must succeed");
        println!("[test] out {}x{} ({} bytes)", w, h, out.len());
        assert!(w > 64 && h > 64, "output must be upscaled");
        assert!(!out.is_empty());
        std::fs::write(std::env::temp_dir().join("openviewer_engine_test.png"), &out).unwrap();
    }
}
