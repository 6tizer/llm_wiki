use std::fs;
use std::path::Path;

use calamine::{open_workbook_auto, Data, Reader};

/// Known binary formats that need special extraction.
pub(super) const OFFICE_EXTS: &[&str] = &["docx", "pptx", "xlsx", "odt", "ods", "odp"];

/// DOCX parsing loads the whole file into memory via `docx_rs::read_docx`
/// (no streaming API). Capped to bound worst-case memory use from a
/// maliciously or accidentally huge `.docx` in the project tree.
pub(super) const MAX_DOCX_INPUT_BYTES: u64 = 64 * 1024 * 1024;

/// Stats `fs_path` and rejects it if larger than `cap_bytes`, otherwise
/// returns its size. `label` is what shows up in the error message (the
/// caller's original, pre-sandbox-validation path string, so errors
/// reference what the user/frontend passed in rather than an internal
/// canonicalized one); `kind` is a short type label (e.g. "DOCX") prefixed
/// into both the stat-failure and over-cap messages.
pub(super) fn reject_if_over_cap(
    fs_path: impl AsRef<Path>,
    label: &str,
    cap_bytes: u64,
    kind: &str,
) -> Result<u64, String> {
    let size = fs::metadata(fs_path)
        .map_err(|e| format!("Failed to stat {} '{}': {}", kind, label, e))?
        .len();
    if size > cap_bytes {
        return Err(format!(
            "{} '{}' is {} bytes, exceeding the {}-byte limit",
            kind, label, size, cap_bytes
        ));
    }
    Ok(size)
}

/// Global PDFium instance — the library prefers a single binding shared
/// across threads over repeatedly binding/unbinding.
static PDFIUM: std::sync::OnceLock<Result<pdfium_render::prelude::Pdfium, String>> =
    std::sync::OnceLock::new();

/// Serializes every PDFium call. PDFium's C library is documented as
/// safe across threads only when no PDFium object is touched from
/// two threads simultaneously — interleaved calls are UB and have
/// caused EXC_BAD_ACCESS segfaults on macOS ARM64 in production.
///
/// This mutex matters because our heavy fs commands are now `async
/// fn`, so Tauri schedules them on the tokio multi-threaded runtime
/// instead of running them on a single thread. Without this lock,
/// two concurrent `read_file`/`extract_*_pdf` calls can land on
/// different worker threads and interleave inside pdfium → crash.
///
/// We use `std::sync::Mutex` (not `tokio::sync::Mutex`) because the
/// lock is acquired *inside* `spawn_blocking`, never held across
/// `.await` — async-aware mutexes would just add overhead for no
/// benefit here.
static PDFIUM_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Acquire the PDFium serialization lock. Auto-recovers from poison
/// (a previous panic on a malformed PDF leaves the mutex poisoned,
/// but pdfium has no shared state for that panic to have corrupted —
/// the next caller can safely take the lock and proceed).
pub(crate) fn lock_pdfium() -> std::sync::MutexGuard<'static, ()> {
    PDFIUM_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Additional resource directory hint, set by the Tauri setup() callback
/// once the AppHandle is available. Lets the pdfium resolver find the
/// bundled dylib without re-implementing Tauri's platform-specific
/// resource-dir logic.
static RESOURCE_DIR_HINT: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();

/// Called from Tauri's setup() with the resolved resource directory.
/// No-op if already set.
pub fn set_resource_dir_hint(dir: std::path::PathBuf) {
    let _ = RESOURCE_DIR_HINT.set(dir);
}

