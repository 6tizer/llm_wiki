use std::fs;
use std::path::Path;

fn ensure_sidecar_resource_placeholder(path: &Path) {
    if path.exists() {
        return;
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("failed to create sidecar dist-bin directory");
    }
    fs::write(
        path,
        "Placeholder for Tauri resource validation.\nProduction builds overwrite this file with the compiled Agent sidecar binary.\n",
    )
    .expect("failed to write sidecar resource placeholder");
}

fn main() {
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").expect("missing CARGO_MANIFEST_DIR");
    let sidecar_dir = Path::new(&manifest_dir).join("sidecar").join("dist-bin");
    ensure_sidecar_resource_placeholder(&sidecar_dir.join("sidecar"));
    ensure_sidecar_resource_placeholder(&sidecar_dir.join("sidecar.exe"));

    let windows = tauri_build::WindowsAttributes::new()
        .app_manifest(include_str!("windows-app-manifest.xml"));
    let attrs = tauri_build::Attributes::new().windows_attributes(windows);
    tauri_build::try_build(attrs).expect("failed to run tauri build script");
}