/// Enumerate plausible locations for the PDFium dynamic library on the
/// current platform. Order from most specific to least:
///   1. `$PDFIUM_DYNAMIC_LIB_PATH` env var (local dev convenience)
///   2. Tauri resource dir (set via setup()) — the authoritative location
///   3. Paths relative to the executable where Tauri's bundler lands
///      resources on each platform (macOS Frameworks / Resources /
///      MacOS dir, Windows sibling, Linux sibling)
///   4. OS dynamic loader search path (last resort)
fn pdfium_candidate_paths() -> Vec<String> {
    let mut v: Vec<String> = Vec::new();

    if let Ok(p) = std::env::var("PDFIUM_DYNAMIC_LIB_PATH") {
        v.push(p);
    }

    // Tauri-resolved resource directory (set during setup()).
    //
    // Tauri's `bundle.resources` array form preserves relative paths,
    // so `"pdfium/pdfium.dll"` in tauri.<target>.conf.json lands at
    // `<resource_dir>/pdfium/pdfium.dll` — NOT at the root. Older
    // versions of this function only probed the root, which made
    // Windows installs fail with "Failed to locate Pdfium library"
    // (OS error 126) even though the DLL was in the installer.
    // We now probe both the `pdfium/` subdir (where the current
    // bundle config actually puts it) and the root (in case a future
    // config change flattens it).
    if let Some(resource_dir) = RESOURCE_DIR_HINT.get() {
        let push = |v: &mut Vec<String>, p: std::path::PathBuf| {
            v.push(p.to_string_lossy().into_owned());
        };
        #[cfg(target_os = "macos")]
        {
            push(&mut v, resource_dir.join("pdfium").join("libpdfium.dylib"));
            push(&mut v, resource_dir.join("libpdfium.dylib"));
        }
        #[cfg(target_os = "windows")]
        {
            push(&mut v, resource_dir.join("pdfium").join("pdfium.dll"));
            push(&mut v, resource_dir.join("pdfium").join("libpdfium.dll"));
            push(&mut v, resource_dir.join("pdfium.dll"));
            push(&mut v, resource_dir.join("libpdfium.dll"));
        }
        #[cfg(target_os = "linux")]
        {
            push(&mut v, resource_dir.join("pdfium").join("libpdfium.so"));
            push(&mut v, resource_dir.join("libpdfium.so"));
        }
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            let push = |v: &mut Vec<String>, p: std::path::PathBuf| {
                v.push(p.to_string_lossy().into_owned());
            };

            #[cfg(target_os = "macos")]
            {
                // Tauri .app bundle layout:
                //   Contents/MacOS/<binary>
                //   Contents/Frameworks/libpdfium.dylib   ← preferred (macOS config uses bundle.macOS.frameworks)
                //   Contents/Resources/libpdfium.dylib    ← fallback
                //   Contents/Resources/pdfium/libpdfium.dylib  ← if array-form resources ever used on macOS
                push(&mut v, exe_dir.join("../Frameworks/libpdfium.dylib"));
                push(&mut v, exe_dir.join("../Resources/pdfium/libpdfium.dylib"));
                push(&mut v, exe_dir.join("../Resources/libpdfium.dylib"));
                push(&mut v, exe_dir.join("libpdfium.dylib"));
            }

            #[cfg(target_os = "windows")]
            {
                // bblanchon/pdfium-binaries ships the Windows DLL as
                // `pdfium.dll` (no `lib` prefix). Probe flat and
                // `pdfium/` subdir forms at both exe root and the
                // classic Tauri `resources/` sibling — covers every
                // layout variant we've observed across NSIS / MSI /
                // portable builds.
                push(&mut v, exe_dir.join("pdfium.dll"));
                push(&mut v, exe_dir.join("pdfium").join("pdfium.dll"));
                push(&mut v, exe_dir.join("libpdfium.dll"));
                push(&mut v, exe_dir.join("resources").join("pdfium.dll"));
                push(
                    &mut v,
                    exe_dir.join("resources").join("pdfium").join("pdfium.dll"),
                );
            }

            #[cfg(target_os = "linux")]
            {
                push(&mut v, exe_dir.join("libpdfium.so"));
                push(&mut v, exe_dir.join("pdfium").join("libpdfium.so"));
                push(&mut v, exe_dir.join("resources").join("libpdfium.so"));
                push(
                    &mut v,
                    exe_dir
                        .join("resources")
                        .join("pdfium")
                        .join("libpdfium.so"),
                );
                push(&mut v, exe_dir.join("../lib/libpdfium.so"));
            }
        }
    }

    v
}

pub(crate) fn pdfium() -> Result<&'static pdfium_render::prelude::Pdfium, String> {
    PDFIUM
        .get_or_init(|| {
            use pdfium_render::prelude::*;
            let candidates = pdfium_candidate_paths();
            for path in &candidates {
                if let Ok(bindings) = Pdfium::bind_to_library(path) {
                    eprintln!("[pdfium] loaded dynamic library from {path}");
                    return Ok(Pdfium::new(bindings));
                }
            }
            // Last resort: let the OS dynamic loader find it.
            Pdfium::bind_to_system_library()
                .map(Pdfium::new)
                .map_err(|e| {
                    format!(
                        "Failed to locate Pdfium library. Tried: {} — and the system search path. Last error: {e}",
                        if candidates.is_empty() {
                            "(no candidates)".to_string()
                        } else {
                            candidates.join(", ")
                        }
                    )
                })
        })
        .as_ref()
        .map_err(|e| e.clone())
}

/// Extract a PDF as markdown — text + per-page image references
/// when the file lives under a project's `raw/sources/` (the
/// layout the import pipeline produces). Falls back to text-only
/// when the PDF is opened from anywhere else.
///
/// Layout heuristic: a PDF at `<project>/raw/sources/<name>.pdf`
/// implies project root = `<project>` and image dest =
/// `<project>/wiki/media/<name>/`. We use absolute filesystem paths
/// in the emitted `![](url)` references so the markdown previews
/// (raw-source view AND wiki-summary view) both render via
/// `convertFileSrc` without anyone having to know which directory
/// they're rendering from.
///
/// Lock: delegates to `extract_pdf_markdown`, which acquires the
/// pdfium lock internally. We must NOT take it here too —
/// `std::sync::Mutex` is non-reentrant.
pub(super) fn extract_pdf_text(path: &str) -> Result<String, String> {
    use super::extract_images::{extract_pdf_markdown, ExtractOptions};

    let p = Path::new(path);
    let parent = p.parent();
    let stem = p
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();

    // The path-component check uses `ends_with` on `Path` which
    // matches the LAST component (not a string-suffix check), so
    // `/foo/raw/sources/bar.pdf` correctly identifies as under
    // `raw/sources/` while `/foo/braw/source-thing/bar.pdf` does
    // not.
    let parent_is_sources = parent.map(|d| d.ends_with("sources")).unwrap_or(false);
    let raw_dir = parent.and_then(|d| d.parent());
    let raw_is_raw = raw_dir.map(|d| d.ends_with("raw")).unwrap_or(false);
    let project_root = if parent_is_sources && raw_is_raw {
        raw_dir.and_then(|d| d.parent())
    } else {
        None
    };

    if let Some(root) = project_root {
        if !stem.is_empty() {
            let media_dir = root.join("wiki").join("media").join(&stem);
            // Forward-slash absolute path so we don't ship `\` into
            // markdown that the JS-side resolver would then have to
            // re-normalize. The resolver does handle backslashes,
            // but emitting clean URLs in the first place avoids
            // surprises in cache files we save to disk.
            let url_prefix = media_dir.to_string_lossy().replace('\\', "/");
            return extract_pdf_markdown(
                path,
                Some(&media_dir),
                &url_prefix,
                &ExtractOptions::default(),
            );
        }
    }

    // PDFs not under <project>/raw/sources/ — text-only fallback.
    // Skip the image side of the extraction entirely (no media
    // destination → extract_pdf_markdown only writes text + page
    // headers, no pdfium image-object enumeration).
    extract_pdf_markdown(path, None, "", &ExtractOptions::default())
}

/// Extract text from Office Open XML formats, converting to Markdown.
pub(super) fn extract_office_text(path: &str, ext: &str) -> Result<String, String> {
    // Spreadsheets: use calamine (supports xlsx, xls, ods)
    if matches!(ext, "xlsx" | "xls" | "ods") {
        return extract_spreadsheet(path);
    }

    // DOCX: use docx-rs library for proper parsing
    if ext == "docx" {
        return extract_docx_with_library(path);
    }

    // PPTX and ODF: use ZIP-based parsing
    let file = fs::File::open(path).map_err(|e| format!("Failed to open '{}': {}", path, e))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("Failed to read ZIP archive '{}': {}", path, e))?;

    match ext {
        "pptx" => extract_pptx_markdown(&mut archive),
        "odt" | "odp" => extract_odf_text(&mut archive),
        _ => Ok("[Unsupported format]".to_string()),
    }
}

/// Extract DOCX using docx-rs library for proper structural parsing.
fn extract_docx_with_library(path: &str) -> Result<String, String> {
    reject_if_over_cap(path, path, MAX_DOCX_INPUT_BYTES, "DOCX")?;
    let bytes = fs::read(path).map_err(|e| format!("Failed to read DOCX '{}': {}", path, e))?;
    let docx = docx_rs::read_docx(&bytes)
        .map_err(|e| format!("Failed to parse DOCX '{}': {:?}", path, e))?;

    let mut result = String::new();

    for child in docx.document.children {
        match child {
            docx_rs::DocumentChild::Paragraph(para) => {
                let mut para_text = String::new();
                let mut is_heading = false;
                let mut heading_level: u8 = 1;

                // Check paragraph style for headings
                if let Some(style) = &para.property.style {
                    let style_val = &style.val;
                    if style_val.contains("Heading") || style_val.contains("heading") {
                        is_heading = true;
                        // Extract level number
                        for ch in style_val.chars() {
                            if ch.is_ascii_digit() {
                                heading_level = ch.to_digit(10).unwrap_or(1) as u8;
                                break;
                            }
                        }
                    }
                }

                // Check for list (numbering)
                let is_list = para.property.numbering_property.is_some();

                // Extract text from runs
                for child in &para.children {
                    if let docx_rs::ParagraphChild::Run(run) = child {
                        let is_bold = run.run_property.bold.is_some();
                        let is_italic = run.run_property.italic.is_some();

                        for run_child in &run.children {
                            if let docx_rs::RunChild::Text(text) = run_child {
                                let t = &text.text;
                                if is_bold && is_italic {
                                    para_text.push_str(&format!("***{}***", t));
                                } else if is_bold {
                                    para_text.push_str(&format!("**{}**", t));
                                } else if is_italic {
                                    para_text.push_str(&format!("*{}*", t));
                                } else {
                                    para_text.push_str(t);
                                }
                            }
                        }
                    }
                }

                let text = para_text.trim().to_string();
                if text.is_empty() {
                    continue;
                }

                if is_heading {
                    let prefix = "#".repeat(heading_level as usize);
                    result.push_str(&format!("{} {}\n\n", prefix, text));
                } else if is_list {
                    result.push_str(&format!("- {}\n", text));
                } else {
                    result.push_str(&text);
                    result.push_str("\n\n");
                }
            }
            docx_rs::DocumentChild::Table(table) => {
                let mut rows: Vec<Vec<String>> = Vec::new();
                for row in &table.rows {
                    let docx_rs::TableChild::TableRow(tr) = row;
                    let mut cells: Vec<String> = Vec::new();
                    for cell in &tr.cells {
                        let docx_rs::TableRowChild::TableCell(tc) = cell;
                        let mut cell_text = String::new();
                        for child in &tc.children {
                            if let docx_rs::TableCellContent::Paragraph(para) = child {
                                for pchild in &para.children {
                                    if let docx_rs::ParagraphChild::Run(run) = pchild {
                                        for rc in &run.children {
                                            if let docx_rs::RunChild::Text(t) = rc {
                                                cell_text.push_str(&t.text);
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        cells.push(cell_text.trim().replace('|', "\\|"));
                    }
                    rows.push(cells);
                }
                if !rows.is_empty() {
                    let max_cols = rows.iter().map(|r| r.len()).max().unwrap_or(0);
                    for (i, row) in rows.iter().enumerate() {
                        let mut padded = row.clone();
                        padded.resize(max_cols, String::new());
                        result.push_str("| ");
                        result.push_str(&padded.join(" | "));
                        result.push_str(" |\n");
                        if i == 0 {
                            result.push('|');
                            for _ in 0..max_cols {
                                result.push_str(" --- |");
                            }
                            result.push('\n');
                        }
                    }
                    result.push('\n');
                }
            }
            _ => {}
        }
    }

    if result.trim().is_empty() {
        // Fallback to ZIP-based extraction
        let file = fs::File::open(path).map_err(|e| e.to_string())?;
        let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
        extract_docx_markdown(&mut archive)
    } else {
        Ok(result)
    }
}

fn read_zip_file(archive: &mut zip::ZipArchive<fs::File>, name: &str) -> Result<String, String> {
    use super::extract_images::{read_zip_entry_capped, MAX_DECOMPRESSED_ENTRY_BYTES};

    let mut entry = archive
        .by_name(name)
        .map_err(|e| format!("zip entry '{name}' not found: {e}"))?;
    let bytes = read_zip_entry_capped(&mut entry, MAX_DECOMPRESSED_ENTRY_BYTES)?;
    String::from_utf8(bytes).map_err(|e| format!("zip entry '{name}' is not valid UTF-8: {e}"))
}

fn decode_xml_entities(text: &str) -> String {
    text.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&#10;", "\n")
        .replace("&#13;", "")
}

/// Extract DOCX to Markdown preserving headings, paragraphs, lists, tables, bold/italic.
fn extract_docx_markdown(archive: &mut zip::ZipArchive<fs::File>) -> Result<String, String> {
    let xml = read_zip_file(archive, "word/document.xml")?;

    let mut result = String::new();
    let mut i = 0;
    let chars: Vec<char> = xml.chars().collect();
    let len = chars.len();

    // Track current paragraph state
    let mut paragraph_text = String::new();
    let mut is_heading = false;
    let mut heading_level: u8 = 1;
    let mut is_bold = false;
    let mut is_italic = false;
    let mut in_table = false;
    let mut table_row: Vec<String> = Vec::new();
    let mut table_cell_text = String::new();
    let mut in_cell = false;
    let mut is_first_table_row = true;
    let mut in_list_item = false;

    while i < len {
        if chars[i] == '<' {
            // Read tag name
            i += 1;
            let is_closing = i < len && chars[i] == '/';
            if is_closing {
                i += 1;
            }

            let mut tag_name = String::new();
            while i < len && chars[i] != '>' && chars[i] != ' ' && chars[i] != '/' {
                tag_name.push(chars[i]);
                i += 1;
            }

            // Read rest of tag to find attributes
            let mut tag_content = String::new();
            while i < len && chars[i] != '>' {
                tag_content.push(chars[i]);
                i += 1;
            }
            if i < len {
                i += 1;
            } // skip >

            match tag_name.as_str() {
                // Paragraph start
                "w:p" if !is_closing => {
                    paragraph_text.clear();
                    is_heading = false;
                    in_list_item = false;
                }
                // Paragraph end — flush
                "w:p" if is_closing => {
                    let text = paragraph_text.trim().to_string();
                    if !text.is_empty() {
                        if in_table && in_cell {
                            table_cell_text = text;
                        } else if is_heading {
                            let prefix = "#".repeat(heading_level as usize);
                            result.push_str(&format!("{} {}\n\n", prefix, text));
                        } else if in_list_item {
                            result.push_str(&format!("- {}\n", text));
                        } else {
                            result.push_str(&text);
                            result.push_str("\n\n");
                        }
                    }
                    paragraph_text.clear();
                }
                // Heading style detection
                "w:pStyle" if !is_closing => {
                    if tag_content.contains("Heading") || tag_content.contains("heading") {
                        is_heading = true;
                        // Try to extract heading level from val="Heading1" etc.
                        if let Some(pos) = tag_content.find("Heading") {
                            let after = &tag_content[pos + 7..];
                            if let Some(ch) = after.chars().next() {
                                if ch.is_ascii_digit() {
                                    heading_level = ch.to_digit(10).unwrap_or(1) as u8;
                                }
                            }
                        }
                    }
                    if tag_content.contains("ListParagraph")
                        || tag_content.contains("listParagraph")
                    {
                        in_list_item = true;
                    }
                }
                // Bold
                "w:b"
                    if !is_closing
                        && !tag_content.contains("w:val=\"0\"")
                        && !tag_content.contains("w:val=\"false\"") =>
                {
                    is_bold = true;
                }
                // Italic
                "w:i"
                    if !is_closing
                        && !tag_content.contains("w:val=\"0\"")
                        && !tag_content.contains("w:val=\"false\"") =>
                {
                    is_italic = true;
                }
                // Run end — apply formatting
                "w:r" if is_closing => {
                    is_bold = false;
                    is_italic = false;
                }
                // Text content
                "w:t" if !is_closing => {
                    // Read text until </w:t>
                    let mut text = String::new();
                    while i < len {
                        if chars[i] == '<' {
                            break;
                        }
                        text.push(chars[i]);
                        i += 1;
                    }
                    let decoded = decode_xml_entities(&text);
                    if is_bold && is_italic {
                        paragraph_text.push_str(&format!("***{}***", decoded));
                    } else if is_bold {
                        paragraph_text.push_str(&format!("**{}**", decoded));
                    } else if is_italic {
                        paragraph_text.push_str(&format!("*{}*", decoded));
                    } else {
                        paragraph_text.push_str(&decoded);
                    }
                }
                // Table handling
                "w:tbl" if !is_closing => {
                    in_table = true;
                    is_first_table_row = true;
                }
                "w:tbl" if is_closing => {
                    in_table = false;
                    result.push('\n');
                }
                "w:tr" if !is_closing => {
                    table_row.clear();
                }
                "w:tr" if is_closing => {
                    if !table_row.is_empty() {
                        result.push_str("| ");
                        result.push_str(&table_row.join(" | "));
                        result.push_str(" |\n");
                        if is_first_table_row {
                            result.push_str("|");
                            for _ in &table_row {
                                result.push_str(" --- |");
                            }
                            result.push('\n');
                            is_first_table_row = false;
                        }
                    }
                }
                "w:tc" if !is_closing => {
                    in_cell = true;
                    table_cell_text.clear();
                }
                "w:tc" if is_closing => {
                    table_row.push(table_cell_text.trim().to_string());
                    in_cell = false;
                    table_cell_text.clear();
                }
                _ => {}
            }
        } else {
            i += 1;
        }
    }

    if result.trim().is_empty() {
        Ok("[Could not extract structured text from DOCX]".to_string())
    } else {
        Ok(result)
    }
}

/// Extract PPTX to Markdown with slide numbers and structure.
fn extract_pptx_markdown(archive: &mut zip::ZipArchive<fs::File>) -> Result<String, String> {
    let mut slide_names: Vec<String> = (0..archive.len())
        .filter_map(|i| archive.by_index(i).ok().map(|f| f.name().to_string()))
        .filter(|n| n.starts_with("ppt/slides/slide") && n.ends_with(".xml"))
        .collect();

    // Sort by slide number
    slide_names.sort_by(|a, b| {
        let num_a = a
            .trim_start_matches("ppt/slides/slide")
            .trim_end_matches(".xml")
            .parse::<u32>()
            .unwrap_or(0);
        let num_b = b
            .trim_start_matches("ppt/slides/slide")
            .trim_end_matches(".xml")
            .parse::<u32>()
            .unwrap_or(0);
        num_a.cmp(&num_b)
    });

    let mut result = String::new();

    for (idx, slide_name) in slide_names.iter().enumerate() {
        let xml = match read_zip_file(archive, slide_name) {
            Ok(x) => x,
            Err(e) => {
                eprintln!("[extract_pptx_markdown] skipping slide '{slide_name}': {e}");
                continue;
            }
        };

        result.push_str(&format!("## Slide {}\n\n", idx + 1));

        // Extract text from <a:t>...</a:t> tags, group by <a:p>...</a:p> paragraphs
        // Use string split approach to avoid byte/char index mismatch with CJK characters
        let mut paragraphs: Vec<String> = Vec::new();

        for para_part in xml.split("<a:p") {
            let mut para_text = String::new();
            for t_part in para_part.split("<a:t") {
                if let Some(close_pos) = t_part.find("</a:t>") {
                    if let Some(gt_pos) = t_part.find('>') {
                        if gt_pos < close_pos {
                            let text = &t_part[gt_pos + 1..close_pos];
                            para_text.push_str(&decode_xml_entities(text));
                        }
                    }
                }
            }
            let trimmed = para_text.trim().to_string();
            if !trimmed.is_empty() {
                paragraphs.push(trimmed);
            }
        }

        // First paragraph is usually the slide title
        if let Some(title) = paragraphs.first() {
            result.push_str(&format!("**{}**\n\n", title));
            for para in paragraphs.iter().skip(1) {
                result.push_str(&format!("- {}\n", para));
            }
        }
        result.push('\n');
    }

    if result.trim().is_empty() {
        Ok("[Could not extract text from PPTX]".to_string())
    } else {
        Ok(result)
    }
}

/// Extract spreadsheet to Markdown using calamine (supports xlsx, xls, ods).
fn extract_spreadsheet(path: &str) -> Result<String, String> {
    let mut workbook = open_workbook_auto(path)
        .map_err(|e| format!("Failed to open spreadsheet '{}': {}", path, e))?;

    let mut result = String::new();
    let sheet_names = workbook.sheet_names().to_vec();

    for sheet_name in &sheet_names {
        if let Ok(range) = workbook.worksheet_range(sheet_name) {
            if range.is_empty() {
                continue;
            }

            if sheet_names.len() > 1 {
                result.push_str(&format!("## {}\n\n", sheet_name));
            }

            let mut rows: Vec<Vec<String>> = Vec::new();
            let mut max_cols = 0;

            for row in range.rows() {
                let cells: Vec<String> = row
                    .iter()
                    .map(|cell| match cell {
                        Data::Empty => String::new(),
                        Data::String(s) => s.clone(),
                        Data::Float(f) => {
                            if *f == (*f as i64) as f64 {
                                format!("{}", *f as i64)
                            } else {
                                format!("{:.2}", f)
                            }
                        }
                        Data::Int(i) => i.to_string(),
                        Data::Bool(b) => b.to_string(),
                        Data::DateTime(dt) => format!("{}", dt),
                        Data::DateTimeIso(s) => s.clone(),
                        Data::DurationIso(s) => s.clone(),
                        Data::Error(e) => format!("ERR:{:?}", e),
                    })
                    .collect();
                if cells.len() > max_cols {
                    max_cols = cells.len();
                }
                rows.push(cells);
            }

            // Skip empty sheets
            if rows.is_empty() || max_cols == 0 {
                continue;
            }

            for (i, row) in rows.iter().enumerate() {
                let mut padded = row.clone();
                padded.resize(max_cols, String::new());
                // Escape pipe characters in cell values
                let escaped: Vec<String> = padded.iter().map(|c| c.replace('|', "\\|")).collect();
                result.push_str("| ");
                result.push_str(&escaped.join(" | "));
                result.push_str(" |\n");

                if i == 0 {
                    result.push('|');
                    for _ in 0..max_cols {
                        result.push_str(" --- |");
                    }
                    result.push('\n');
                }
            }
            result.push('\n');
        }
    }

    if result.trim().is_empty() {
        Ok("[Could not extract data from spreadsheet]".to_string())
    } else {
        Ok(result)
    }
}

/// Extract OpenDocument format text (basic).
fn extract_odf_text(archive: &mut zip::ZipArchive<fs::File>) -> Result<String, String> {
    let xml = read_zip_file(archive, "content.xml")?;

    let mut result = String::new();
    let mut in_tag = false;

    for ch in xml.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => {
                in_tag = false;
                result.push(' ');
            }
            _ if !in_tag => result.push(ch),
            _ => {}
        }
    }

    let cleaned = decode_xml_entities(&result);
    let lines: Vec<&str> = cleaned
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .collect();

    if lines.is_empty() {
        Ok("[Could not extract text from this file]".to_string())
    } else {
        Ok(lines.join("\n\n"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn tmp_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "{}-{}",
            name,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    /// Creates a file of exactly `size` bytes without writing `size` bytes
    /// of real data — `set_len` punches a sparse hole, so this stays fast
    /// even at the 64MiB cap boundary tested below.
    fn tmp_sized_file(name: &str, size: u64) -> PathBuf {
        let path = tmp_path(name);
        let f = fs::File::create(&path).unwrap();
        f.set_len(size).unwrap();
        path
    }

    #[test]
    fn extract_docx_with_library_rejects_input_over_cap() {
        let path = tmp_sized_file("docx-over-cap.docx", MAX_DOCX_INPUT_BYTES + 1);
        let err = extract_docx_with_library(&path.to_string_lossy()).unwrap_err();
        assert!(
            err.contains("exceeding"),
            "expected a size-limit error, got: {err}"
        );
        let _ = fs::remove_file(&path);
    }

    /// The size gate must accept exactly-at-cap input — only later parsing
    /// (this sparse file isn't a real DOCX) should fail it.
    #[test]
    fn extract_docx_with_library_allows_input_at_exact_cap() {
        let path = tmp_sized_file("docx-at-cap.docx", MAX_DOCX_INPUT_BYTES);
        let err = extract_docx_with_library(&path.to_string_lossy()).unwrap_err();
        assert!(
            !err.contains("exceeding"),
            "size gate should not reject exact-cap input: {err}"
        );
        let _ = fs::remove_file(&path);
    }
}
